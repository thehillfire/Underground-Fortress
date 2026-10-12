// Message bus: typed, HMAC-signed, per-sender keys. The SERVER stamps the sender (agents call a tool that
// closes over their own id), so one agent cannot pose as another. Bursts are rate limited and flagged.
import { EventEmitter } from 'node:events';
import { store, id } from './store.js';
import { hmac, timingEqual, redact } from './crypto.js';
import { allow } from './ratelimit.js';
import * as audit from './audit.js';
import { looksLikeInjection } from './safety.js';

export const TYPES = ['REQUEST', 'RESPONSE', 'NOTIFY', 'ESCALATE', 'DELEGATE', 'QUERY', 'ACK'];
export const busEvents = new EventEmitter();
let deliverFn = () => {};
export const setDeliver = (fn) => { deliverFn = fn; };

const body = (m) => `${m.id}|${m.type}|${m.from}|${m.to}|${m.topic}|${m.ts}|${m.corr || ''}|${m.body}`;
export const sign = (m) => hmac(`bus:${m.from}`, body(m));
export const verifySig = (m) => timingEqual(sign(m), m.sig || '');

export const log = () => (store.state.bus ||= []);
/** Who is a valid party? Agent ids or names (resolved to ids), 'lidia', 'jav'. */
function resolve(x) {
  const v = String(x || '').trim();
  if (['lidia', 'jav'].includes(v.toLowerCase())) return v.toLowerCase();
  const s = store.state.sessions.find(s => s.id === v || s.name.toLowerCase() === v.toLowerCase());
  return s ? s.id : null;
}
const nameOf = (x) => ['lidia', 'jav'].includes(x) ? x : (store.state.sessions.find(s => s.id === x)?.name || x);

/** Publish. `from` is trusted (server-supplied). Throws on a bad type, unknown recipient, or flooding. */
export function publish({ from, to, type = 'NOTIFY', topic = '', body: text = '', corr = '' }) {
  if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES.join(', ')}`);
  const rcpt = resolve(to);
  if (!rcpt) throw new Error(`No such recipient: ${to}`);
  if (!allow(`bus:${from}`, 20, 0.5)) {
    audit.record(`agent:${nameOf(from)}`, 'bus.flood', rcpt, 'rate limited');
    flag(from, 'sending messages faster than 20 in a burst');
    throw new Error('Slow down: too many messages. Batch them.');
  }
  const m = { id: id('msg'), type, from, to: rcpt, topic: String(topic).slice(0, 80), body: String(text).slice(0, 6000), ts: Date.now(), corr: corr || '' };
  m.sig = sign(m);
  if (looksLikeInjection(m.body)) { m.suspicious = true; flag(from, 'message looks like a prompt-injection attempt'); }
  const l = log(); l.push(m); if (l.length > 600) l.splice(0, l.length - 600);
  audit.record(`agent:${nameOf(from)}`, `bus.${type.toLowerCase()}`, nameOf(rcpt), redact(m.topic || m.body.slice(0, 80)));
  store.changed();
  busEvents.emit('message', m);
  deliverFn(m);
  return m;
}

/** Anomaly: remember it so the deck can show it. */
export function flag(sender, reason) {
  const a = (store.state.anomalies ||= []);
  a.push({ ts: Date.now(), agent: nameOf(sender), reason });
  if (a.length > 100) a.shift();
  busEvents.emit('anomaly', a.at(-1));
}

export function inbox(agentId, { unreadOnly = true } = {}) {
  return log().filter(m => m.to === agentId && (!unreadOnly || !m.read));
}
export function markRead(agentId) { for (const m of log()) if (m.to === agentId) m.read = true; store.changed(); }

/** Full view for the Message Log screen; verifies each signature so tampering shows. */
export function view({ q = '', agent = '', limit = 200 } = {}) {
  const n = q.toLowerCase();
  return log().filter(m => (!agent || m.from === agent || m.to === agent) && (!n || `${m.topic} ${m.body} ${nameOf(m.from)} ${nameOf(m.to)}`.toLowerCase().includes(n)))
    .slice(-limit).map(m => ({ ...m, fromName: nameOf(m.from), toName: nameOf(m.to), valid: verifySig(m) }));
}
