// Lidia: captain of the fortress. Reviews every finished turn and talks to Jav.
import { oneShot } from './agent.js';
import { store } from './store.js';

const PERSONA = `You are Lidia, captain of an underground fortress. Every dweller below you is a Claude Code session doing real software and knowledge work for Jav, the fortress owner. Every session reports to you. You are decisive, brief and practical. You never invent facts about the work; you only use what the reports say.`;

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function briefing() {
  const st = store.state;
  const precedents = st.precedents.slice(-15)
    .map(p => `- Q: ${p.question}\n  Jav: ${p.answer}`).join('\n') || '(none yet)';
  return `STANDING ORDERS FROM JAV:\n${st.standingOrders}\n\nPAST ANSWERS FROM JAV (precedents):\n${precedents}`;
}

function transcript(s, n = 14) {
  return s.log.slice(-n).map(e => `[${e.role}${e.tool ? ':' + e.tool : ''}] ${String(e.text).slice(0, 600)}`).join('\n');
}

/**
 * A session just finished a turn. Decide: continue (with an instruction),
 * done, or escalate to Jav (session turns red with "!").
 */
export async function review(s, result) {
  const prompt = `${briefing()}

SESSION REPORTING: "${s.name}" (room: ${s.roomType})
GOAL: ${s.goal || '(no explicit goal; follow Jav\'s latest message)'}
AUTOMATIC NUDGES SO FAR IN A ROW: ${s.autoTurns}

RECENT TRANSCRIPT:
${transcript(s)}

FINAL REPORT OF THIS TURN:
${String(result).slice(0, 4000)}

Decide what this session does next. Reply with ONLY a JSON object, one of:
{"decision":"continue","instruction":"<exact next instruction to the session>","note":"<5-12 word summary for Jav>"}
{"decision":"done","note":"<5-12 word summary for Jav>"}
{"decision":"escalate","question":"<the specific question Jav must answer>","note":"<5-12 word summary>"}

Rules: choose "continue" only when the next step clearly follows from the goal, standing orders or precedents. Choose "done" when the goal is met. Choose "escalate" whenever the session asks a question you cannot answer from the orders/precedents, the work is ambiguous, risky, or needs Jav's taste or credentials.`;
  const text = await oneShot({ system: PERSONA, prompt, model: store.state.settings.lidiaModel });
  const d = extractJson(text);
  if (!d || !['continue', 'done', 'escalate'].includes(d.decision)) {
    return { decision: 'escalate', question: 'I could not make sense of this report. Please take a look.', note: 'unclear report' };
  }
  if (d.decision === 'continue' && !d.instruction) d.decision = 'escalate';
  return d;
}

/**
 * Jav talks to Lidia directly. She can reply, update standing orders,
 * relay messages to sessions, and open new rooms.
 */
export async function chat(text) {
  const st = store.state;
  const roster = st.sessions.map(s =>
    `- ${s.name} [${s.status}] room=${s.roomType} goal=${(s.goal || '-').slice(0, 120)}${s.pendingQuestion ? ` WAITING ON JAV: ${s.pendingQuestion}` : ''}`
  ).join('\n') || '(no dwellers yet)';
  const history = st.lidiaChat.slice(-16).map(m => `${m.role === 'jav' ? 'Jav' : 'Lidia'}: ${m.text}`).join('\n');
  const prompt = `${briefing()}

FORTRESS ROSTER:
${roster}

CONVERSATION SO FAR:
${history}

Jav says: ${text}

Reply with ONLY a JSON object:
{"reply":"<what you say to Jav, spoken aloud, 1-3 sentences>",
 "standingOrders":"<OPTIONAL full replacement of standing orders, only if Jav changed policy>",
 "dispatch":[{"session":"<exact session name>","message":"<instruction to relay>"}],
 "newSession":{"name":"<short name>","goal":"<goal>","roomType":"workshop|library|server|lab"}}
Omit optional keys you don't need. Only dispatch to sessions in the roster. Only create a session if Jav asked for one.`;
  const raw = await oneShot({ system: PERSONA, prompt, model: st.settings.lidiaModel });
  return extractJson(raw) || { reply: raw || 'Copy that.' };
}
