# Architecture

One Node 20 process (Express 5 + `ws`) serves the UI from `public/`, a REST API, and a WebSocket
at `/ws` that pushes the full state to the app. State is a single JSON file. Every agent is a
Claude Agent SDK session run with the user's subscription login.

```
Phone browser (public/) <-- REST + WS /ws --> server/index.js
                                                |-- sessions.js  dwellers (one SDK session each)
                                                |-- lidia.js     captain: reviews, chat, fortress tools
                                                |-- agent.js     SDK wrapper + mock runner (FORTRESS_MOCK=1)
                                                |-- guard.js     money gate (PreToolUse hook)
                                                |-- store.js     data/state.json, settings validation
```

## Modules (server/)

- `index.js` - routes, WebSocket broadcast, crash log (`data/crash.log`), Termux notifications.
- `store.js` - persistent state, `FORTRESS_DATA` override, settings keys and checks.
- `sessions.js` - create/update/send/stop/retry sessions, permission requests, peer review, Lidia relay.
- `lidia.js` - captain session whose only tools are fortress controls (SDK MCP server); model list.
- `agent.js` - wraps `query()`; strips `ANTHROPIC_API_KEY`; mock runner for offline demos.
- `guard.js` - `moneyCheck` / `moneyHooks`; cannot be overridden by settings or agents.
- `projects.js` - projects ("rooms") with a folder or connected repo, shared by their agents.
- `repos.js` - connect/disconnect git repositories as workspaces.
- `skills.js` - find/install/uninstall Claude skills from GitHub sources; starter set.
- `connectors.js` - app connector catalog, registry search, secret redaction, MCP server config.
- `schedule.js` - in-server alarm clock (jobs, timezone, catch-up after phone sleep).
- `usage.js` - plan usage (session/weekly) polling and reserve logic.
- `system.js` - fixed actions only: version, update, restart, Termux keep-alive/notify.
- `files.js`, `assets.js`, `reactions.js` - uploads (base64), art assets, emoji reactions.

## Data flow

1. Jav sends a message (`POST /api/sessions/:id/message` or `/api/lidia`).
2. `sessions.send` runs a turn through `agent.runTurn` with money hooks attached.
3. Events update `store.state`; `store.changed()` triggers a WS broadcast.
4. On turn end the agent reports to Lidia, who may nudge (up to `maxAutoTurns`) or escalate.

## Autonomy, mesh, safety (server/)

- `intent.js`: intent model, authority tiers 0-3 enforced server-side, standing directives, decision log, permission triage.
- `incidents.js`: crash diagnosis and automatic fixes, escalation after three tries. `priority.js`: priority engine and queues.
- `bus.js` (HMAC-signed, per-sender keys), `tasks.js`, `artifacts.js`, `memory.js` (hashed-vector search, private memory AES-256-GCM), `mesh.js` (the tools every agent gets).
- `audit.js` (hash chain), `crypto.js`, `auth.js` (passphrase, TOTP, JWT + rotating refresh), `hostguard.js`, `ratelimit.js`, `broker.js` (PreToolUse path jail and secret protection), `safety.js` (kill switch, untrusted-content wrapping), `schemas.js`, `metrics.js`.
- The money gate (`guard.js`) is unchanged and untouchable: tiers never approve money.
