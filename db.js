'use strict';

const { v4: uuidv4 } = require('uuid');

const ALLOWED_TRANSITIONS = Object.freeze({
  offline:      ['lobby'],
  lobby:        ['queue', 'offline'],
  queue:        ['lobby', 'ingame', 'reconnecting'],
  reconnecting: ['queue', 'offline', 'ingame'],
  ingame:       ['lobby', 'offline', 'reconnecting'],
  restricted:   ['lobby', 'offline'],
  banned:       ['offline'],
});

const OFFLINE_TTL_MS = 60 * 60 * 1000;
const GRACE_PERIOD_MS = 30_000;
const CHAT_LOG_MAX = 500;

function _isValidTransition(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed && allowed.includes(to);
}

function _delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createDb() {
  const byUsername = new Map();
  const byId = new Map();
  const chatLogs = [];
  const activeQueue = new Map();
  const graceTimers = new Map();

  let cleanupTimer = null;

  function _insert(username, mmr) {
    const player = {
      id: uuidv4(),
      username,
      mmr: Math.max(0, Math.min(9999, Math.round(mmr))),
      status: 'offline',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      violationScore: 0,
      violationCount: 0,
    };
    byUsername.set(username, player);
    byId.set(player.id, player);
    return player;
  }

  function seed() {
    const fixtures = [
      { username: 'ArenaKing', mmr: 2850 },
      { username: 'NightBlade', mmr: 2640 },
      { username: 'StormWarden', mmr: 2510 },
      { username: 'IronClad', mmr: 2390 },
      { username: 'VoidHunter', mmr: 2200 },
      { username: 'CryptoMage', mmr: 2100 },
      { username: 'LancerX', mmr: 1980 },
      { username: 'PhoenixRise', mmr: 1850 },
      { username: 'ShadowStep', mmr: 1720 },
      { username: 'FrostEdge', mmr: 1600 },
    ];
    fixtures.forEach(f => _insert(f.username, f.mmr));
  }

  async function findOrCreate(username, mmr = 1000) {
    await _delay(15);
    if (byUsername.has(username)) return byUsername.get(username);
    return _insert(username, mmr);
  }

  function getById(id) {
    return byId.get(id) ?? null;
  }

  function getByUsername(username) {
    return byUsername.get(username) ?? null;
  }

  function playerCount() {
    return byUsername.size;
  }

  function setStatusAtomic(playerId, expectedCurrent, newStatus) {
    const player = byId.get(playerId);
    if (!player) return false;
    if (expectedCurrent && player.status !== expectedCurrent) return false;
    if (!_isValidTransition(player.status, newStatus)) return false;

    const oldStatus = player.status;
    player.lastActivity = Date.now();

    if (newStatus === 'reconnecting' && oldStatus !== 'reconnecting') {
      player._priorStatus = oldStatus;
    } else if (oldStatus === 'reconnecting' && newStatus !== 'reconnecting') {
      delete player._priorStatus;
    }

    player.status = newStatus;

    if (newStatus === 'queue') {
      activeQueue.set(playerId, player);
    } else if (oldStatus === 'queue') {
      activeQueue.delete(playerId);
    }

    return true;
  }

  function tryClaimGroup(playerIds, fromStatus, toStatus) {
    const claimed = [];
    for (const id of playerIds) {
      const ok = setStatusAtomic(id, fromStatus, toStatus);
      if (ok) {
        claimed.push(id);
      } else {
        for (const cid of claimed) {
          setStatusAtomic(cid, toStatus, fromStatus);
        }
        return null;
      }
    }
    return claimed;
  }

  async function leaderboard(limit = 20) {
    await _delay(10);
    const rows = [...byUsername.values()]
      .sort((a, b) => b.mmr - a.mmr)
      .slice(0, Math.min(limit, 100));
    return rows;
  }

  function getQueue() {
    return [...activeQueue.values()].sort((a, b) => a.mmr - b.mmr);
  }

  function getQueueSize() {
    return activeQueue.size;
  }

  function resolveSession(playerId) {
    const player = byId.get(playerId);
    return player ?? null;
  }

  function recordViolation(playerId, score) {
    const p = byId.get(playerId);
    if (!p) return;
    p.violationScore += score;
    p.violationCount += 1;
  }

  function appendChatLog(entry) {
    chatLogs.push(entry);
    if (chatLogs.length > CHAT_LOG_MAX) chatLogs.shift();
  }

  function getChatLogs(limit = 50) {
    return chatLogs.slice(-Math.min(limit, CHAT_LOG_MAX));
  }

  function setStatusBatchAtomic(playerIds, fromStatus, toStatus) {
    return tryClaimGroup(playerIds, fromStatus, toStatus) !== null;
  }

  function startGracePeriod(playerId) {
    cancelGracePeriod(playerId);
    const timer = setTimeout(() => {
      if (!graceTimers.has(playerId)) return;
      graceTimers.delete(playerId);
      setStatusAtomic(playerId, 'reconnecting', 'offline');
    }, GRACE_PERIOD_MS);
    timer.unref();
    graceTimers.set(playerId, timer);
  }

  function cancelGracePeriod(playerId) {
    const timer = graceTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      graceTimers.delete(playerId);
    }
  }

  function isInGracePeriod(playerId) {
    return graceTimers.has(playerId);
  }

  function _pruneOnce() {
    const now = Date.now();
    const toRemove = [];
    for (const [id, player] of byId) {
      if (player.status !== 'offline') continue;
      if (now - player.lastActivity < OFFLINE_TTL_MS) continue;
      toRemove.push({ id, username: player.username });
    }
    for (const { id, username } of toRemove) {
      cancelGracePeriod(id);
      activeQueue.delete(id);
      byId.delete(id);
      byUsername.delete(username);
    }
    if (toRemove.length > 0) {
      console.log(`[DB]  Pruned ${toRemove.length} stale offline player(s)`);
    }
  }

  function startCleanupLoop() {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(_pruneOnce, 60_000);
    cleanupTimer.unref();
  }

  function stopCleanupLoop() {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }

  function cleanupNow() {
    _pruneOnce();
  }

  return {
    seed,
    findOrCreate,
    setStatusAtomic,
    setStatusBatchAtomic,
    tryClaimGroup,
    leaderboard,
    getQueue,
    getQueueSize,
    getById,
    getByUsername,
    playerCount,
    resolveSession,
    recordViolation,
    appendChatLog,
    getChatLogs,
    startGracePeriod,
    cancelGracePeriod,
    isInGracePeriod,
    startCleanupLoop,
    stopCleanupLoop,
    cleanupNow,
  };
}

module.exports = { createDb };
