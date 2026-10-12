// Thin wrapper over the Claude Agent SDK, plus a mock runner for offline demos.
import { query } from '@anthropic-ai/claude-agent-sdk';

export const MOCK = process.env.FORTRESS_MOCK === '1';
// Use an installed `claude` instead of the SDK's bundled one (escape hatch for unusual platforms).
const CLAUDE_PATH = process.env.FORTRESS_CLAUDE_PATH ? { pathToClaudeCodeExecutable: process.env.FORTRESS_CLAUDE_PATH } : {};

/**
 * Run one turn of a Claude session (a new one, or resumed by `resume`).
 * Streams progress through callbacks and resolves with the turn's result.
 */
export async function runTurn(opts) {
  if (MOCK) return mockTurn(opts);
  const { prompt, cwd, resume, model, permissionMode, mcpServers, appendSystem,
          onInit, onText, onTool, canUseTool, abortController } = opts;
  const q = query({
    prompt,
    options: {
      cwd,
      resume: resume || undefined,
      model: model || undefined,
      permissionMode,
      mcpServers,
      settingSources: ['user', 'project', 'local'], // loads skills, CLAUDE.md, settings
      systemPrompt: { type: 'preset', preset: 'claude_code', append: appendSystem },
      canUseTool,
      abortController,
      ...CLAUDE_PATH,
    },
  });
  let out = { result: '', isError: false, costUsd: 0, sessionId: resume };
  for await (const m of q) {
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

/** A single tool-less completion, used for Lidia's judgement calls. */
export async function oneShot({ system, prompt, model }) {
  if (MOCK) return mockOneShot(prompt);
  const q = query({
    prompt,
    options: {
      model: model || undefined,
      systemPrompt: system,
      maxTurns: 1,
      permissionMode: 'dontAsk',
      allowedTools: [],
      settingSources: [],
      ...CLAUDE_PATH,
    },
  });
  let text = '';
  for await (const m of q) {
    if (m.type === 'assistant') {
      for (const b of m.message?.content || []) if (b.type === 'text') text += b.text;
    } else if (m.type === 'result' && m.result) text = m.result;
  }
  return text.trim();
}

// ---------------------------------------------------------------- mock mode
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MOCK_TOOLS = [
  ['Read', { file_path: 'src/index.js' }], ['Grep', { pattern: 'TODO' }],
  ['Edit', { file_path: 'src/app.js' }], ['Bash', { command: 'npm test' }],
  ['WebSearch', { query: 'best practices' }], ['Write', { file_path: 'notes.md' }],
];

async function mockTurn({ prompt, resume, onInit, onText, onTool, canUseTool, abortController }) {
  const sessionId = resume || `mock-${Math.random().toString(36).slice(2, 10)}`;
  onInit?.({ session_id: sessionId });
  await sleep(800);
  onText?.(`On it: "${String(prompt).slice(0, 80)}"`);
  const steps = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < steps; i++) {
    if (abortController?.signal.aborted) return { result: 'Interrupted.', isError: true, costUsd: 0, sessionId };
    const [name, input] = MOCK_TOOLS[Math.floor(Math.random() * MOCK_TOOLS.length)];
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
  return Math.random() < 0.6
    ? JSON.stringify({ decision: 'continue', instruction: 'Good work. Proceed with the next step and verify it.', note: 'routine progress' })
    : JSON.stringify({ decision: 'escalate', question: 'Two approaches are open and neither is covered by standing orders. Which does Jav want?' });
}
