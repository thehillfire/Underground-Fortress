# Underground Fortress

A 2D side-view survivor bunker in a zombie apocalypse, where every survivor is a real **Claude Code session**. Lidia, the captain, runs the command room at the top. Dig a room and a new session moves in. When a session finishes a turn, it rides the elevator up to report, and Lidia decides what it does next. If she can't decide, the dweller turns **red with a `!`** and waits for you.

Art: dark industrial pixel art (gunmetal, grates, red emergency light) generated with OpenArt. The client re-pixelates every asset on load (true low-res grid, limited palette, hard alpha, nearest-neighbour scaling), so the style holds even where a generated image comes out soft.

## Run it on your phone (no computer, no API key)

Everything runs on an Android phone, billed to your **Claude subscription**. Claude Code has no Android build, so a small Ubuntu layer runs inside Termux, and the fortress talks to it on `localhost`.

1. Install **Termux** from F-Droid (not the Play Store).
2. Paste this into Termux:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/thehillfire/Underground-Fortress/HEAD/scripts/install.sh | bash
   ```
3. When Claude opens, type `/login`, pick your Claude account (Pro/Max, **not** API key), approve the link, then type `/exit`. The game opens in Chrome. ⋮ → **Add to Home screen** installs it.

Later: `fortress` to play, `fortress update` to update, `fortress mock` to try it without using Claude. SETUP → *Claude account* confirms you are on the subscription. The fortress strips `ANTHROPIC_API_KEY` from its environment, so it can never bill per token. While the fortress runs, Termux holds a wake-lock so Android doesn't put the survivors to sleep. If the SDK's bundled Claude binary won't start on your phone, set `FORTRESS_CLAUDE_PATH=$(command -v claude)` inside Ubuntu.

## Run it on a computer

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
| **Lidia** | Tap her for a dialogue scene with her briefing, report board and texting. She runs her own Claude session with fortress tools: roster, read any agent's log, message agents, create agents and rooms, set an agent's model, hand agents data files, stop agents, update orders. She also reviews every finished turn against your **standing orders** and **precedents** (questions you answered before). She chooses one of three things: *continue* (sends the next instruction), *done*, or *escalate*, which turns the dweller red. Talk to her directly to relay orders, change policy, or open new rooms. |
| **Red `!`** | Either Lidia needs a decision, or a dweller asks permission for a risky tool. Answer in the dweller's panel. Lidia remembers your answer. |
| **Repos** | `owner/repo` or any git URL, cloned with your git credentials and assignable to any room. |
| **Connectors** | MCP servers, given to every dweller. There's a quick-add shelf, a search over the official MCP registry ("any app"), and custom http/sse/stdio servers with an optional bearer token. |
| **Skills** | The finder shallow-clones skill repos (default `anthropics/skills`, add your own in Settings), searches `SKILL.md` files, and installs to `~/.claude/skills`, so every dweller gets them. |
| **Voice** | Press `M` or the MIC button. Start with "Lidia, …" or a dweller's name to address them. Replies are text only. Needs Chrome/Edge/Safari speech recognition. |
| **Chats** | Tap CHATS (top left) for everyone you can talk to: whoever needs you on top, then working, then idle, with unread counts. Tap one and the camera flies to them and opens their chat. |
| **World** | Drag to pan, wheel or pinch to zoom, click anyone to open their panel. `L` opens Lidia, `Esc` closes. |
| **Owners** | Every agent runs its room like a business it owns: it plans, executes, verifies, and scores itself. A fellow owner walks over every few reports to read the actual work and send a score and fixes. Agents that are failing or going in circles get a peer sent to help. After hitting a goal, owners keep improving for a set number of rounds (SETUP). |
| **Money gate** | A hook runs before every tool call of every agent and Lidia, in any permission mode. Payments, purchases, transfers, subscriptions, bookings, payment-API commands, card numbers, and checkout clicks are frozen until Jav taps APPROVE. Lidia and other agents cannot approve them, and no setting disables the gate. |
| **Skills** | Armory → Skills → *Starter armory* installs design, frontend, testing, planning, debugging and review skills (anthropics/skills + obra/superpowers) for every agent. Lidia can find and install skills herself. |
| **Ledger** | Tap the gold $ in the top bar to see what this month's work would have cost at API list prices, next to your plan's price ($200 for Max 20x). Broken down by survivor and Lidia, with a month-end pace. The real extra charge on your subscription is $0. |
| **Settings** | Dweller model, Lidia's model, permission mode, max automatic nudges before Lidia asks you, voice on/off. |

## Limits worth knowing

- Lidia's autopilot spends tokens on every finished turn. The *max automatic nudges* setting (default 6) caps runaway loops.
- Remote MCP servers that require interactive OAuth may not complete it headlessly. Use a bearer token when the service offers one.
- Everything binds to `127.0.0.1`. Do not expose this server publicly; it can run code on your machine.
- State lives in `data/state.json`, and workspaces in `workspaces/`.
