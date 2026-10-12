# Underground Fortress

A 2D side-view underground facility where every dweller is a real **Claude Code session**. Lidia, the captain, runs the command room at the top. Dig a room and a new session moves in. When a session finishes a turn, it rides the elevator up to report, and Lidia decides what it does next. If she can't decide, the dweller turns **red with a `!`** and waits for you.

Art: dark industrial pixel art (gunmetal, grates, red emergency light) generated with OpenArt. The client re-pixelates every asset on load (true low-res grid, limited palette, hard alpha, nearest-neighbour scaling), so the style holds even where a generated image comes out soft.

## Run it

```bash
npm install
npm start            # http://127.0.0.1:4321
npm run mock         # same UI, fake sessions, no Claude usage
```

You need Node 20+ and Claude Code authentication on this machine, either a logged-in `claude` CLI or `ANTHROPIC_API_KEY`. The first start downloads the OpenArt art into `public/assets/`. If that fails, the game falls back to drawn pixel art.

## What's in the fortress

| Thing | How it works |
|---|---|
| **Dwellers / rooms** | `+ DWELLER` or click the dashed "Excavate room" slot. Each one is an Agent SDK session (resumed across turns) in its own workspace folder or a connected repo. Four room types: workshop, archive, reactor, bio lab. |
| **Lidia** | Reviews every finished turn against your **standing orders** and **precedents** (questions you answered before). She chooses one of three things: *continue* (sends the next instruction), *done*, or *escalate*, which turns the dweller red. Talk to her directly to relay orders, change policy, or open new rooms. |
| **Red `!`** | Either Lidia needs a decision, or a dweller asks permission for a risky tool. Answer in the dweller's panel. Lidia remembers your answer. |
| **Repos** | `owner/repo` or any git URL, cloned with your git credentials and assignable to any room. |
| **Connectors** | MCP servers, given to every dweller. There's a quick-add shelf, a search over the official MCP registry ("any app"), and custom http/sse/stdio servers with an optional bearer token. |
| **Skills** | The finder shallow-clones skill repos (default `anthropics/skills`, add your own in Settings), searches `SKILL.md` files, and installs to `~/.claude/skills`, so every dweller gets them. |
| **Voice** | Press `M` or the MIC button. Start with "Lidia, …" or a dweller's name to address them. Lidia talks back (browser TTS). Needs Chrome/Edge/Safari speech recognition. |
| **World** | Drag to pan, wheel or pinch to zoom, click anyone to open their panel. `L` opens Lidia, `Esc` closes. |
| **Settings** | Dweller model, Lidia's model, permission mode, max automatic nudges before Lidia asks you, voice on/off. |

## Limits worth knowing

- Lidia's autopilot spends tokens on every finished turn. The *max automatic nudges* setting (default 6) caps runaway loops.
- Remote MCP servers that require interactive OAuth may not complete it headlessly. Use a bearer token when the service offers one.
- Everything binds to `127.0.0.1`. Do not expose this server publicly; it can run code on your machine.
- State lives in `data/state.json`, and workspaces in `workspaces/`.
