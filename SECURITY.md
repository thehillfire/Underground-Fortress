# Security

Underground Fortress runs Claude Agent SDK sessions ("dwellers") on a phone (Termux), authenticated
with a Claude subscription. There are no API keys and no capability to spend money.

## Threat model (summary)

| Threat | Mitigation |
|---|---|
| Prompt injection (web pages, files, repos, tool output steer an agent) | Agents run in per-project workspaces; permission mode is a setting (default `acceptEdits`); dangerous actions surface as permission prompts to the owner; money gate applies in every mode. |
| Agent impersonation (one agent posing as Jav or Lidia) | Message origin (`by`) is set server-side from the route, never from agent-supplied text; only the REST caller is `jav`. Agent-to-agent messages are HMAC-signed with per-sender keys and verified on read; every action lands in a hash-chained audit log (`/api/audit`). |
| Secret leakage | No secrets in repo (gitleaks in CI, `.gitleaks.toml`); `.env`, `data/`, `workspaces/` git-ignored; connector secrets redacted in `/api/state`; server binds to `127.0.0.1` by default. |
| Runaway spend | Hard-coded money gate in `server/guard.js`: a PreToolUse hook on every tool call of every agent (and Lidia) freezes finance services, spend verbs, checkout UI text, payment shell commands and card numbers until Jav approves in the app. No setting or agent can approve. Subscription-only: `ANTHROPIC_API_KEY` is stripped at startup. Usage reserve (`reserveAt`) pauses self-improvement near plan limits. |
| Runaway agents | Stop/retry per session, `maxAutoTurns` cap on Lidia nudges, crash handler keeps the server alive. Kill switch: Deck -> Safety (`/api/kill`) and `fortress` restart/stop (see docs/RUNBOOK.md). |
| Supply chain | `npm ci` from lockfile, Dependabot, `npm audit`, CodeQL, CycloneDX SBOM per CI run. |

## Reporting a vulnerability

Use GitHub private vulnerability reporting (Security tab -> Report a vulnerability) on
`thehillfire/Underground-Fortress`. If unavailable, open a minimal issue asking for a private
channel without details. Expect acknowledgement within a few days; this is a solo project.
Never include real tokens or personal data in reports.

## Deliberately not built (phone-only)

| Not built | Local equivalent |
|---|---|
| Postgres / Redis | One JSON file `data/state.json` (`server/store.js`); in-process EventEmitter |
| Kubernetes / Terraform | `fortress` launcher + `scripts/phone-setup.sh` |
| Grafana / Prometheus | `/api/health`, `/api/metrics` (Prometheus text), usage view in the app |
| PagerDuty | Termux notifications (`termux-notification`) on agent events |
| CDN / cloud WAF | Loopback-only server, static files served locally |
| Cloud secrets manager | Claude login in `~/.claude`, git-ignored `.env` |
