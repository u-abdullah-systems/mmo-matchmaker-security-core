# NTE Matchmaker Core

**Real-time headless matchmaking backend** for MMO and competitive multiplayer games. Features a WebSocket lobby with atomic state transitions, HS512 JWT authentication at the handshake level, and a simulated AI toxicity filter for chat moderation.

---

## Features

- **Atomic State Machine** — Check-and-set transitions prevent TOCTOU races between the matchmaker loop and player disconnect/reconnect
- **ActiveQueue (O(k log k))** — A dedicated queue data structure eliminates full-table O(n) scans; matchmaker only iterates queued players
- **30s Grace Period** — Disconnected players in queue or in-game enter a `reconnecting` state and can reclaim their position within 30 seconds
- **60-minute TTL Pruning** — Stale offline player records are evicted from memory to prevent monotonic heap growth
- **HS512 JWT Auth** — Real signed tokens with 24h expiry, verified at the WebSocket upgrade; unauthorized connections are rejected before the socket opens
- **AI Toxicity Filter** — Configurable keyword-based chat moderation pipeline with escalating penalties (warning → restricted → banned)
- **No External Dependencies** — All state lives in-process; no PostgreSQL, Redis, or MongoDB required for the MVP

---

## Quick Start

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) to access the tester panel.

```
Environment variables:
  PORT        — HTTP/WS server port (default 3000)
  JWT_SECRET  — 64-byte hex string for JWT signing (auto-generated if omitted)
```

---

## Architecture

```
┌─────────────┐     POST /api/auth/login     ┌────────────────────┐
│   Client    │ ───────────────────────────→  │   Express Gateway  │
│  (Browser)  │                                │  (REST + WebSocket)│
│             │ ◄── JWT ───────────────────── │                    │
│             │                                └───────┬────────────┘
│             │     ws://host:3000?token=<jwt>          │
│             │ ──────────────────────────────────────→  │
│             │                                ┌───────┴────────────┐
│             │                                │   State Machine   │
│             │                                │  (db.js)          │
│             │                                │  - Atomic status  │
│             │                                │  - ActiveQueue    │
│             │                                │  - Grace timers   │
│             │                                │  - TTL pruning    │
│             │                                └───────┬────────────┘
│             │                                ┌───────┴────────────┐
│             │                                │   Matchmaker      │
│             │                                │  (matchmaker.js)   │
│             │                                │  - O(k log k) /   │
│             │                                │    tick            │
│             │                                │  - Atomic claim    │
│             │                                └────────────────────┘
```

### State Machine

```
                         ┌──────────┐
          ┌──────────────│  OFFLINE  │◄──── TTL expiry ────┐
          │              └─────┬────┘                      │
          │  login             │                           │
          ▼                    ▼                           │
     ┌────────┐          ┌─────────┐                      │
     │ LOBBY  │◄─────────│ RESTRICTED                     │
     └───┬────┘          └─────────┘                      │
         │ enter queue              │                     │
         ▼                          ▼                     │
     ┌────────┐               ┌────────┐                  │
     │ QUEUE  │──────────────►│ BANNED │                  │
     └───┬────┘               └────────┘                  │
         │ disconnect              ▲                      │
         ▼                         3 violations           │
     ┌─────────────┐                                     │
     │ RECONNECTING│◄── reconnect ───┐                    │
     └──────┬──────┘                │                    │
            │ grace expires         │                    │
            ▼                        │                    │
         OFFLINE                    ──                    │
                                   (restore prior status) │
                                                          │
     ┌────────┐                                           │
     │ INGAME │──── disconnect ────► RECONNECTING ────────┘
     └────────┘
```

---

## API Reference

### `POST /api/auth/login`

Authenticate or register a player. Returns a JWT.

```json
{ "username": "NightBlade", "mmr": 2640 }
```

```json
{
  "ok": true,
  "token": "eyJhbGciOiJIUzUxMiIs...",
  "player": {
    "id": "uuid",
    "username": "NightBlade",
    "mmr": 2640,
    "status": "lobby"
  }
}
```

### `GET /api/health`

Server health and metrics.

```json
{
  "ok": true,
  "uptime": 3600,
  "players": 10,
  "queueSize": 3,
  "activeSockets": 5,
  "chatMessages": 42,
  "memoryMB": 12
}
```

### `GET /api/players/leaderboard?limit=10`

Streamed leaderboard sorted by MMR descending.

### `GET /api/chat/logs?limit=50`

Recent chat history with AI filter analysis.

---

## WebSocket Protocol

Connect with the JWT as a query parameter:

```
ws://localhost:3000?token=eyJhbGciOiJIUzUxMiIs...
```

### Client → Server Actions

| Action | Payload | Description |
|---|---|---|
| `ENTER_QUEUE` | `{}` | Join the matchmaking queue |
| `LEAVE_QUEUE` | `{}` | Leave the matchmaking queue |
| `SEND_MESSAGE` | `{ "message": "..." }` | Send a chat message (routed through AI filter) |

### Server → Client Events

| Event | Description |
|---|---|
| `LOBBY_JOINED` | Authentication successful; lobby state delivered |
| `QUEUE_ENTERED` | Player entered the queue; includes `queueSize` |
| `QUEUE_LEFT` | Player left the queue |
| `MATCH_FOUND` | Match assigned; includes `matchId`, `players`, `avgMmr` |
| `LOBBY_CHAT` | Chat message broadcast from another player |
| `SYSTEM_WARNING` | AI filter violation detected; includes `violationScore`, `newStatus` |
| `MODERATION_ACTION` | Another player was restricted/banned |
| `QUEUE_BLOCKED` | Player cannot queue due to restricted/banned status |
| `AUTH_FAIL` | Session invalid or expired |
| `ERROR` | Malformed packet or server error |

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP and WebSocket server port |
| `JWT_SECRET` | Auto-generated | 64-byte hex key for HS512 JWT signing (persist across restarts to keep tokens valid) |

---

## Project Status

**MVP / Demo.** This is a production-oriented prototype suitable for local development, load testing, and proof-of-concept deployments. The code is architected with clean separation of concerns (auth, state, matchmaker, gateway) to simplify the transition to an external database and horizontally-scaled microservices.

### Upgrade Path to Production

- Replace in-memory Maps with PostgreSQL / Redis + DynamoDB
- Shard the ActiveQueue across matchmaker worker processes via Redis sorted sets
- Replace the simulated AI filter with a real LLM classifier (Ollama / OpenAI / custom model)
- Add Prometheus metrics and structured logging
- Deploy behind a load balancer with TLS termination (`wss://`)
