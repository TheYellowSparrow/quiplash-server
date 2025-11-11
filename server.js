// server.js
'use strict';

/*
  Quiplash-like game server
  - WebSocket-based
  - Lobbies (max 8 players)
  - Ready/unready, host is first joiner
  - 5 rounds: submission -> voting -> results
  - Votes award points; final winner announced
  - Simple in-memory state (no DB). Restart clears state.
*/

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_MESSAGE_SIZE = 64 * 1024;
const PING_INTERVAL_MS = 30_000;
const STALE_CLIENT_MS = 120_000;

const MAX_PLAYERS_PER_LOBBY = 8;
const ROUNDS_PER_GAME = 5;
const SUBMISSION_SECONDS = 30;
const VOTING_SECONDS = 20;

// --- Utilities ---
const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const safeString = (v, fallback = '') => (typeof v === 'string' ? v.trim().slice(0, 500) : fallback);

// --- Server + WebSocket bootstrap ---
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Quiplash server OK');
});
const wss = new WebSocket.Server({ server, maxPayload: MAX_MESSAGE_SIZE });

// --- In-memory state ---
/*
rooms: Map<roomId, {
  id,
  players: Map<playerId, { id, name, ws, ready, joinedAt, score }>,
  hostId,
  phase: 'lobby'|'submission'|'voting'|'results'|'ended',
  roundIndex,
  prompts: [string],
  currentPrompt: string,
  submissions: Map<playerId, text>,
  votes: Map<voterId, votedPlayerId>,
  timers: { submissionTimer, votingTimer }
}>
*/
const rooms = new Map();

// --- Helpers ---
function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      players: new Map(),
      hostId: null,
      phase: 'lobby',
      roundIndex: 0,
      prompts: [], // can be seeded later
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
  // sort by joinedAt for deterministic host selection
  arr.sort((a,b) => a.joinedAt - b.joinedAt);
  return arr;
}

function pickHostIfNeeded(room) {
  if (!room.hostId) {
    const players = snapshotPlayers(room);
    if (players.length > 0) {
      room.hostId = players[0].id;
    }
  } else {
    // ensure host still present
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

// --- Game flow functions ---
function startGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  // require at least 2 players
  if (room.players.size < 2) {
    broadcast(roomId, { type: 'error', message: 'Need at least 2 players to start' });
    return;
  }
  // seed prompts if empty (placeholder prompts)
  if (!room.prompts || room.prompts.length < ROUNDS_PER_GAME) {
    room.prompts = generatePrompts(ROUNDS_PER_GAME);
  }
  room.roundIndex = 0;
  room.phase = 'submission';
  room.submissions = new Map();
  room.votes = new Map();
  room.currentPrompt = room.prompts[room.roundIndex];
  // reset scores if new game
  for (const p of room.players.values()) p.score = 0;
  broadcast(roomId, { type: 'gameStarted', rounds: ROUNDS_PER_GAME, prompt: room.currentPrompt });
  startSubmissionPhase(roomId);
}

function startSubmissionPhase(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.phase = 'submission';
  room.submissions = new Map();
  room.votes = new Map();
  broadcast(roomId, { type: 'roundStarted', round: room.roundIndex + 1, prompt: room.currentPrompt, phase: 'submission', seconds: SUBMISSION_SECONDS });
  // set timer
  clearTimers(room);
  room.timers.submissionTimer = setTimeout(() => {
    endSubmissionPhase(roomId);
  }, SUBMISSION_SECONDS * 1000);
}

function endSubmissionPhase(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  // ensure everyone who didn't submit gets empty string
  for (const pid of room.players.keys()) {
    if (!room.submissions.has(pid)) room.submissions.set(pid, ''); // blank submission
  }
  // move to voting
  startVotingPhase(roomId);
}

function startVotingPhase(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.phase = 'voting';
  // prepare voting payload: list of submissions (id, text)
  const submissions = [];
  for (const [pid, text] of room.submissions.entries()) {
    submissions.push({ id: pid, text });
  }
  // shuffle submissions so voters don't know who wrote what (simple Fisher-Yates)
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
  // tally votes: votes Map<voterId, votedPlayerId>
  const tally = new Map(); // targetId -> count
  for (const voted of room.votes.values()) {
    if (!tally.has(voted)) tally.set(voted, 0);
    tally.set(voted, tally.get(voted) + 1);
  }
  // award points: simple rule: each vote = 1 point
  for (const [targetId, count] of tally.entries()) {
    const player = room.players.get(targetId);
    if (player) player.score = (player.score || 0) + count;
  }
  // prepare results payload
  const results = [];
  for (const [pid, p] of room.players.entries()) {
    results.push({ id: pid, name: p.name, score: p.score || 0, submission: room.submissions.get(pid) || '', votes: tally.get(pid) || 0 });
  }
  // sort results by votes desc
  results.sort((a,b) => (b.votes || 0) - (a.votes || 0));
  broadcast(roomId, { type: 'roundResults', round: room.roundIndex + 1, results });
  // next round or end game
  room.roundIndex++;
  if (room.roundIndex >= ROUNDS_PER_GAME) {
    endGame(roomId);
  } else {
    // set next prompt and start next round after short delay
    room.currentPrompt = room.prompts[room.roundIndex];
    setTimeout(() => {
      startSubmissionPhase(roomId);
    }, 3000);
  }
}

function endGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.phase = 'ended';
  // compute final standings
  const standings = [];
  for (const [pid, p] of room.players.entries()) standings.push({ id: pid, name: p.name, score: p.score || 0 });
  standings.sort((a,b) => (b.score || 0) - (a.score || 0));
  broadcast(roomId, { type: 'gameOver', standings });
  // reset ready flags but keep scores if you want; here we keep scores and set phase to lobby after short delay
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

// simple prompt generator (placeholder)
function generatePrompts(n) {
  const base = [
    "My secret talent is ___",
    "The worst thing to say on a first date is ___",
    "If I were invisible for a day I'd ___",
    "The new reality show should be called ___",
    "The worst superpower is ___",
    "My autobiography would be titled ___",
    "The strangest thing I keep in my fridge is ___",
    "The best excuse to leave a party early is ___",
    "The most useless invention is ___",
    "If pets could talk they'd say ___"
  ];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(base[i % base.length]);
  }
  return out;
}

// --- Connection handling ---
wss.on('connection', (ws, req) => {
  const playerId = makeId();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // send assigned id immediately
  sendToPlayer(ws, { type: 'id', id: playerId });

  ws.on('message', (raw) => {
    const msg = safeParse(raw);
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'join': {
        // payload: { room, name }
        const roomId = safeString(msg.room || 'lobby');
        const name = safeString(msg.name || ('Player-' + playerId.slice(-4)));
        const room = ensureRoom(roomId);

        // enforce max players
        if (room.players.size >= MAX_PLAYERS_PER_LOBBY) {
          sendToPlayer(ws, { type: 'error', message: 'Lobby full' });
          try { ws.close(); } catch {}
          return;
        }

        // add player
        const joinedAt = Date.now();
        room.players.set(playerId, { id: playerId, name, ws, ready: false, joinedAt, score: 0 });
        pickHostIfNeeded(room);

        // send snapshot to new player
        sendToPlayer(ws, { type: 'joined', id: playerId, room: roomId, hostId: room.hostId, players: snapshotPlayers(room), phase: room.phase });

        // notify others
        broadcast(roomId, { type: 'playerJoined', player: { id: playerId, name, ready: false, score: 0 } }, playerId);

        // if game already in progress, send current phase info
        if (room.phase === 'submission') {
          sendToPlayer(ws, { type: 'roundStarted', round: room.roundIndex + 1, prompt: room.currentPrompt, phase: 'submission', seconds: SUBMISSION_SECONDS });
        } else if (room.phase === 'voting') {
          // send voting state (we'll send submissions anonymized)
          const submissions = [];
          for (const [pid, text] of room.submissions.entries()) submissions.push({ id: pid, text });
          sendToPlayer(ws, { type: 'votingStarted', round: room.roundIndex + 1, submissions, seconds: VOTING_SECONDS });
        }

        break;
      }

      case 'ready': {
        // payload: { room }
        const roomId = safeString(msg.room || 'lobby');
        const room = rooms.get(roomId);
        if (!room) return;
        const p = room.players.get(playerId);
        if (!p) return;
        p.ready = true;
        broadcast(roomId, { type: 'playerReady', id: playerId });
        // if everyone ready and host exists, host can start; optionally auto-start if you want:
        const allReady = Array.from(room.players.values()).length >= 2 && Array.from(room.players.values()).every(x => x.ready);
        if (allReady) {
          // notify host that game can be started
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
        // only host can start
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
        // payload: { room, text }
        const roomId = safeString(msg.room || 'lobby');
        const text = safeString(msg.text || '');
        const room = rooms.get(roomId);
        if (!room) return;
        if (room.phase !== 'submission') {
          sendToPlayer(ws, { type: 'error', message: 'Not accepting submissions now' });
          return;
        }
        // record submission
        room.submissions.set(playerId, text);
        sendToPlayer(ws, { type: 'submissionReceived', id: playerId });
        // optional: if all submissions in, end early
        if (room.submissions.size >= room.players.size) {
          clearTimeout(room.timers.submissionTimer);
          endSubmissionPhase(roomId);
        }
        break;
      }

      case 'vote': {
        // payload: { room, votedId }
        const roomId = safeString(msg.room || 'lobby');
        const votedId = safeString(msg.votedId || '');
        const room = rooms.get(roomId);
        if (!room) return;
        if (room.phase !== 'voting') {
          sendToPlayer(ws, { type: 'error', message: 'Not accepting votes now' });
          return;
        }
        // record vote (one vote per voter; overwrite allowed)
        if (!room.players.has(votedId)) {
          sendToPlayer(ws, { type: 'error', message: 'Invalid vote target' });
          return;
        }
        room.votes.set(playerId, votedId);
        sendToPlayer(ws, { type: 'voteReceived', from: playerId, voted: votedId });
        // optional: if all votes in, end early
        if (room.votes.size >= room.players.size) {
          clearTimeout(room.timers.votingTimer);
          endVotingPhase(roomId);
        }
        break;
      }

      case 'chat': {
        // simple chat broadcast in room
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
        // client requests leave
        const roomId = safeString(msg.room || 'lobby');
        const room = rooms.get(roomId);
        if (!room) return;
        if (room.players.has(playerId)) {
          room.players.delete(playerId);
          broadcast(roomId, { type: 'playerLeft', id: playerId });
          pickHostIfNeeded(room);
          // if no players left, delete room
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
    // remove player from any room they were in
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

  ws.on('error', () => {
    // ignore; close will handle cleanup
  });
});

// ping/pong keepalive and stale cleanup
const pingInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, PING_INTERVAL_MS);

// start server
server.listen(PORT, () => {
  console.log(`Quiplash server listening on ws://localhost:${PORT}`);
});

// graceful shutdown
function shutdown() {
  clearInterval(pingInterval);
  for (const room of rooms.values()) clearTimers(room);
  try { wss.close(); } catch {}
  try { server.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
