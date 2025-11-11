// server.js
'use strict';

/*
  Quiplash-like game server (prefab prompts)
  - Uses a long curated list of prefab prompts to avoid nonsensical generation
  - Appends a small set of optional extras occasionally for variety
  - Ensures prompts are not repeated within a single game
  - 60s submission and 60s voting timers
  - Broadcasts submission progress (playerSubmitted / allSubmissions)
  - Ends phases early if everyone submits or votes
  - In-memory state; restart clears state
*/

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_MESSAGE_SIZE = 64 * 1024;
const PING_INTERVAL_MS = 30_000;

const MAX_PLAYERS_PER_LOBBY = 8;
const ROUNDS_PER_GAME = 5;
const SUBMISSION_SECONDS = 60; // 1 minute submission
const VOTING_SECONDS = 60;     // 1 minute voting

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
      currentPrompt: null,
      usedPrompts: new Set(),
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
  room.usedPrompts = new Set();
  room.submissions = new Map();
  room.votes = new Map();
  clearTimers(room);
  for (const p of room.players.values()) { p.score = p.score || 0; p.ready = false; }
}

// --- Prefab prompts and extras ---
// Curated list of clear, playable prompts. Add or edit to match your group's humor.
const PREFAB_PROMPTS = [
  "The worst thing to say on a first date is ___",
  "My secret talent is ___",
  "The strangest thing I keep in my fridge is ___",
  "A terrible name for a perfume is ___",
  "If pets could talk they'd say ___",
  "The worst excuse to leave a party early is ___",
  "The most useless invention is ___",
  "The new reality show should be called ___",
  "The worst superpower is ___",
  "My autobiography would be titled ___",
  "The best excuse to miss work is ___",
  "A bad slogan for a hospital is ___",
  "The last thing I would bring to a desert island is ___",
  "The most awkward thing to say at a funeral is ___",
  "If I had a time machine I'd go to ___",
  "The worst job interview answer is ___",
  "A terrible theme for a children's book is ___",
  "The strangest hobby I secretly enjoy is ___",
  "The worst thing to shout in a crowded elevator is ___",
  "If I were invisible for a day I'd ___",
  "The most polite way to return a borrowed lawnmower is ___",
  "The illegal new flavor of potato chips is ___",
  "My cat’s secret five-year plan includes ___",
  "The best prank to play on your roommate is ___",
  "A cursed pizza topping is ___",
  "The worst thing to put on a resume is ___",
  "The most confusing reply to 'wyd?' is ___",
  "A terrible wedding toast line is ___",
  "The worst thing to say to your boss is ___",
  "The most awkward thing to find in your pockets is ___",
  "A bad name for a startup is ___",
  "The worst thing to whisper during a movie is ___",
  "The most ridiculous law would ban ___",
  "The worst mascot for a cereal is ___",
  "A terrible app idea is ___",
  "The worst thing to write on a cake is ___",
  "The most useless life hack is ___",
  "The worst thing to hear from your Uber driver is ___",
  "A bad theme for a children's party is ___",
  "The strangest thing to collect is ___",
  "The worst flavor for ice cream is ___",
  "A terrible slogan for a gym is ___",
  "The worst thing to say at a job interview is ___",
  "The most awkward thing to say on a first call is ___",
  "The worst thing to find in your sandwich is ___",
  "A cursed board game rule is ___",
  "The worst name for a pet is ___",
  "The most embarrassing ringtone is ___",
  "A bad idea for a reality show challenge is ___",
  "The worst thing to write in a birthday card is ___",
  "The most useless superpower is ___",
  "A terrible flavor for coffee is ___",
  "The worst thing to say at a graduation speech is ___",
  "A bad name for a perfume is ___",
  "The worst thing to announce on a bus is ___",
  "The most awkward thing to say to your neighbor is ___",
  "A terrible slogan for a bakery is ___",
  "The worst thing to find in a hotel room is ___",
  "A bad name for a children's toy is ___",
  "The worst thing to say during a toast is ___",
  "The most ridiculous holiday would celebrate ___",
  "A terrible name for a superhero is ___",
  "The worst thing to put on a pizza is ___",
  "A bad tagline for a dating app is ___",
  "The most awkward thing to say at a family dinner is ___",
  "A terrible name for a podcast is ___",
  "The worst thing to say to a teacher is ___",
  "A bad slogan for a dentist is ___",
  "The most useless invention for the kitchen is ___",
  "A terrible flavor for a soda is ___",
  "The worst thing to say during a job interview is ___",
  "A bad name for a fashion brand is ___",
  "The most awkward thing to find in your backpack is ___",
  "A terrible idea for a theme park ride is ___",
  "The worst thing to say on live TV is ___",
  "A bad name for a cocktail is ___",
  "The most ridiculous product to crowdfund is ___",
  "A terrible name for a band is ___",
  "The worst thing to text your boss is ___",
  "A bad slogan for a funeral home is ___",
  "The most awkward thing to say at a reunion is ___",
  "A terrible name for a baby is ___",
  "The worst thing to put on a resume is ___"
];

// Small set of safe extras to append occasionally for variety
const EXTRAS = [
  "— in 30 seconds or less",
  "— but only on Tuesdays",
  "— and nobody will notice",
  "— if you dare",
  "— while wearing a hat",
  "— with dramatic flair"
];

function randInt(max) { return Math.floor(Math.random() * max); }
function randItem(arr) { return arr[randInt(arr.length)]; }

// Generate a prompt for a room ensuring no repeats within a game
function pickPromptForRoom(room) {
  // Build a pool of unused prompts
  const unused = PREFAB_PROMPTS.filter(p => !room.usedPrompts.has(p));
  if (unused.length === 0) {
    // all used — reset usedPrompts but keep last prompt to avoid immediate repeat
    room.usedPrompts = new Set();
    // rebuild unused
    unused.push(...PREFAB_PROMPTS);
  }
  const choice = randItem(unused);
  room.usedPrompts.add(choice);
  // occasionally append a small extra for flavor (20% chance)
  if (Math.random() < 0.2) {
    return `${choice} ${randItem(EXTRAS)}`;
  }
  return choice;
}

// --- Game flow ---
function startGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.players.size === 0) {
    broadcast(roomId, { type: 'error', message: 'No players in room' });
    return;
  }

  room.roundIndex = 0;
  room.phase = 'submission';
  room.submissions = new Map();
  room.votes = new Map();
  room.usedPrompts = new Set();
  room.currentPrompt = pickPromptForRoom(room);

  for (const p of room.players.values()) p.score = 0;

  broadcast(roomId, {
    type: 'gameStarted',
    rounds: ROUNDS_PER_GAME,
    prompt: room.currentPrompt,
    seconds: SUBMISSION_SECONDS,
    playersCount: room.players.size
  });
  startSubmissionPhase(roomId);
}

function startSubmissionPhase(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.phase = 'submission';
  room.submissions = new Map();
  room.votes = new Map();

  // Ensure currentPrompt exists
  if (!room.currentPrompt) room.currentPrompt = pickPromptForRoom(room);

  broadcast(roomId, {
    type: 'roundStarted',
    round: room.roundIndex + 1,
    prompt: room.currentPrompt,
    phase: 'submission',
    seconds: SUBMISSION_SECONDS,
    totalPlayers: room.players.size
  });

  clearTimers(room);
  room.timers.submissionTimer = setTimeout(() => {
    endSubmissionPhase(roomId);
  }, SUBMISSION_SECONDS * 1000);
}

function endSubmissionPhase(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  // Fill blanks for non-submitters
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

  // Shuffle submissions
  for (let i = submissions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [submissions[i], submissions[j]] = [submissions[j], submissions[i]];
  }

  broadcast(roomId, {
    type: 'votingStarted',
    round: room.roundIndex + 1,
    submissions,
    seconds: VOTING_SECONDS
  });

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
    results.push({
      id: pid,
      name: p.name,
      score: p.score || 0,
      submission: room.submissions.get(pid) || '',
      votes: tally.get(pid) || 0
    });
  }
  results.sort((a,b) => (b.votes || 0) - (a.votes || 0));

  broadcast(roomId, { type: 'roundResults', round: room.roundIndex + 1, results });

  room.roundIndex++;
  if (room.roundIndex >= ROUNDS_PER_GAME) {
    endGame(roomId);
  } else {
    // pick a new prompt for the next round (no repeats within game)
    room.currentPrompt = pickPromptForRoom(room);
    setTimeout(() => { startSubmissionPhase(roomId); }, 3000);
  }
}

function endGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.phase = 'ended';

  const standings = [];
  for (const [pid, p] of room.players.entries()) {
    standings.push({ id: pid, name: p.name, score: p.score || 0 });
  }
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

        sendToPlayer(ws, {
          type: 'joined',
          id: playerId,
          room: roomId,
          hostId: room.hostId,
          players: snapshotPlayers(room),
          phase: room.phase
        });

        broadcast(roomId, { type: 'playerJoined', player: { id: playerId, name, ready: false, score: 0 } }, playerId);

        // If game already in progress, send current phase info
        if (room.phase === 'submission') {
          sendToPlayer(ws, {
            type: 'roundStarted',
            round: room.roundIndex + 1,
            prompt: room.currentPrompt,
            phase: 'submission',
            seconds: SUBMISSION_SECONDS,
            totalPlayers: room.players.size
          });
        } else if (room.phase === 'voting') {
          const submissions = [];
          for (const [pid, text] of room.submissions.entries()) submissions.push({ id: pid, text });
          sendToPlayer(ws, {
            type: 'votingStarted',
            round: room.roundIndex + 1,
            submissions,
            seconds: VOTING_SECONDS
          });
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

        // Broadcast submission progress to room
        broadcast(roomId, { type: 'playerSubmitted', id: playerId, count: room.submissions.size, total: room.players.size });

        // Ack to submitter
        sendToPlayer(ws, { type: 'submissionReceived', id: playerId });

        // If all submissions in, notify and end early
        if (room.submissions.size >= room.players.size) {
          broadcast(roomId, { type: 'allSubmissions', count: room.submissions.size, total: room.players.size });
          if (room.timers.submissionTimer) { clearTimeout(room.timers.submissionTimer); room.timers.submissionTimer = null; }
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
          if (room.timers.votingTimer) { clearTimeout(room.timers.votingTimer); room.timers.votingTimer = null; }
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
