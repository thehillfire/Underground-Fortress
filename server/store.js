// Persistent fortress state: one JSON file under data/.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const WORKSPACES = path.join(ROOT, 'workspaces');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const DEFAULT_STATE = {
  settings: {
    model: '',                    // '' = Claude Code default
    lidiaModel: '',
    permissionMode: 'acceptEdits',
    lidiaAutopilot: true,         // Lidia answers finished sessions automatically
    maxAutoTurns: 6,              // Lidia stops nudging after this many in a row
    speakLidia: true,
    skillSources: ['anthropics/skills'],
  },
  standingOrders: 'Keep sessions moving toward their goal. Prefer small, verifiable steps. Ask Jav when a decision changes scope, spends money, deletes data, or touches production.',
  sessions: [],
  repos: [],
  connectors: [],
  lidiaChat: [],     // Jav <-> Lidia conversation
  precedents: [],    // questions Jav answered, so Lidia learns
  feed: [],          // fortress-wide event ticker
};

class Store extends EventEmitter {
  constructor() {
    super();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACES, { recursive: true });
    let loaded = {};
    try { loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
    this.state = { ...structuredClone(DEFAULT_STATE), ...loaded,
      settings: { ...DEFAULT_STATE.settings, ...(loaded.settings || {}) } };
    // Anything that was mid-turn when the server stopped is idle now.
    for (const s of this.state.sessions) {
      if (s.status === 'working' || s.status === 'reporting') s.status = 'idle';
      s.pendingPermission = null;
    }
    this._timer = null;
  }

  changed() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 300);
    this.emit('change');
  }

  flush() {
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(this.state, null, 2));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  }

  session(id) { return this.state.sessions.find(s => s.id === id); }

  feed(text, kind = 'info', sessionId = null) {
    this.state.feed.push({ ts: Date.now(), text, kind, sessionId });
    if (this.state.feed.length > 200) this.state.feed.splice(0, this.state.feed.length - 200);
    this.changed();
  }

  // What the browser sees: drop bulky fields it doesn't need.
  publicState() {
    const st = this.state;
    return {
      ...st,
      sessions: st.sessions.map(s => ({ ...s, log: s.log.slice(-300) })),
      lidiaChat: st.lidiaChat.slice(-100),
      feed: st.feed.slice(-50),
    };
  }
}

export const store = new Store();
export const id = (p) => `${p}_${Math.random().toString(36).slice(2, 9)}`;
