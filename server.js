'use strict';

const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const { createDb } = require('./db');
const { createToken, verifyToken } = require('./auth');
const { createMatchmaker } = require('./matchmaker');

const db = createDb();
const PORT = process.env.PORT || 3000;

function sendPacket(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function _delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toJSON(obj) {
  try { return JSON.stringify(obj); } catch { return '{}'; }
}

function fromJSON(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const rawUsername = (req.body.username ?? '').toString().trim();
    const rawMmr = req.body.mmr;

    if (rawUsername.length < 2 || rawUsername.length > 32) {
      return res.status(400).json({ ok: false, error: 'Username must be 2–32 characters.' });
    }
    if (!/^[a-zA-Z0-9_\-]+$/.test(rawUsername)) {
      return res.status(400).json({ ok: false, error: 'Username contains invalid characters.' });
    }

    const mmr = Number.isFinite(Number(rawMmr)) ? Number(rawMmr) : 1000;
    const player = await db.findOrCreate(rawUsername, mmr);
    db.setStatusAtomic(player.id, player.status, 'lobby');
    const token = createToken(player);

    return res.status(200).json({
      ok: true,
      token,
      player: { id: player.id, username: player.username, mmr: player.mmr, status: player.status },
    });
  } catch (err) {
    console.error('[AUTH]  Login handler error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
});

app.get('/api/players/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const raw = await db.leaderboard(limit);

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.write('[');
    for (let i = 0; i < raw.length; i++) {
      const { id, username, mmr, status } = raw[i];
      res.write(toJSON({ rank: i + 1, id, username, mmr, status }));
      if (i < raw.length - 1) res.write(',');
      await _delay(2);
    }
    res.write(']');
    res.end();
  } catch (err) {
    console.error('[LEADERBOARD]  Error:', err);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    players: db.playerCount(),
    queueSize: db.getQueueSize(),
    activeSockets: wss ? wss.clients.size : 0,
    chatMessages: db.getChatLogs(500).length,
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
});

app.get('/api/chat/logs', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json({ ok: true, logs: db.getChatLogs(limit) });
});

const server = http.createServer(app);

const wss = new WebSocketServer({
  server,
  verifyClient: (info, cb) => {
    const url = new URL(info.req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (!token) {
      cb(false, 401, 'Unauthorized: token required');
      return;
    }
    const payload = verifyToken(token);
    if (!payload) {
      cb(false, 401, 'Unauthorized: invalid or expired token');
      return;
    }
    const player = db.resolveSession(payload.sub);
    if (!player) {
      cb(false, 401, 'Unauthorized: player not found');
      return;
    }
    info.req._player = player;
    info.req._token = token;
    cb(true);
  },
});

const matchmaker = createMatchmaker(db, wss);

const HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_MISSED_PINGS = 2;

const heartbeatTimer = setInterval(async () => {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;

    if (!ws._isAlive) {
      ws._missedPings = (ws._missedPings ?? 0) + 1;
      if (ws._missedPings >= MAX_MISSED_PINGS) {
        await _handleDisconnect(ws);
        ws.terminate();
        continue;
      }
    }

    ws._isAlive = false;
    ws._missedPings = ws._missedPings ?? 0;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

heartbeatTimer.unref();

wss.on('connection', (ws, req) => {
  const player = req._player;

  ws._playerId = player.id;
  ws._username = player.username;
  ws._isAlive = true;
  ws._missedPings = 0;

  db.cancelGracePeriod(player.id);

  if (player.status === 'reconnecting') {
    const priorStatus = player._priorStatus || 'lobby';
    db.setStatusAtomic(player.id, 'reconnecting', priorStatus);
  } else if (player.status !== 'restricted' && player.status !== 'banned') {
    db.setStatusAtomic(player.id, player.status, 'lobby');
  }

  matchmaker.registerSocket(player.id, ws);

  const fresh = db.getById(player.id);
  sendPacket(ws, {
    event: 'LOBBY_JOINED',
    message: `Welcome to the lobby, ${player.username}!`,
    player: { id: fresh.id, username: fresh.username, mmr: fresh.mmr, status: fresh.status },
  });

  ws.on('pong', () => {
    ws._isAlive = true;
    ws._missedPings = 0;
  });

  ws.on('message', async (rawData) => {
    const packet = fromJSON(rawData.toString());
    if (!packet || typeof packet.action !== 'string') {
      sendPacket(ws, { event: 'ERROR', message: 'Malformed packet.' });
      return;
    }

    const { action } = packet;

    switch (action) {

      case 'ENTER_QUEUE': {
        const player = _requireAuth(ws);
        if (!player) return;

        if (player.status === 'restricted' || player.status === 'banned') {
          sendPacket(ws, {
            event: 'QUEUE_BLOCKED',
            message: `Queue access is ${player.status}. Chat violations prevent matchmaking.`,
          });
          return;
        }
        if (player.status === 'queue') {
          sendPacket(ws, { event: 'NOTICE', message: 'You are already in queue.' });
          return;
        }
        if (player.status === 'ingame') {
          sendPacket(ws, { event: 'NOTICE', message: 'You are already in a match.' });
          return;
        }

        db.setStatusAtomic(player.id, 'lobby', 'queue');
        sendPacket(ws, {
          event: 'QUEUE_ENTERED',
          message: 'You have entered the matchmaking queue.',
          queueSize: db.getQueueSize(),
        });
        break;
      }

      case 'LEAVE_QUEUE': {
        const player = _requireAuth(ws);
        if (!player) return;

        if (player.status !== 'queue') {
          sendPacket(ws, { event: 'NOTICE', message: 'You are not currently in queue.' });
          return;
        }

        db.setStatusAtomic(player.id, 'queue', 'lobby');
        sendPacket(ws, { event: 'QUEUE_LEFT', message: 'You have left the queue.' });
        break;
      }

      case 'SEND_MESSAGE': {
        const player = _requireAuth(ws);
        if (!player) return;

        const rawMessage = (packet.message ?? '').toString().trim();

        if (rawMessage.length === 0) {
          sendPacket(ws, { event: 'ERROR', message: 'Message cannot be empty.' });
          return;
        }
        if (rawMessage.length > 300) {
          sendPacket(ws, { event: 'ERROR', message: 'Message exceeds 300-character limit.' });
          return;
        }

        if (player.status === 'restricted' || player.status === 'banned') {
          sendPacket(ws, {
            event: 'SYSTEM_WARNING',
            message: 'You are restricted from sending chat messages due to prior violations.',
          });
          return;
        }

        const analysis = await _analyzeMessage(rawMessage);

        const logEntry = {
          id: uuidv4(),
          playerId: player.id,
          username: player.username,
          message: rawMessage,
          violationScore: analysis.violationScore,
          flagged: analysis.flagged,
          triggeredTerms: analysis.triggeredTerms,
          timestamp: Date.now(),
        };
        db.appendChatLog(logEntry);

        if (analysis.flagged) {
          db.recordViolation(player.id, analysis.violationScore);

          const p = db.getById(player.id);
          const newStatus = p.violationCount >= 3 ? 'banned' : 'restricted';

          if (player.status === 'queue') {
            db.setStatusAtomic(player.id, 'queue', newStatus);
          } else {
            db.setStatusAtomic(player.id, player.status, newStatus);
          }

          sendPacket(ws, {
            event: 'SYSTEM_WARNING',
            message: 'Chat violation detected. Your queue access is temporarily restricted.',
            violationScore: analysis.violationScore,
            triggeredTerms: analysis.triggeredTerms,
            categories: analysis.categories,
            newStatus,
            processingMs: analysis.processingMs,
          });

          _broadcastAll({
            event: 'MODERATION_ACTION',
            message: `[SYSTEM] Player "${player.username}" has been ${newStatus} for chat violations.`,
            username: player.username,
            newStatus,
          }, ws);

          return;
        }

        const chatPayload = {
          event: 'LOBBY_CHAT',
          messageId: logEntry.id,
          username: player.username,
          message: rawMessage,
          timestamp: logEntry.timestamp,
          processingMs: analysis.processingMs,
        };

        sendPacket(ws, chatPayload);
        _broadcastAll(chatPayload, ws);
        break;
      }

      default: {
        sendPacket(ws, { event: 'ERROR', message: `Unknown action: "${action}".` });
      }
    }
  });

  ws.on('close', async (code, reason) => {
    await _handleDisconnect(ws);
  });

  ws.on('error', (err) => {
    console.error(`[WS]  ERROR   player="${ws._username ?? 'unknown'}"  ${err.message}`);
  });
});

async function _handleDisconnect(ws) {
  const playerId = ws._playerId;
  if (!playerId) return;

  matchmaker.registerSocket(playerId, null);

  const player = db.getById(playerId);
  if (!player) return;

  if (player.status === 'restricted' || player.status === 'banned') return;

  if (player.status === 'queue' || player.status === 'ingame') {
    const ok = db.setStatusAtomic(playerId, player.status, 'reconnecting');
    if (ok) {
      db.startGracePeriod(playerId);
    }
    return;
  }

  if (player.status === 'lobby') {
    db.setStatusAtomic(playerId, 'lobby', 'offline');
  }
}

function _requireAuth(ws) {
  if (!ws._playerId) return null;
  const player = db.getById(ws._playerId);
  return player ?? null;
}

function _broadcastAll(payload, excludeWs = null) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (
      client.readyState === WebSocket.OPEN &&
      client._playerId !== null &&
      client !== excludeWs
    ) {
      client.send(data);
    }
  }
}

const TOXIC_REGISTRY = [
  { pattern: /\bcheat(s|ing|er|ers)?\b/i, score: 100, category: 'CHEAT_ACCUSATION' },
  { pattern: /\bhack(s|ing|er|ers)?\b/i, score: 100, category: 'HACK_ACCUSATION' },
  { pattern: /\baimbot(s)?\b/i, score: 100, category: 'CHEAT_TOOL' },
  { pattern: /\bexploit(s|ing|ed)?\b/i, score: 100, category: 'EXPLOIT_ABUSE' },
  { pattern: /\bwallhack(s)?\b/i, score: 100, category: 'CHEAT_TOOL' },
  { pattern: /\bspeedhack(s)?\b/i, score: 100, category: 'CHEAT_TOOL' },
  { pattern: /\btriggerbot(s)?\b/i, score: 100, category: 'CHEAT_TOOL' },
  { pattern: /\bduplication glitch\b/i, score: 100, category: 'EXPLOIT_ABUSE' },
  { pattern: /\bddos(ing)?\b/i, score: 100, category: 'ATTACK_THREAT' },
  { pattern: /\bip.?grab(ber)?\b/i, score: 100, category: 'ATTACK_THREAT' },
  { pattern: /\btoxic\b/i, score: 80, category: 'TOXIC_BEHAVIOUR' },
  { pattern: /\bragehack\b/i, score: 80, category: 'TOXIC_BEHAVIOUR' },
  { pattern: /\bintentional.?feed(ing)?\b/i, score: 80, category: 'GRIEFING' },
  { pattern: /\bgrief(ing|er|ers)?\b/i, score: 80, category: 'GRIEFING' },
  { pattern: /\btroll(ing|er|ers)?\b/i, score: 60, category: 'DISRUPTIVE' },
  { pattern: /\bscript.?kiddi(e|es)?\b/i, score: 60, category: 'CHEAT_REFERENCE' },
  { pattern: /\bmod.?menu\b/i, score: 60, category: 'CHEAT_REFERENCE' },
  { pattern: /\bno.?recoil\b/i, score: 60, category: 'CHEAT_REFERENCE' },
  { pattern: /\bauto.?aim\b/i, score: 60, category: 'CHEAT_REFERENCE' },
  { pattern: /\bstompk(ing)?\b/i, score: 40, category: 'POOR_SPORTSMANSHIP' },
  { pattern: /\bnoob.?stomp(ing)?\b/i, score: 40, category: 'POOR_SPORTSMANSHIP' },
];

const VIOLATION_THRESHOLD = 40;

async function _analyzeMessage(message) {
  const pipelineStart = Date.now();

  const normalised = message
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  await _delay(10 + Math.random() * 15);

  let maxScore = 0;
  const matchedTerms = [];
  const categories = [];

  for (const entry of TOXIC_REGISTRY) {
    const match = normalised.match(entry.pattern);
    if (match) {
      matchedTerms.push(match[0]);
      if (!categories.includes(entry.category)) categories.push(entry.category);
      if (entry.score > maxScore) maxScore = entry.score;
    }
  }

  await _delay(8 + Math.random() * 12);

  let finalScore = maxScore;
  if (categories.length > 1 && finalScore < 100) {
    finalScore = Math.min(100, finalScore + categories.length * 5);
  }

  await _delay(12 + Math.random() * 20);

  const flagged = finalScore >= VIOLATION_THRESHOLD;
  const processingMs = Date.now() - pipelineStart;

  return { flagged, violationScore: finalScore, triggeredTerms: matchedTerms, categories, processingMs };
}

db.seed();
db.startCleanupLoop();
matchmaker.start();

server.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log(`║  NTE Matchmaker Core — listening on port ${PORT}         ║`);
  console.log('║  Dashboard  →  http://localhost:3000                 ║');
  console.log('║  Health     →  http://localhost:3000/api/health      ║');
  console.log('║  WS         →  ws://localhost:3000?token=<jwt>      ║');
  console.log('╚══════════════════════════════════════════════════════╝');
});

async function shutdown(signal) {
  console.log(`\n[SERVER]  ${signal} received — shutting down gracefully…`);
  clearInterval(heartbeatTimer);
  matchmaker.stop();
  db.stopCleanupLoop();
  for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
  wss.close(() => {
    server.close(() => {
      console.log('[SERVER]  HTTP server closed. Goodbye.');
      process.exit(0);
    });
  });
  setTimeout(() => { console.error('[SERVER]  Forced exit after timeout.'); process.exit(1); }, 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', err => console.error('[UNCAUGHT]', err));
process.on('unhandledRejection', (r) => console.error('[UNHANDLED]', r));
