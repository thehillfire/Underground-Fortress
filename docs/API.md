# API

Base `http://127.0.0.1:4321`. JSON in/out. Errors: HTTP 400 `{ "error": "..." }`. Live state via
WebSocket `/ws` (sends `{type:"state", state}` on connect and on changes; also `decision`, `bus`, `anomaly`).
Login is optional: until a passphrase is set (Deck -> Safety) there is none and the server only listens on
127.0.0.1. Once set, every `/api` call and the socket need the `fort_at` cookie (15 min, renewed by `fort_rt`).
Requests whose Host is not localhost, or cross-site writes, are refused. Inputs are validated (`server/schemas.js`);
errors: 400 `{error}`, 401 `{error, login:true}`, 429 rate limited.

## Implemented (server/index.js)

| Method | Path | Purpose |
|---|---|---|
| GET | /api/state | Full public state (connectors redacted) |
| GET | /api/health | mock, subscription, apiKeyStripped, lastCrash, uptime, node |
| POST | /api/projects | Create project |
| PATCH/DELETE | /api/projects/:id | Update / remove project |
| POST | /api/sessions | Create agent session |
| PATCH/DELETE | /api/sessions/:id | Update / remove |
| POST | /api/sessions/:id/message | Send text (+ files) |
| POST | /api/sessions/:id/stop | Stop current turn |
| POST | /api/sessions/:id/retry | Retry last turn |
| POST | /api/sessions/:id/permission | Answer a permission/money prompt |
| GET | /api/files/:owner/:name | Download an uploaded file |
| POST | /api/lidia | Talk to Lidia |
| POST | /api/react | Emoji reaction |
| PUT | /api/orders | Set standing orders |
| PATCH | /api/settings | Update settings |
| PUT | /api/plan | Update plan |
| GET | /api/models | Model list |
| POST | /api/client | Client info |
| GET | /api/system/version | Version info |
| POST | /api/system/update | Pull update |
| POST | /api/system/restart | Restart server |
| POST | /api/system/keep-alive | Termux keep-alive settings |
| POST | /api/notify-test | Test notification |
| POST | /api/schedules | Add scheduled job |
| DELETE | /api/schedules/:id | Remove job |
| POST | /api/usage/refresh | Refresh plan usage |
| POST | /api/repos | Connect repo |
| DELETE | /api/repos/:id | Disconnect repo |
| GET | /api/connectors/catalog | Connector catalog |
| GET | /api/connectors/search?q= | Search registry |
| POST | /api/connectors | Add connector |
| PATCH/DELETE | /api/connectors/:id | Update / remove |
| GET | /api/skills/find?q=&repo= | Find skills |
| POST | /api/skills/install | Install skill (repo, dir) |
| GET/POST | /api/skills/starter | List / install starter skills |
| DELETE | /api/skills/:dir | Uninstall skill |

## Autonomy, mesh and safety

| Path | Purpose |
|---|---|
| GET /api/intent | Intent model, standing directives, tier-1 digest |
| POST /api/directives, DELETE /api/directives/:id | Standing directives (money-authorizing text is refused) |
| GET /api/decisions?q=&tier=&agent= | Lidia's thought stream (every decision, with why) |
| GET /api/priorities, GET /api/escalations | Priority engine (0-100 bands) and INFO/WARN/BLOCK/CRITICAL queue |
| GET/POST /api/tasks, PATCH /api/tasks/:id | Task graph with dependencies and success criteria |
| GET/POST /api/bus, GET /api/anomalies | Signed message bus log (signature verified on read) |
| GET/POST /api/artifacts, GET /api/artifacts/:name?version= / ?a=&b= / ?history=1 | Versioned artifacts, diff |
| GET /api/memory | Memory counts per scope |
| GET /api/audit, GET /api/audit/verify | Hash-chained audit trail, filter and verify |
| POST /api/kill, POST /api/resume | Kill switch |
| GET /api/metrics | Prometheus text format |
| GET /api/export, POST /api/erase | Data export; erase (body `{confirm:"ERASE EVERYTHING"}`) |
| GET/POST /api/auth/* | status, setup, login, refresh, logout, disable |
| POST /api/projects/:id/archive, /restore; GET /api/archive | Room lifecycle |
