// server.js
'use strict';

/*
  Quiplash-like game server (updated)
  - Prompts are now randomized every round (no repeated fixed list)
  - Submission and voting timers are 60s
  - Broadcasts submission progress (playerSubmitted / allSubmissions)
  - In-memory state; restart clears state
*/

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_MESSAGE_SIZE = 64 * 1024;
const PING_INTERVAL_MS = 30_000;

const MAX_PLAYERS_PER_LOBBY = 8;
const ROUNDS_PER_GAME = 5;
const SUBMISSION_SECONDS = 60; // 1 minute
const VOTING_SECONDS = 60;     // 1 minute

// --- Utilities ---
const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const safeString = (v, fallback = '') => (typeof v === 'string' ? v.trim().slice(0, 500) : fallback);

// --- Server bootstrap ---
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Quiplash server OK');
});
const wss = new WebSocket.Server({ server, maxPayload: MAX_MESSAGE_SIZE });

// --- In-memory state ---
const rooms = new Map();

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      players: new Map(),
      hostId: null,
      phase: 'lobby',
      roundIndex: 0,
      // prompts are generated per-round now
      currentPrompt: null,
      submissions: new Map(),
      votes: new Map(),
      timers: {}
    });
  }
  return rooms.get(roomId);
}

function broadcast(roomId, payload, exceptId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const str = JSON.stringify(payload);
  for (const [pid, p] of Array.from(room.players.entries())) {
    if (pid === exceptId) continue;
    if (!p.ws || p.ws.readyState !== WebSocket.OPEN) {
      room.players.delete(pid);
      continue;
    }
    try { p.ws.send(str); } catch (e) { try { p.ws.terminate(); } catch {} room.players.delete(pid); }
  }
}

function sendToPlayer(ws, payload) {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); } catch (e) {}
}

function snapshotPlayers(room) {
  const arr = [];
  for (const [id, p] of room.players.entries()) {
    arr.push({ id, name: p.name, ready: !!p.ready, score: p.score || 0, joinedAt: p.joinedAt });
  }
  arr.sort((a,b) => a.joinedAt - b.joinedAt);
  return arr;
}

function pickHostIfNeeded(room) {
  if (!room.hostId) {
    const players = snapshotPlayers(room);
    if (players.length > 0) room.hostId = players[0].id;
  } else {
    if (!room.players.has(room.hostId)) {
      const players = snapshotPlayers(room);
      room.hostId = players.length ? players[0].id : null;
    }
  }
}

function resetGameState(room) {
  room.phase = 'lobby';
  room.roundIndex = 0;
  room.currentPrompt = null;
  room.submissions = new Map();
  room.votes = new Map();
  room.timers = {};
  for (const p of room.players.values()) { p.score = p.score || 0; p.ready = false; }
}

// --- Prompt generation (random each round) ---
function randInt(max) {
  return Math.floor(Math.random() * max);
}

const PROMPT_BASE = [
  "My secret talent is ___",
  "The worst thing to say on a first date is ___",
  "If I were invisible for a day I'd ___",
  "The new reality show should be called ___",
  "The worst superpower is ___",
  "My autobiography would be titled ___",
  "The strangest thing I keep in my fridge is ___",
  "The best excuse to leave a party early is ___",
  "The most useless invention is ___",
  "If pets could talk they'd say ___",
  "The worst advice I ever got was ___",
  "A terrible theme for a children's book is ___",
  "The last thing I would bring to a desert island is ___",
  "The most awkward thing to say at a funeral is ___",
  "If I had a time machine I'd go to ___",
  "The worst job interview answer is ___",
  "The strangest hobby I secretly enjoy is ___",
  "A bad name for a perfume would be ___",
  "The worst thing to shout in a crowded elevator is ___",
  "If I were a villain my catchphrase would be ___"
];

const PROMPT_MODIFIERS = [
  "for a reality show",
  "in a fantasy world",
  "on a first date",
  "at a job interview",
  "as a superhero",
  "in a horror movie",
  "as a product name",
  "as a children's story",
  "as a late-night ad",
  "as a motivational quote",
  "during a blackout",
  "on a spaceship",
  "at a family reunion",
  "in a cooking show",
  "as a board game title"
];

const PROMPT_ADJECTIVES = [
  "absurd",
  "awkward",
  "unexpected",
  "hilarious",
  "dark",
  "silly",
  "surprising",
  "bizarre",
  "delightful",
  "ridiculous"
];

function generatePromptSingle() {
  // pick a base
  const base = PROMPT_BASE[randInt(PROMPT_BASE.length)];
  // 50% chance to add a modifier
  let prompt = base;
  if (Math.random() < 0.6) {
    const mod = PROMPT_MODIFIERS[randInt(PROMPT_MODIFIERS.length)];
    // if base contains '___' keep it; otherwise append modifier before blank
    if (base.includes('___')) {
      // sometimes insert modifier before blank
      prompt = base.replace('___', `${mod} ___`);
    } else {
      prompt = `${base} ${mod} ___`;
    }
  }
  // 30% chance to prepend an adjective phrase
  if (Math.random() < 0.3) {
    const adj = PROMPT_ADJECTIVES[randInt(PROMPT_ADJECTIVES.length)];
    prompt = `${adj.charAt(0).toUpperCase() + adj.slice(1)}: ${prompt}`;
  }
  // small random punctuation tweak
  if (Math.random() < 0.15) prompt = prompt.replace(/\?$/, '') + '...';
  return prompt;
}

function generatePrompts(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(generatePromptSingle());
  return out;
}

// --- Game flow ---
function startGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.players.size === 0) {
    broadcast(roomId, { type: 'error', message: 'No players in room' });
    return;
  }

  // pick a fresh prompt for the first round
  room.roundIndex = 0;
  room.phase = 'submission';
  room.submissions = new Map();
  room.votes = new Map();
  room.currentPrompt = generatePromptSingle();

  for (const p of room.players.values()) p.score = 0;

  broadcast(roomId, { type: 'gameStarted', rounds: ROUNDS_PER_GAME, prompt: room.currentPrompt, seconds: SUBMISSION_SECONDS, playersCount: room.players.size });
  startSubmissionPhase(roomId);
}

function startSubmissionPhase(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.phase = 'submission';
  room.submissions = new Map();
  room.votes = new Map();
  // ensure currentPrompt exists (should be set by caller)
  if (!room.currentPrompt) room.currentPrompt = generatePromptSingle();
  broadcast(roomId, { type: 'roundStarted', round: room.roundIndex + 1, prompt: room.currentPrompt, phase: 'submission', seconds: SUBMISSION_SECONDS, totalPlayers: room.players.size });
  clearTimers(room);
  room.timers.submissionTimer = setTimeout(() => {
    endSubmissionPhase(roomId);
  }, SUBMISSION_SECONDS * 1000);
}

function endSubmissionPhase(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const pid of room.players.keys()) {
    if (!room.submissions.has(pid)) room.submissions.set(pid, '');
  }
  startVotingPhase(roomId);
}

function startVotingPhase(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.phase = 'voting';
  const submissions = [];
  for (const [pid, text] of room.submissions.entries()) submissions.push({ id: pid, text });
  // shuffle submissions
  for (let i = submissions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [submissions[i], submissions[j]] = [submissions[j], submissions[i]];
  }
  broadcast(roomId, { type: 'votingStarted', round: room.roundIndex + 1, submissions, seconds: VOTING_SECONDS });
  clearTimers(room);
  room.timers.votingTimer = setTimeout(() => {
    endVotingPhase(roomId);
  }, VOTING_SECONDS * 1000);
}

function endVotingPhase(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const tally = new Map();
  for (const voted of room.votes.values()) {
    if (!tally.has(voted)) tally.set(voted, 0);
    tally.set(voted, tally.get(voted) + 1);
  }
  for (const [targetId, count] of tally.entries()) {
    const player = room.players.get(targetId);
    if (player) player.score = (player.score || 0) + count;
  }
  const results = [];
  for (const [pid, p] of room.players.entries()) {
    results.push({ id: pid, name: p.name, score: p.score || 0, submission: room.submissions.get(pid) || '', votes: tally.get(pid) || 0 });
  }
  results.sort((a,b) => (b.votes || 0) - (a.votes || 0));
  broadcast(roomId, { type: 'roundResults', round: room.roundIndex + 1, results });
  room.roundIndex++;
  if (room.roundIndex >= ROUNDS_PER_GAME) {
    endGame(roomId);
  } else {
    // pick a new random prompt for the next round
    room.currentPrompt = generatePromptSingle();
    setTimeout(() => {
      startSubmissionPhase(roomId);
    }, 3000);
  }
}

function endGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.phase = 'ended';
  const standings = [];
  for (const [pid, p] of room.players.entries()) standings.push({ id: pid, name: p.name, score: p.score || 0 });
  standings.sort((a,b) => (b.score || 0) - (a.score || 0));
  broadcast(roomId, { type: 'gameOver', standings });
  setTimeout(() => {
    resetGameState(room);
    pickHostIfNeeded(room);
    broadcast(roomId, { type: 'lobby', players: snapshotPlayers(room), hostId: room.hostId });
  }, 5000);
}

function clearTimers(room) {
  if (!room || !room.timers) return;
  if (room.timers.submissionTimer) { clearTimeout(room.timers.submissionTimer); room.timers.submissionTimer = null; }
  if (room.timers.votingTimer) { clearTimeout(room.timers.votingTimer); room.timers.votingTimer = null; }
}

// --- WebSocket handling ---
wss.on('connection', (ws, req) => {
  const playerId = makeId();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  sendToPlayer(ws, { type: 'id', id: playerId });

  ws.on('message', (raw) => {
    const msg = safeParse(raw);
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'join': {
        const roomId = safeString(msg.room || 'lobby');
        const name = safeString(msg.name || ('Player-' + playerId.slice(-4)));
        const room = ensureRoom(roomId);

        if (room.players.size >= MAX_PLAYERS_PER_LOBBY) {
          sendToPlayer(ws, { type: 'error', message: 'Lobby full' });
          try { ws.close(); } catch {}
          return;
        }

        const joinedAt = Date.now();
        room.players.set(playerId, { id: playerId, name, ws, ready: false, joinedAt, score: 0 });
        pickHostIfNeeded(room);

        sendToPlayer(ws, { type: 'joined', id: playerId, room: roomId, hostId: room.hostId, players: snapshotPlayers(room), phase: room.phase });

        broadcast(roomId, { type: 'playerJoined', player: { id: playerId, name, ready: false, score: 0 } }, playerId);

        // if game already in progress, send current phase info
        if (room.phase === 'submission') {
          sendToPlayer(ws, { type: 'roundStarted', round: room.roundIndex + 1, prompt: room.currentPrompt, phase: 'submission', seconds: SUBMISSION_SECONDS, totalPlayers: room.players.size });
        } else if (room.phase === 'voting') {
          const submissions = [];
          for (const [pid, text] of room.submissions.entries()) submissions.push({ id: pid, text });
          sendToPlayer(ws, { type: 'votingStarted', round: room.roundIndex + 1, submissions, seconds: VOTING_SECONDS });
        }

        break;
      }

      case 'ready': {
        const roomId = safeString(msg.room || 'lobby');
        const room = rooms.get(roomId);
        if (!room) return;
        const p = room.players.get(playerId);
        if (!p) return;
        p.ready = true;
        broadcast(roomId, { type: 'playerReady', id: playerId });
        const allReady = Array.from(room.players.values()).length >= 1 && Array.from(room.players.values()).every(x => x.ready);
        if (allReady) {
          if (room.hostId && room.players.has(room.hostId)) {
            const host = room.players.get(room.hostId);
            sendToPlayer(host.ws, { type: 'allReady', message: 'All players ready. You can start the game.' });
          }
        }
        break;
      }

      case 'unready': {
        const roomId = safeString(msg.room || 'lobby');
        const room = rooms.get(roomId);
        if (!room) return;
        const p = room.players.get(playerId);
        if (!p) return;
        p.ready = false;
        broadcast(roomId, { type: 'playerUnready', id: playerId });
        break;
      }

      case 'startGame': {
        const roomId = safeString(msg.room || 'lobby');
        const room = rooms.get(roomId);
        if (!room) return;
        pickHostIfNeeded(room);
        if (room.hostId !== playerId) {
          sendToPlayer(ws, { type: 'error', message: 'Only host can start the game' });
          return;
        }
        startGame(roomId);
        break;
      }

      case 'submit': {
        const roomId = safeString(msg.room || 'lobby');
        const text = safeString(msg.text || '');
        const room = rooms.get(roomId);
        if (!room) return;
        if (room.phase !== 'submission') {
          sendToPlayer(ws, { type: 'error', message: 'Not accepting submissions now' });
          return;
        }
        room.submissions.set(playerId, text);

        // broadcast submission progress to room
        broadcast(roomId, { type: 'playerSubmitted', id: playerId, count: room.submissions.size, total: room.players.size });

        // ack to submitter
        sendToPlayer(ws, { type: 'submissionReceived', id: playerId });

        // if all submissions in, notify and end early
        if (room.submissions.size >= room.players.size) {
          broadcast(roomId, { type: 'allSubmissions', count: room.submissions.size, total: room.players.size });
          clearTimeout(room.timers.submissionTimer);
          endSubmissionPhase(roomId);
        }
        break;
      }

      case 'vote': {
        const roomId = safeString(msg.room || 'lobby');
        const votedId = safeString(msg.votedId || '');
        const room = rooms.get(roomId);
        if (!room) return;
        if (room.phase !== 'voting') {
          sendToPlayer(ws, { type: 'error', message: 'Not accepting votes now' });
          return;
        }
        if (!room.players.has(votedId)) {
          sendToPlayer(ws, { type: 'error', message: 'Invalid vote target' });
          return;
        }
        room.votes.set(playerId, votedId);
        sendToPlayer(ws, { type: 'voteReceived', from: playerId, voted: votedId });

        if (room.votes.size >= room.players.size) {
          clearTimeout(room.timers.votingTimer);
          endVotingPhase(roomId);
        }
        break;
      }

      case 'chat': {
        const roomId = safeString(msg.room || 'lobby');
        const text = safeString(msg.text || '');
        const room = rooms.get(roomId);
        if (!room) return;
        const name = (room.players.get(playerId) || {}).name || ('P-' + playerId.slice(-4));
        const mid = makeId();
        broadcast(roomId, { type: 'chat', id: playerId, name, text, mid });
        break;
      }

      case 'leave': {
        const roomId = safeString(msg.room || 'lobby');
        const room = rooms.get(roomId);
        if (!room) return;
        if (room.players.has(playerId)) {
          room.players.delete(playerId);
          broadcast(roomId, { type: 'playerLeft', id: playerId });
          pickHostIfNeeded(room);
          if (room.players.size === 0) {
            clearTimers(room);
            rooms.delete(roomId);
          }
        }
        break;
      }

      default:
        sendToPlayer(ws, { type: 'error', message: 'Unknown message type' });
    }
  });

  ws.on('close', () => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.players.has(playerId)) {
        room.players.delete(playerId);
        broadcast(roomId, { type: 'playerLeft', id: playerId });
        pickHostIfNeeded(room);
        if (room.players.size === 0) {
          clearTimers(room);
          rooms.delete(roomId);
        }
      }
    }
  });

  ws.on('error', () => {});
});

// ping/pong keepalive
const pingInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, PING_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`Quiplash server listening on ws://localhost:${PORT}`);
});

function shutdown() {
  clearInterval(pingInterval);
  for (const room of rooms.values()) clearTimers(room);
  try { wss.close(); } catch {}
  try { server.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
