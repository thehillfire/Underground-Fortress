// Tool Broker: a PreToolUse hook on every agent (alongside the money gate). Policy:
//  - kill switch on: nothing runs
//  - secrets are off limits (Claude login, the master key, auth + audit files, the fortress state)
//  - writes stay inside the agent's workspace roots (plus /tmp)
// Read-only research is left alone. Destructive shell commands are routed to Jav by the tier system, not here.
import path from 'node:path';
import os from 'node:os';
import { DATA_DIR } from './store.js';
import { isKilled } from './safety.js';
import * as audit from './audit.js';

const SECRET_PATHS = () => [path.join(os.homedir(), '.claude', '.credentials.json'), path.join(os.homedir(), '.claude.json'), path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.aws'), path.join(os.homedir(), '.config', 'gh'),
  path.join(DATA_DIR, '.master.key'), path.join(DATA_DIR, 'auth.json'), path.join(DATA_DIR, 'audit.log'), path.join(DATA_DIR, 'state.json'), path.join(DATA_DIR, 'memory.json')];
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob']);
const WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const under = (p, dir) => p === dir || p.startsWith(dir + path.sep);

/** Pure decision, testable: returns null (allow) or a reason string (deny). */
export function brokerCheck(toolName, input = {}, roots = []) {
  if (isKilled()) return 'The kill switch is on. Nothing runs until Jav resumes the fortress.';
  const secrets = SECRET_PATHS();
  if (FILE_TOOLS.has(toolName)) {
    const raw = input.file_path || input.notebook_path || input.path;
    if (raw) {
      const p = path.resolve(String(raw));
      if (secrets.some(s => under(p, s))) return `${p} holds fortress or login secrets. Agents may not touch it.`;
      if (WRITE.has(toolName) && roots.length && !roots.some(r => under(p, path.resolve(r))) && !under(p, os.tmpdir()) && !under(p, '/tmp'))
        return `Writes must stay inside the workspace (${roots[0]}). ${p} is outside it. Ask Jav if it really needs to go there.`;
    }
  }
  if (toolName === 'Bash') {
    const c = String(input.command || '');
    if (secrets.some(s => c.includes(s))) return 'That command touches fortress or login secrets.';
    if (/(\.claude\/\.credentials|\.master\.key|auth\.json)/.test(c)) return 'That command touches fortress or login secrets.';
  }
  return null;
}

/** Hook entry for the SDK. */
export function brokerHooks(actorName, getRoots) {
  return {
    PreToolUse: [{
      hooks: [async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return {};
        const why = brokerCheck(input.tool_name, input.tool_input, getRoots());
        if (!why) return {};
        audit.record(`agent:${actorName}`, 'broker.denied', input.tool_name, why);
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Blocked by the fortress tool broker: ${why}` } };
      }],
    }],
  };
}

/** Merge hook sets (the SDK takes one `hooks` object). */
export function mergeHooks(...sets) {
  const out = {};
  for (const h of sets) for (const [k, v] of Object.entries(h || {})) (out[k] ||= []).push(...v);
  return out;
}
