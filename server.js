// server.js
'use strict';

/*
  Quiplash-like game server (updated full script)
  - Fresh randomized prompt every round (no reused fixed list)
  - Optional OpenAI fallback for prompts via OPENAI_API_KEY
  - 60s submission and 60s voting timers (reset between phases)
  - Broadcasts submission progress (playerSubmitted / allSubmissions)
  - Ends phases early if everyone submits or votes
  - In-memory state; restart clears state
*/

const http = require('http');
const WebSocket = require('ws');

// If running on Node < 18, provide fetch via node-fetch dynamically
const fetch = global.fetch || ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

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
  clearTimers(room);
  for (const p of room.players.values()) { p.score = p.score || 0; p.ready = false; }
}

// ===== Funny prompt generator (local, per-round randomized) =====
const PROMPT_THEMES = {
  everyday: [
    "The illegal new flavor of potato chips is ___",
    "My cat’s secret 5-year plan includes ___",
    "A mysterious item always found in my pockets is ___",
    "The most polite way to return a borrowed lawnmower is ___",
    "My most chaotic alarm sound would be ___",
    "The last thing I’d delete from my phone is ___",
  ],
  dating: [
    "The fastest way to end a first date is ___",
    "A cursed engagement ring feature is ___",
    "My red flag disguised as a fun fact is ___",
    "The line that gets you banned from wedding toasts is ___",
    "The most confusing reply to “wyd?” is ___",
  ],
  work: [
    "The worst email sign-off is ___",
    "The most cursed Zoom background is ___",
    "Detention for doing ___",
    "A dystopian new company motto is ___",
    "The weirdest extra credit assignment is ___",
  ],
  inventions: [
    "The app that exists only to ___",
    "Teleportation works perfectly, but you always arrive ___",
    "A vending machine that dispenses ___ when you press “Surprise”",
    "A magic mirror that roasts you for ___",
    "Flying shoes that only lift you when ___",
  ],
  pop: [
    "The franchise that should never be rebooted as ___",
    "Contestants compete by ___ in a new reality show",
    "A superhero’s useless power is ___",
    "The post-credits reveal is ___",
    "The challenge everyone regrets is ___",
  ],
  food: [
    "Cursed pizza topped with ___ and regret",
    "Earn a Michelin star by serving ___",
    "Soup becomes interesting when ___",
    "You’re banned from the buffet after piling ___",
    "Ask for the secret menu item ___ and they nod silently",
  ],
  life: [
    "You wake up with the ability to ___",
    "A tiny inconvenience that ruins the week is ___",
    "We celebrate ___ by doing ___",
    "The brag that only impresses three people is ___",
    "Genie grants your wish but adds ___",
  ],
  time: [
    "A gladiator’s subtweet would say ___",
    "In 2099 we pay with ___",
    "1-star review for Earth: “___”",
    "The silly thing that ends civilization is ___",
    "Mars HOA fines you for ___",
  ],
};

const MODIFIERS = [
  "in a fantasy world",
  "during a blackout",
  "on a spaceship",
  "at a family reunion",
  "as a motivational quote",
  "as a product tagline",
  "on a reality show",
  "at a job interview",
  "in a horror movie",
  "as a children’s story"
];

const ADJECTIVES = [
  "absurd", "awkward", "unexpected", "hilarious",
  "dark", "silly", "surprising", "bizarre", "delightful", "ridiculous"
];

function randItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function spicePrompt(base) {
  if (Math.random() < 0.6) {
    const mod = randItem(MODIFIERS);
    if (base.includes("___")) base = base.replace("___", `${mod} ___`);
    else base = `${base} ${mod} ___`;
  }
  if (Math.random() < 0.3) {
    const adj = randItem(ADJECTIVES);
    base = `${adj.charAt(0).toUpperCase() + adj.slice(1)}: ${base}`;
  }
  if (Math.random() < 0.15) base = base.replace(/\?$/, "") + "...";
  return base;
}

function generatePromptSingle() {
  const themeKeys = Object.keys(PROMPT_THEMES);
  const theme = randItem(themeKeys);
  const base = randItem(PROMPT_THEMES[theme]);
  return spicePrompt(base);
}

// Optional: ask OpenAI for a fresh prompt (fallback to local if fails)
// Set OPENAI_API_KEY in your environment to enable
async function generatePromptAI() {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const prompt = `Give one original, funny party game prompt with a blank using "___".
Avoid profanity and slurs. Keep it under 120 characters.`;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You generate creative, safe party game prompts." },
          { role: "user", content: prompt }
        ],
        temperature: 0.9,
        max_tokens: 80,
      })
    });

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (text && text.includes("___")) return text;
    if (text) return text.replace(/\s*$/, " ___");
    return null;
  } catch {
    return null;
  }
}

// Wrapper that prefers AI if available, falls back to local
async function getFreshPrompt() {
  const ai = await generatePromptAI();
  return ai || generatePromptSingle();
}

// --- Game flow (async for prompt fetching) ---
async function startGame(roomId) {
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
  room.currentPrompt = await getFreshPrompt();

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

  // Ensure a prompt exists (async prefetch done in startGame/endVotingPhase)
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

async function endVotingPhase(roomId) {
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
    // Get a brand-new prompt for the next round
    getFreshPrompt().then((nextPrompt) => {
      room.currentPrompt = nextPrompt;
      setTimeout(() => { startSubmissionPhase(roomId); }, 3000);
    }).catch(() => {
      room.currentPrompt = generatePromptSingle();
      setTimeout(() => { startSubmissionPhase(roomId); }, 3000);
    });
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
