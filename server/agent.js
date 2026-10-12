// Thin wrapper over the Claude Agent SDK, plus a mock runner for offline demos.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { moneyHooks } from './guard.js';

export const MOCK = process.env.FORTRESS_MOCK === '1';

/** A prompt that is content blocks (text + images) becomes a one-message input stream. */
export function asInput(prompt) {
  if (!Array.isArray(prompt)) return prompt;
  return (async function* () {
    yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' };
  })();
}
const promptText = (p) => (Array.isArray(p) ? p.filter(b => b.type === 'text').map(b => b.text).join('\n') : String(p));

// Anyone interested in plan rate-limit events (usage meter).
export const rateLimitListeners = new Set();
const noteRateLimit = (m) => { if (m.type === 'rate_limit_event') for (const fn of rateLimitListeners) { try { fn(m.rate_limit_info); } catch {} } };

// Subscription only: never let an API key (pay-per-token) reach the Claude sessions.
export const API_KEY_STRIPPED = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
// Use an installed `claude` instead of the SDK's bundled one (escape hatch for unusual platforms).
const CLAUDE_PATH = process.env.FORTRESS_CLAUDE_PATH ? { pathToClaudeCodeExecutable: process.env.FORTRESS_CLAUDE_PATH } : {};

/**
 * Run one turn of a Claude session (a new one, or resumed by `resume`).
 * Streams progress through callbacks and resolves with the turn's result.
 */
export async function runTurn(opts) {
  if (MOCK) return mockTurn(opts);
  const { prompt, cwd, resume, model, permissionMode, mcpServers, appendSystem,
          onInit, onText, onTool, canUseTool, abortController, hooks, effort, onQuery, additionalDirectories } = opts;
  const q = query({
    prompt: asInput(prompt),
    options: {
      cwd,
      additionalDirectories: additionalDirectories?.length ? additionalDirectories : undefined,
      resume: resume || undefined,
      model: model || undefined,
      effort: effort || undefined,
      // Never pass allowDangerouslySkipPermissions: Claude Code refuses to start with it as root, and on
      // the phone everything runs as root inside proot. "Bypass" is done by approving every prompt
      // in canUseTool instead (see sessions.js), which also works as root.
      permissionMode,
      mcpServers,
      settingSources: ['user', 'project', 'local'], // loads skills, CLAUDE.md, settings
      systemPrompt: { type: 'preset', preset: 'claude_code', append: appendSystem },
      canUseTool,
      abortController,
      hooks,
      ...CLAUDE_PATH,
    },
  });
  onQuery?.(q);
  let out = { result: '', isError: false, costUsd: 0, sessionId: resume };
  for await (const m of q) {
    noteRateLimit(m);
    if (m.type === 'system' && m.subtype === 'init') {
      out.sessionId = m.session_id;
      onInit?.(m);
    } else if (m.type === 'assistant') {
      for (const b of m.message?.content || []) {
        if (b.type === 'text' && b.text.trim()) onText?.(b.text);
        else if (b.type === 'tool_use') onTool?.(b.name, b.input);
      }
    } else if (m.type === 'result') {
      out.sessionId = m.session_id || out.sessionId;
      out.costUsd = m.total_cost_usd || 0;
      out.isError = m.subtype !== 'success' || !!m.is_error;
      out.result = m.result || (out.isError ? `Turn ended: ${m.subtype}` : '');
    }
  }
  return out;
}

/** A single tool-less completion, used for Lidia's review of each report. */
export async function oneShot({ system, prompt, model }) {
  if (MOCK) return { text: await mockOneShot(prompt), costUsd: 0.004 };
  const q = query({
    prompt,
    options: {
      model: model || undefined,
      systemPrompt: system,
      maxTurns: 1,
      tools: [],
      permissionMode: 'dontAsk',
      allowedTools: [],
      settingSources: [],
      ...CLAUDE_PATH,
    },
  });
  let text = '', costUsd = 0;
  for await (const m of q) {
    noteRateLimit(m);
    if (m.type === 'assistant') {
      for (const b of m.message?.content || []) if (b.type === 'text') text += b.text;
    } else if (m.type === 'result') { if (m.result) text = m.result; costUsd = m.total_cost_usd || 0; }
  }
  return { text: text.trim(), costUsd };
}

/**
 * Lidia's own conversation: a persistent session whose only tools are the
 * fortress controls (no shell, no files). Resumed every time Jav talks to her.
 */
export async function runCaptain({ prompt, resume, model, effort, system, server, extraServers = {}, onTool, onInit }) {
  if (MOCK) return mockCaptain({ prompt: promptText(prompt), onTool });
  const q = query({
    prompt: asInput(prompt),
    options: {
      resume: resume || undefined,
      model: model || undefined,
      systemPrompt: system,
      effort: effort || undefined,
      tools: [],                                   // no shell, no files: she runs the place, agents do the hands-on work
      mcpServers: { fortress: server, ...extraServers },
      settingSources: ['user'],                    // loads your claude.ai connectors and user MCP servers
      permissionMode: 'default',
      // Every connector (calendar, mail, …) is hers to use when Jav asks; nothing else.
      canUseTool: async (name, input) => name.startsWith('mcp__')
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'The captain only uses fortress tools and connectors. Assign an agent for files or shell work.' },
      maxTurns: 16,
      hooks: moneyHooks(null),
      ...CLAUDE_PATH,
    },
  });
  const out = { text: '', costUsd: 0, sessionId: resume };
  for await (const m of q) {
    noteRateLimit(m);
    if (m.type === 'system' && m.subtype === 'init') { out.sessionId = m.session_id; onInit?.(m); }
    else if (m.type === 'assistant') {
      for (const b of m.message?.content || []) if (b.type === 'tool_use') onTool?.(b.name, b.input);
    } else if (m.type === 'result') {
      out.text = m.result || out.text;
      out.costUsd = m.total_cost_usd || 0;
      out.sessionId = m.session_id || out.sessionId;
    }
  }
  return out;
}

/**
 * A peer review: a fresh, read-only session in the owner's workspace.
 * It can read files and the web, and nothing else.
 */
const REVIEW_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];
export async function runReview({ cwd, prompt, system, model }) {
  if (MOCK) return mockReview();
  const q = query({
    prompt,
    options: {
      cwd, model: model || undefined, systemPrompt: system,
      tools: REVIEW_TOOLS, allowedTools: REVIEW_TOOLS, permissionMode: 'dontAsk',
      settingSources: ['user'], maxTurns: 30, hooks: moneyHooks(null), ...CLAUDE_PATH,
    },
  });
  let text = '', costUsd = 0;
  for await (const m of q) {
    noteRateLimit(m);
    if (m.type === 'assistant') { for (const b of m.message?.content || []) if (b.type === 'text') text = b.text; }
    else if (m.type === 'result') { if (m.result) text = m.result; costUsd = m.total_cost_usd || 0; }
  }
  return { text, costUsd };
}

// ---------------------------------------------------------------- mock mode
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MOCK_TOOLS = [
  ['Read', { file_path: 'src/index.js' }], ['Grep', { pattern: 'TODO' }],
  ['Edit', { file_path: 'src/app.js' }], ['Bash', { command: 'npm test' }],
  ['WebSearch', { query: 'best practices' }], ['Write', { file_path: 'notes.md' }],
];

async function mockTurn({ prompt, resume, onInit, onText, onTool, canUseTool, abortController, hooks, onMockReact }) {
  const sessionId = resume || `mock-${Math.random().toString(36).slice(2, 10)}`;
  onInit?.({ session_id: sessionId });
  await sleep(800);
  onMockReact?.();
  const said = promptText(prompt);
  const pics = Array.isArray(prompt) ? prompt.filter(b => b.type === 'image').length : 0;
  onText?.(pics ? `Got your ${pics} image${pics > 1 ? 's' : ''}. On it: "${said.slice(0, 60)}"` : `On it: "${said.slice(0, 80)}"`);
  const steps = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < steps; i++) {
    if (abortController?.signal.aborted) return { result: 'Interrupted.', isError: true, costUsd: 0, sessionId };
    let [name, input] = MOCK_TOOLS[Math.floor(Math.random() * MOCK_TOOLS.length)];
    if (process.env.FORTRESS_MOCK_MONEY === '1' && i === 0) [name, input] = ['mcp__stripe__create_payment_link', { product: 'Bunker Pro', amount: 4900, currency: 'usd' }];
    // Run the real money gate exactly as the SDK would.
    const gate = hooks?.PreToolUse?.[0]?.hooks?.[0];
    if (gate) {
      const r = await gate({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input }, undefined, { signal: abortController?.signal });
      if (r?.hookSpecificOutput?.permissionDecision === 'deny') { onText?.(r.hookSpecificOutput.permissionDecisionReason); continue; }
    }
    if (name === 'Bash' && canUseTool && Math.random() < 0.3) {
      const r = await canUseTool(name, input, { signal: abortController?.signal });
      if (r.behavior === 'deny') { onText?.('Okay, skipping that command.'); continue; }
    }
    onTool?.(name, input);
    await sleep(1500 + Math.random() * 2000);
  }
  const result = Math.random() < 0.5
    ? 'Finished the step. Tests pass. Should I continue with the next part?'
    : 'I found two ways to do this and am not sure which one Jav prefers.';
  onText?.(result);
  return { result, isError: false, costUsd: 0.01, sessionId };
}

async function mockOneShot(prompt) {
  await sleep(700);
  if (/Jav says:/.test(prompt)) return 'Understood, Jav. I will pass that down the shafts.';
  const roll = Math.random();
  if (roll < 0.25) return JSON.stringify({ decision: 'done', note: 'goal met' });
  return roll < 0.75
    ? JSON.stringify({ decision: 'continue', instruction: 'Good work. Proceed with the next step and verify it.', note: 'routine progress', health: 'on_track' })
    : JSON.stringify({ decision: 'escalate', question: 'Two approaches are open and neither is covered by standing orders. Which does Jav want?' });
}

// Mock captain: understands a few phrases and calls the real fortress tools, so the UI is testable offline.
async function mockCaptain({ prompt, onTool }) {
  await sleep(600);
  const call = async (name, args) => {
    onTool?.(`mcp__fortress__${name}`, args);
    return mockTools[name]?.(args);
  };
  const text = String(prompt).split('Jav says:').pop().trim();
  const lower = text.toLowerCase();
  await call('react', { emoji: /thank|love/.test(lower) ? '❤️' : /fail|crash|broke|dead/.test(lower) ? '💀' : /\?/.test(text) ? '👍' : '👀' });
  let reply;
  const m = /(?:create|open|make|add)\b.*?(?:agent|room|survivor)\s*(?:called|named)?\s*([A-Z][\w-]*)?/i.exec(text);
  if (m && /create|open|make|add/i.test(lower)) {
    const name = m[1] || 'Scout';
    await call('create_agent', { name, goal: text, roomType: /research|read|find/i.test(text) ? 'library' : 'workshop' });
    reply = `Done. ${name} is moving into a new room now. I'll brief them and they'll report back to me.`;
  } else {
    const st = JSON.parse((await call('fortress_status', {}))?.content?.[0]?.text || '{}');
    const red = (st.agents || []).filter(a => a.status === 'needs_jav');
    reply = `${(st.agents || []).length} survivors on shift. ` + (red.length ? `${red.map(a => a.name).join(', ')} ${red.length > 1 ? 'are' : 'is'} waiting on you. ` : 'Nobody is blocked. ') + 'Everyone else is working. Want me to push anyone?';
  }
  return { text: reply, costUsd: 0.006, sessionId: 'mock-lidia' };
}
export const mockTools = {};

async function mockReview() {
  await sleep(2500);
  const score = 4 + Math.floor(Math.random() * 5);
  return { costUsd: 0.02, text: JSON.stringify({
    score, verdict: score >= 8 ? 'Strong, ship it after polish.' : 'Works, but a human would notice rough edges.',
    fixes: ['Tighten the empty and error states', 'Add a test for the main path', 'Use the frontend-design skill for spacing and type scale'],
    praise: 'Clear structure and honest reporting.', healthy: score >= 5,
  }) };
}
