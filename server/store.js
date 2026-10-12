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
    skillSources: ['anthropics/skills'],
    autoApproveConnectors: true,  // agents use connected apps without asking each time
  },
  standingOrders: 'Keep sessions moving toward their goal. Prefer small, verifiable steps. Ask Jav when a decision changes scope, spends money, deletes data, or touches production.',
  sessions: [],
  repos: [],
  connectors: [],
  liveConnectors: {}, // what Claude Code actually loaded, incl. claude.ai connectors
  lidiaChat: [],     // Jav <-> Lidia conversation
  lidiaSessionId: null,
  reports: [],       // every report Lidia handled
  // "What you would have spent": API list-price cost of all work, run on the subscription.
  spend: { total: 0, lidia: 0, months: {} },
  plan: { name: 'Claude Max 20x', monthlyUsd: 200 },
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
      settings: { ...DEFAULT_STATE.settings, ...(loaded.settings || {}) },
      spend: { ...DEFAULT_STATE.spend, ...(loaded.spend || {}) } };
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

  /** Record what a turn would have cost at API prices. `who` = session id or 'lidia'. */
  addSpend(usd, who) {
    if (!usd) return;
    const sp = this.state.spend;
    const month = new Date().toISOString().slice(0, 7);
    const m = (sp.months[month] ||= { total: 0, lidia: 0, agents: {} });
    sp.total += usd; m.total += usd;
    if (who === 'lidia') { sp.lidia += usd; m.lidia += usd; }
    else m.agents[who] = (m.agents[who] || 0) + usd;
    this.changed();
  }

  report(r) {
    this.state.reports.push({ ts: Date.now(), ...r });
    if (this.state.reports.length > 100) this.state.reports.shift();
  }

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
      reports: st.reports.slice(-30),
      feed: st.feed.slice(-50),
    };
  }
}

export const store = new Store();
export const id = (p) => `${p}_${Math.random().toString(36).slice(2, 9)}`;
