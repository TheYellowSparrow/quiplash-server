// server.js
'use strict';

/*
  Quiplash-like game server
  - Goofier prefab prompts + occasional silly extras
  - 60s submission and 60s voting timers
  - Broadcasts submission progress (playerSubmitted / allSubmissions)
  - Ends phases early if everyone submits or votes
  - Prevents voting for your own answer (server-side)
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

// --- Goofier prefab prompts and extras ---
const PREFAB_PROMPTS = [
  "The worst mascot for a breakfast cereal is ___",
  "My cat's secret side hustle is ___",
  "A cursed pizza topping that somehow exists is ___",
  "The worst thing to whisper during a wedding kiss is ___",
  "The new Olympic sport everyone would lose at is ___",
  "A terrible name for a superhero is ___",
  "The most useless app feature is ___",
  "The weirdest thing to find in a vending machine is ___",
  "A bad slogan for a haunted house is ___",
  "The worst flavor for ice cream is ___",
  "The most embarrassing ringtone to have is ___",
  "The worst thing to say to a barista is ___",
  "A ridiculous law that would definitely exist is ___",
  "The worst thing to put on a resume is ___",
  "A terrible name for a pet is ___",
  "The most awkward thing to shout on a roller coaster is ___",
  "A cursed board game rule is ___",
  "The worst thing to write on a cake is ___",
  "A bad name for a startup is ___",
  "The most useless superpower is ___",
  "The worst thing to find in your pockets is ___",
  "A terrible idea for a reality show is ___",
  "The worst thing to say on a first date is ___",
  "A bad name for a perfume is ___",
  "The most ridiculous holiday would celebrate ___",
  "The worst thing to announce on a bus is ___",
  "A terrible slogan for a gym is ___",
  "The worst thing to whisper in a library is ___",
  "A cursed flavor of potato chips is ___",
  "The worst thing to text your boss is ___",
  "A bad name for a children's toy is ___",
  "The most awkward thing to say at a funeral is ___",
  "A terrible name for a band is ___",
  "The worst thing to say during a job interview is ___",
  "A ridiculous product to crowdfund is ___",
  "The worst thing to find in a hotel room is ___",
  "A bad tagline for a dating app is ___",
  "The most awkward thing to say at a family dinner is ___",
  "A terrible name for a podcast is ___",
  "The worst thing to put on a pizza is ___",
  "A cursed vending machine item is ___",
  "The worst thing to write in a birthday card is ___",
  "A bad name for a cocktail is ___",
  "The most awkward thing to say on live TV is ___",
  "A terrible theme for a children's party is ___",
  "The worst thing to shout in a crowded elevator is ___",
  "A bad name for a fashion brand is ___",
  "The most embarrassing thing to have as your screensaver is ___",
  "A terrible name for a baby is ___",
  "The worst thing to say to your neighbor is ___",
  "A cursed breakfast cereal prize is ___",
  "The worst thing to find in your sandwich is ___",
  "A bad name for a museum exhibit is ___",
  "The most ridiculous thing to put on a business card is ___",
  "A terrible flavor for coffee is ___",
  "The worst thing to say at a graduation speech is ___",
  "A bad slogan for a dentist is ___",
  "The most useless invention for the kitchen is ___",
  "A terrible name for a superhero sidekick is ___",
  "The worst thing to hear from your Uber driver is ___",
  "A cursed emoji that ruins conversations is ___",
  "The worst thing to say while giving a toast is ___",
  "A bad name for a board game is ___",
  "The most awkward thing to find in your backpack is ___",
  "A terrible idea for a theme park ride is ___",
  "The worst thing to say on a conference call is ___",
  "A bad name for a bakery is ___",
  "The most ridiculous thing to sell at a yard sale is ___",
  "A cursed app notification that never stops is ___",
  "The worst thing to put on a wedding invitation is ___",
  "A bad name for a superhero team is ___",
  "The most awkward thing to say to your teacher is ___",
  "A terrible flavor for a soda is ___",
  "The worst thing to find in a fridge is ___",
  "A bad name for a pet grooming salon is ___",
  "The most ridiculous thing to be famous for is ___",
  "A cursed souvenir from a vacation is ___",
  "The worst thing to say while ordering food is ___"
];

const EXTRAS = [
  "— while wearing a tutu",
  "— but only on Tuesdays",
  "— and you must sing it",
  "— with dramatic hand gestures",
  "— while hopping on one foot",
  "— and whisper it like a secret"
];

function randInt(max) { return Math.floor(Math.random() * max); }
function randItem(arr) { return arr[randInt(arr.length)]; }

// Generate a prompt for a room ensuring no repeats within a single game
function pickPromptForRoom(room) {
  const unused = PREFAB_PROMPTS.filter(p => !room.usedPrompts.has(p));
  if (unused.length === 0) {
    room.usedPrompts = new Set();
    unused.push(...PREFAB_PROMPTS);
  }
  const choice = randItem(unused);
  room.usedPrompts.add(choice);
  if (Math.random() < 0.25) { // slightly higher chance for goofiness
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
        // Prevent voting for your own answer
        if (votedId === playerId) {
          sendToPlayer(ws, { type: 'error', message: 'You cannot vote for your own answer' });
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
