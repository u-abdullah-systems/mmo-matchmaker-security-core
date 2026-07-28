'use strict';

const { v4: uuidv4 } = require('uuid');

const MATCH_SIZE = 4;
const TICK_MS = 2_000;

function createMatchmaker(db, wss) {
  let timer = null;
  const socketIndex = new Map();

  function registerSocket(playerId, ws) {
    if (ws) {
      socketIndex.set(playerId, ws);
    } else {
      socketIndex.delete(playerId);
    }
  }

  function _deliver(playerId, payload) {
    const ws = socketIndex.get(playerId);
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function _tick() {
    const queue = db.getQueue();
    if (queue.length < MATCH_SIZE) return;

    let i = 0;
    while (i + MATCH_SIZE <= queue.length) {
      const group = queue.slice(i, i + MATCH_SIZE);
      const playerIds = group.map(p => p.id);

      const claimed = db.tryClaimGroup(playerIds, 'queue', 'ingame');
      if (!claimed) {
        i++;
        continue;
      }

      const matchId = `MATCH_${uuidv4()}`;
      const avgMmr = Math.round(group.reduce((s, p) => s + p.mmr, 0) / MATCH_SIZE);

      console.log(
        `[MATCHMAKER]  MATCH_FOUND  id=${matchId}  ` +
        `players=[${group.map(p => p.username).join(', ')}]  avgMmr=${avgMmr}`
      );

      const payload = {
        event: 'MATCH_FOUND',
        matchId,
        players: group.map(p => ({ id: p.id, username: p.username, mmr: p.mmr })),
        avgMmr,
        message: `Match found! Game ID: ${matchId}`,
      };

      for (const id of playerIds) {
        _deliver(id, payload);
      }

      i += MATCH_SIZE;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(_tick, TICK_MS);
    timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, registerSocket };
}

module.exports = { createMatchmaker };
