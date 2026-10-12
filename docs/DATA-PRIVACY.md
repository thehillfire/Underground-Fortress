# Data and privacy

- Local only: state, transcripts, and workspaces live on the device under `data/` and `workspaces/`
  (or `FORTRESS_DATA`). Nothing is sent to any server of this project; there is no telemetry.
- Third parties: prompts and tool use go to Anthropic through your Claude subscription login, and to
  any connectors you enable (each with its own privacy terms). Connector secrets are redacted in API output.
- No API keys are used or stored; `ANTHROPIC_API_KEY` is stripped at startup.
- Export: copy `data/state.json` and `workspaces/` (see docs/RUNBOOK.md, Backups).
- Erase: delete a session/project in the app (`DELETE /api/sessions/:id`, `/api/projects/:id`), or wipe
  everything with `rm -rf data workspaces` while the server is stopped. Claude login is separate (`~/.claude`).
- Retention: kept until you delete it; `data/crash.log` is only surfaced for 7 days but not auto-deleted.
- PII redaction: connector credentials are redacted in state output; emails, card numbers, phone numbers, tokens and keys are redacted before anything is written to the audit log. Avoid pasting secrets or others' personal data into chats.
- Repo hygiene: `.env`, `data/`, `workspaces/` are git-ignored; gitleaks runs in CI.
