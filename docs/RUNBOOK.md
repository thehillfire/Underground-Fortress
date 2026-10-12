# Runbook

## Start / restart
- `fortress` - start the server (proot Ubuntu inside Termux) and open the app on port 4321.
- `fortress mock` - start with fake sessions, zero Claude usage.
- `fortress login` - sign in to Claude (Pro/Max account, never an API key).
- `fortress update` - `git pull --ff-only` and re-run setup.
- In app: Settings -> System -> Restart (`POST /api/system/restart`).
- Health: `curl -s http://127.0.0.1:4321/api/health` (subscription, apiKeyStripped, lastCrash, uptime).

## Kill switch
1. Fast, per agent: Stop button (`POST /api/sessions/:id/stop`).
2. Everything: stop the server process (close the Termux session, or Ctrl+C in it). Agents die with it.
   Do not kill unrelated processes on port 4321 other than the fortress itself.
3. Everything, instantly: Deck -> Safety -> HALT EVERYTHING (`POST /api/kill`). Stops every agent, blocks new turns until RESUME. Nothing is deleted.
4. Money actions are frozen by default (`server/guard.js`); deny the prompt to refuse.

## Backups / export
- All state: `data/state.json`; agent files: `workspaces/`. Both are git-ignored.
- Backup: `tar czf ~/fortress-backup-$(date +%F).tgz data workspaces` (stop the server first for consistency).
- Restore: extract into the repo root (or the `FORTRESS_DATA` dir), then `fortress`.
- Copy backups off-device only to storage you control; they contain conversations.

## Incident response
1. Contain: Stop the agents involved, or stop the server.
2. Assess: read `data/crash.log` and the session transcripts in the app; check `/api/health`.
3. Money: confirm no approved payment prompts; check the relevant provider's account manually.
4. Secrets: if a token appeared in a transcript or file, revoke it at the provider, remove it from
   `data/` and `workspaces/`, and rotate connector credentials. Run `gitleaks detect` if it touched git.
5. Recover: restore from backup if state is corrupt; `fortress update` if a fix landed.
6. Record: note what happened and the fix in an issue; tighten permission mode or guard rules if needed.
