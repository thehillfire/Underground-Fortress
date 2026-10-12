import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
process.env.FORTRESS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fort-guard-'));
const { moneyCheck, moneyHooks } = await import('../server/guard.js');
const { store } = await import('../server/store.js');
const prio = await import('../server/priority.js');

test('money gate: spending actions are caught, reads are not', () => {
  assert.ok(moneyCheck('mcp__stripe__create_charge', { amount: 100 }));
  assert.ok(moneyCheck('mcp__shop__place_order', {}));
  assert.ok(moneyCheck('Bash', { command: 'curl https://api.stripe.com/v1/charges -d amount=1' }));
  assert.ok(moneyCheck('mcp__x__anything', { note: 'card 4111 1111 1111 1111' }));
  assert.ok(moneyCheck('mcp__browser__click', { text: 'Place your order' }));
  assert.equal(moneyCheck('mcp__stripe__list_charges', {}), null);
  assert.equal(moneyCheck('Read', { file_path: '/x' }), null);
  assert.equal(moneyCheck('Bash', { command: 'npm test' }), null);
});

test('money hook denies when nobody approves, allows only on explicit approval', async () => {
  const run = (cb) => moneyHooks(cb).PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'mcp__paypal__create_payment', tool_input: {} });
  assert.equal((await run(undefined)).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await run(async () => false)).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await run(async () => true)).hookSpecificOutput.permissionDecision, 'allow');
  const safe = await moneyHooks(undefined).PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} });
  assert.deepEqual(safe, {});
});

test('escalation queue ranks money first, then blocks, crashes, interruptions', () => {
  store.state.sessions.push(
    { id: 'm', name: 'Money', status: 'needs_jav', pendingPermission: { kind: 'money', reason: 'a payment', tool: 'x' }, log: [] },
    { id: 'q', name: 'Ask', status: 'needs_jav', pendingQuestion: 'which logo?', escalation: { level: 'BLOCK', text: 'which logo?', ts: 1 }, log: [] },
    { id: 'c', name: 'Crash', status: 'error', crash: { reason: 'boom' }, log: [] },
    { id: 'i', name: 'Cut', status: 'idle', interrupted: true, log: [] });
  const e = prio.escalations();
  assert.deepEqual(e.map(x => x.level), ['CRITICAL', 'BLOCK', 'WARN', 'INFO']);
  assert.equal(prio.priorities()[0].id, 'm');
});
