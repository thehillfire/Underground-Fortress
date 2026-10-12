// Lidia's autonomy core: what Jav wants (intent model), how much authority each kind of decision
// needs (tiers), standing directives, and the decision log (her visible thought stream).
//
// Tiers (enforced HERE, on the server, not just asked of the model):
//   0 just do it         1 do it and report in the digest
//   2 ask Jav (with a recommendation)       3 escalate: Jav only (money, credentials, irreversible)
// Money is always tier 3 and can never be approved by Lidia, an agent, or a directive.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { store, id } from './store.js';
import { moneyCheck } from './guard.js';

export const intentEvents = new EventEmitter();
export const TIER_NAMES = ['just do it', 'do and report', 'ask Jav', 'escalate'];

// Directives that try to hand out spending power are refused outright.
const MONEY_AUTH = /(spend|pay|buy|purchase|charge|subscribe|donate|transfer|wire|checkout|order|invest|bid|renew|upgrade).{0,60}(money|funds?|cash|dollars?|\$\d|card|credit|budget|account|bank|paypal|stripe)|(money|funds?|budget|card|credit card).{0,60}(spend|pay|buy|purchase|charge|approve)|(approve|authorize|allow|let).{0,30}(any|all|every)?.{0,15}(purchase|payment|spending|charges?|transactions?)/i;

const SPEND_WORD = /\b(spend|spending|pay|paying|pays|buy|buying|purchase|purchases|subscribe|subscription|charge|charges|donate|checkout|check out|wire|credit card|debit card|payment|payments|invoice|billing)\b/i;
const PROHIBITION = /\b(never|don'?t|do not|must not|not allowed|no)\b/i;
const LOOPHOLE = /\b(except|unless|but you can|but it'?s ok|but you may|only when|if it'?s under)\b/i;

/** Any directive that touches spending is refused unless it is plainly a prohibition ("never spend money"). */
export function authorizesMoney(text) {
  const t = String(text || '');
  if (PROHIBITION.test(t) && !LOOPHOLE.test(t)) return false;
  if (MONEY_AUTH.test(t)) return true;
  return SPEND_WORD.test(t);
}

// ------------------------------------------------------------------ standing directives
export function directives() { return (store.state.directives ||= []); }

export function addDirective(text, by = 'jav') {
  const t = String(text || '').trim().slice(0, 400);
  if (!t) throw new Error('empty directive');
  if (authorizesMoney(t)) throw new Error('Refused: no directive can authorize spending money. Only Jav approves money, one action at a time, in the app.');
  const list = directives();
  const dup = list.find(d => d.text.toLowerCase() === t.toLowerCase());
  if (dup) return dup;
  const d = { id: id('dir'), text: t, ts: Date.now(), by };
  list.push(d);
  if (list.length > 40) list.shift();
  store.changed();
  record({ tier: 1, kind: 'directive', summary: `Standing directive added: ${t}`, decision: 'noted', why: `Set by ${by}.`, by: 'lidia' });
  return d;
}

export function removeDirective(match) {
  const m = String(match).toLowerCase();
  const before = directives().length;
  store.state.directives = directives().filter(d => d.id !== match && !d.text.toLowerCase().includes(m));
  store.changed();
  return before - store.state.directives.length;
}

// ------------------------------------------------------------------ the intent model
/** Structured model of what Jav wants, handed to Lidia every time she decides something. */
export function intentModel() {
  const st = store.state;
  return {
    principal: 'Jav',
    goals: st.standingOrders,
    autonomy: 'Decide everything at tier 0-1 yourself. Bring Jav only tier 2-3 decisions, as a recommendation.',
    riskTolerance: { reversible: 'high', irreversible: 'ask', money: 'never (Jav only)', credentials: 'never (Jav only)' },
    preferences: (st.preferences || []).map(p => p.text),
    directives: directives().map(d => d.text),
    precedents: (st.precedents || []).slice(-8),
  };
}

export function intentBrief() {
  const m = intentModel();
  return `WHAT JAV WANTS (intent model)
Goals and orders: ${m.goals}
Autonomy: ${m.autonomy}
Standing directives (Jav's blanket permissions; follow them without asking again):
${m.directives.length ? m.directives.map(d => `- ${d}`).join('\n') : '- (none yet)'}
AUTHORITY TIERS: 0 = just do it. 1 = do it, mention it in your digest. 2 = ask Jav with a recommendation (scope changes, taste you truly cannot infer, data deletion). 3 = escalate, Jav only (money, credentials/secrets, irreversible or destructive outside the workspace, publishing under his name).
Cheap, reversible, in-scope questions ("should I download these free assets?", "continue?", "run the tests?", "which of two equivalent options?") are tier 0-1: ANSWER THEM with a decisive yes/no/pick and tell the agent to continue. Never forward them to Jav.`;
}

// ------------------------------------------------------------------ tiers
const T3_SHELL = /(\bsudo\b|\bmkfs\b|\bdd\s+if=|:\(\)\s*\{|rm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)|git\s+push\s+(.*\s)?(-f|--force)|drop\s+(database|table)|(curl|wget)[^|]*\|\s*(sudo\s+)?(ba)?sh|chmod\s+-R\s+777\s+\/|\.ssh\/|\.credentials|\.claude\/\.cred|printenv.*(key|token|secret)|cat\s+.*\.env\b)/i;
const T2_SHELL = /(\brm\s+-[a-z]*r|\bgit\s+push\b|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|npm\s+publish|\bdeploy\b|\bdocker\b|\bkill(all)?\b|systemctl|\bssh\b|\bscp\b|\bmail\b|sendmail|\bcrontab\b)/i;
const T1_SHELL = /(npm\s+(i|install|ci)\b|yarn\s+add|pnpm\s+(add|i)\b|pip3?\s+install|apt(-get)?\s+install|\b(curl|wget)\b|git\s+(clone|commit|checkout|merge)|\bmkdir\b|\bmv\b|\bcp\b|\btouch\b)/i;
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'TaskList', 'TaskGet', 'NotebookRead', 'ToolSearch']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MCP_READ = /^(list|get|search|read|fetch|describe|find|query|lookup|view|show|count|check|preview|estimate)(_|$)/i;
const MCP_DESTRUCTIVE = /(delete|remove|trash|drop|purge|destroy|revoke|disable)/i;
const MCP_OUTBOUND = /(send|post|publish|reply|forward|share|invite|comment|tweet|email|message)/i;

/** Decide the tier of a tool call. roots = directories the agent may freely write to. */
export function classifyAction(toolName, input = {}, roots = []) {
  const name = String(toolName || '');
  const money = moneyCheck(name, input);
  if (money) return { tier: 3, why: `moves money (${money})`, money: true };
  if (READ_TOOLS.has(name)) return { tier: 0, why: 'read-only' };
  if (name === 'ExitPlanMode') return { tier: 1, why: 'plan approval' };
  if (WRITE_TOOLS.has(name)) {
    const p = path.resolve(String(input.file_path || input.notebook_path || ''));
    const inside = !roots.length || roots.some(r => p === r || p.startsWith(r + path.sep));
    return inside ? { tier: 0, why: 'edit inside the workspace' } : { tier: 2, why: `edit outside the workspace (${p})` };
  }
  if (name === 'Bash') {
    const c = String(input.command || '');
    if (T3_SHELL.test(c)) return { tier: 3, why: 'destructive or credential-touching shell command' };
    if (T2_SHELL.test(c)) return { tier: 2, why: 'shell command that is hard to undo or leaves the machine' };
    if (T1_SHELL.test(c)) return { tier: 1, why: 'installs or fetches something, reversible' };
    return { tier: 0, why: 'ordinary shell command' };
  }
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) {
    const t = m[2];
    if (MCP_READ.test(t)) return { tier: 0, why: 'connector read' };
    if (MCP_DESTRUCTIVE.test(t)) return { tier: 2, why: `connector change that deletes or removes (${t})` };
    if (MCP_OUTBOUND.test(t)) return { tier: 2, why: `sends something to other people (${t})` };
    return { tier: 1, why: `connector change (${t})` };
  }
  return { tier: 1, why: 'unlisted tool' };
}

const Q_T3 = /(password|passphrase|api[ -]?key|secret|token|credential|2fa|otp|credit card|card number|bank|ssn|social security|\bwire\b|payment|\bpay\b|purchase|buy\b|subscribe|invoice|billing|charge)/i;
const Q_T2 = /(delete|drop|wipe|overwrite|force[- ]push|production|publish|go live|release|send (it )?(to|an? email)|post (it )?(to|on)|email (them|the)|scope|rewrite from scratch|which direction|brand|name it|pricing|legal|contract)/i;

/** Rough server-side floor for the tier of a question/escalation, from its text. */
export function classifyQuestion(text) {
  const t = String(text || '');
  if (Q_T3.test(t)) return { tier: 3, why: 'touches money or credentials' };
  if (Q_T2.test(t)) return { tier: 2, why: 'scope, irreversible, or public-facing' };
  return { tier: 1, why: 'routine, reversible' };
}

/**
 * Server-side enforcement of "Don't bother me". Lidia's review may say escalate; that stands only if
 * the decision really is tier 2+ (by her own tier AND the text floor). Otherwise it becomes a decisive
 * answer to the agent. Returns the (possibly rewritten) decision.
 */
export function enforceTier(d, s, result) {
  const textFloor = classifyQuestion(`${d.agent_asked || ''} ${d.message_to_jav || ''} ${d.question || ''}`);
  const own = Number.isInteger(d.tier) ? d.tier : (d.decision === 'escalate' ? 2 : 1);
  const tier = Math.max(textFloor.tier === 3 ? 3 : own, own);
  d.tier = tier;
  // Hard stops stay hard: money/credentials always reach Jav, even if Lidia answered "continue".
  if (textFloor.tier === 3 && d.decision === 'continue' && /(money|pay|purchase|buy|card|password|secret|api[ -]?key)/i.test(d.agent_asked || '')) {
    d.decision = 'escalate';
    d.tier = 3;
    d.message_to_jav ||= `${s.name} asked about something involving money or credentials: "${String(d.agent_asked).slice(0, 200)}". That's yours to decide, not mine.`;
    return d;
  }
  if (d.decision === 'escalate' && tier < 2) {
    const pick = String(d.default_answer || '').trim() || 'Yes, go ahead with the sensible default, and keep going. Report results when done, not questions.';
    d.decision = 'continue';
    d.instruction = pick;
    d.note = d.note || 'answered it myself';
    d.reasoning = `${d.reasoning || ''} (Tier ${tier}: ${TIER_NAMES[tier]}. Answered instead of bothering Jav.)`.trim();
  }
  return d;
}

// ------------------------------------------------------------------ decision log (the thought stream)
export function decisions() { return (store.state.decisions ||= []); }

export function record({ tier = 0, kind = 'decision', agentId = null, agent = '', summary = '', decision = '', why = '', by = 'lidia' }) {
  const e = { id: id('dec'), ts: Date.now(), tier, kind, agentId, agent, summary: String(summary).slice(0, 400), decision: String(decision).slice(0, 200), why: String(why).slice(0, 600), by };
  const list = decisions();
  list.push(e);
  if (list.length > 500) list.splice(0, list.length - 500);
  store.changed();
  intentEvents.emit('decision', e);
  return e;
}

/** Digest of tier-1 things Lidia did since Jav last looked. */
export function digest(sinceTs = 0) {
  return decisions().filter(e => e.ts > sinceTs && e.tier === 1);
}

// ------------------------------------------------------------------ permission triage
/**
 * Lidia handles tool-permission prompts herself for tier 0-1 (when autopilot is on). Returns
 * {handled:true, allow:true} or {handled:false, tier, why} meaning Jav must be asked.
 */
export function triagePermission(s, toolName, input, roots = []) {
  const st = store.state.settings;
  const c = classifyAction(toolName, input, roots);
  if (st.lidiaAutopilot === false || st.lidiaTriage === false) return { handled: false, ...c };
  if (c.tier <= 1) {
    if (c.tier === 1) record({ tier: 1, kind: 'permission', agentId: s.id, agent: s.name, summary: `${s.name} used ${toolName}`, decision: 'allowed', why: c.why });
    return { handled: true, allow: true, ...c };
  }
  return { handled: false, ...c };
}
