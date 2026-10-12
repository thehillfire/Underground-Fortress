// Persistent fortress state: one JSON file under data/.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// FORTRESS_DATA lets tests (and helpers) run against a throwaway directory.
const BASE = process.env.FORTRESS_DATA ? path.resolve(process.env.FORTRESS_DATA) : ROOT;
export const DATA_DIR = path.join(BASE, 'data');
export const WORKSPACES = path.join(BASE, 'workspaces');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const DEFAULT_STATE = {
  settings: {
    model: '',                    // '' = Claude Code default
    lidiaModel: '',
    permissionMode: 'acceptEdits',
    lidiaAutopilot: true,         // Lidia answers finished sessions automatically
    maxAutoTurns: 6,              // Lidia stops nudging after this many in a row
    skillSources: ['anthropics/skills', 'obra/superpowers'],
    autoApproveConnectors: true,  // agents use connected apps without asking each time
    refineEnabled: true,          // owners keep improving and review each other without Jav
    refineRounds: 2,              // improvement rounds after an agent hits its goal
    reviewEvery: 3,               // peer check-up every N reports
    reserveAt: 85,                // pause self-improvement when session/weekly usage passes this %
    resumeOnRestart: true,        // agents cut off by a restart pick up where they were
    lidiaVerify: true,            // Lidia checks that "done" is real before standing an agent down
    chatStyle: 'modern',          // texting look: modern | retro
    chatColor: '#b0222a',         // texting color (hex)
    worldTheme: 'fortress',       // fortress | spaceship | westernTown | pirateCove | cyberpunk (one save state, art differs)
    reduceMotion: false,
    colorblind: 'none',           // none | protanopia | deuteranopia | tritanopia
    soundOn: false,
  },
  standingOrders: 'Keep sessions moving toward their goal. Prefer small, verifiable steps. Ask Jav when a decision changes scope, spends money, deletes data, or touches production.',
  projects: [],      // rooms; each holds any number of agents
  sessions: [],
  repos: [],
  connectors: [],
  liveConnectors: {},
  usage: null,       // plan limits: current session + weekly, like Claude's /usage // what Claude Code actually loaded, incl. claude.ai connectors
  lidiaChat: [],     // Jav <-> Lidia conversation
  lidiaSessionId: null,
  reports: [],       // every report Lidia handled
  schedules: [],     // fortress alarm clock: agents woken at set times
  // "What you would have spent": API list-price cost of all work, run on the subscription.
  spend: { total: 0, lidia: 0, months: {} },
  plan: { name: 'Claude Max 20x', monthlyUsd: 200 },
  precedents: [],    // questions Jav answered, so Lidia learns
  preferences: [],   // things Lidia learned about how Jav likes things done ({text, ts})
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
    if (!this.state.settings.skillSources.includes('obra/superpowers')) this.state.settings.skillSources.push('obra/superpowers');
    // What was in flight when the server stopped. Nothing may stay red or busy with no reason on screen:
    // a request waiting on Jav died with the process, so the agent is marked "interrupted" (and resumed).
    const lastAsk = (s) => [...s.log].reverse().find(e => ['jav', 'lidia', 'schedule', 'critic'].includes(e.role) && !e.goal)?.text || s.goal || '';
    for (const s of this.state.sessions) {
      const lostAsk = !!s.pendingPermission;
      const orphan = s.status === 'needs_jav' && !s.pendingQuestion && !lostAsk;
      if (s.status === 'working' || s.status === 'reporting' || lostAsk || orphan) {
        s.interrupted = {
          ts: Date.now(), text: lastAsk(s), wasReporting: s.status === 'reporting',
          while: lostAsk ? `waiting for your OK to use ${s.pendingPermission.tool}` : s.status === 'reporting' ? 'waiting for Lidia to review its report' : s.status === 'working' ? 'working' : 'flagged for you',
        };
        s.status = 'idle'; s.activity = 'interrupted';
      }
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

export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'];
// Settings Jav (and Lidia, on his behalf) may change.
export const SETTINGS_KEYS = ['model', 'lidiaModel', 'permissionMode', 'lidiaAutopilot', 'maxAutoTurns', 'skillSources', 'autoApproveConnectors', 'refineEnabled', 'refineRounds', 'reviewEvery', 'reserveAt', 'effort', 'lidiaEffort', 'chatStyle', 'chatColor', 'resumeOnRestart', 'lidiaVerify', 'worldTheme', 'reduceMotion', 'colorblind', 'soundOn'];
export const WORLD_THEMES = ['fortress', 'spaceship', 'westernTown', 'pirateCove', 'cyberpunk'];

/** Validate a settings change; returns an error message or null. */
export function checkSettings(c) {
  if ('permissionMode' in c && !PERMISSION_MODES.includes(c.permissionMode)) return `permissionMode must be one of ${PERMISSION_MODES.join(', ')}`;
  if ('chatStyle' in c && !['modern', 'retro'].includes(c.chatStyle)) return 'chatStyle must be modern or retro';
  if ('chatColor' in c && !/^#[0-9a-f]{6}$/i.test(c.chatColor)) return 'chatColor must be a hex color like #2f7de0';
  if ('worldTheme' in c && !WORLD_THEMES.includes(c.worldTheme)) return `worldTheme must be one of ${WORLD_THEMES.join(', ')}`;
  if ('colorblind' in c && !['none', 'protanopia', 'deuteranopia', 'tritanopia'].includes(c.colorblind)) return 'colorblind must be none, protanopia, deuteranopia or tritanopia';
  for (const k of ['reduceMotion', 'soundOn']) if (k in c && typeof c[k] !== 'boolean') return `${k} must be true or false`;
  return null;
}

export const store = new Store();
export const id = (p) => `${p}_${Math.random().toString(36).slice(2, 9)}`;
