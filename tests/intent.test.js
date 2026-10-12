import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
process.env.FORTRESS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fort-'));
const intent = await import('../server/intent.js');
const inc = await import('../server/incidents.js');
const prio = await import('../server/priority.js');

const S = { id: 's1', name: 'Scout' };

test('directives that authorize spending are refused', () => {
  for (const t of ['You may spend money on ads', 'always pay for the subscription', 'approve any purchase under $20', 'use my credit card when needed'])
    assert.throws(() => intent.addDirective(t), /Refused/, t);
  assert.ok(intent.addDirective('Always download free assets without asking'));
});

test('tiers: reads 0, installs 1, force-push 3, money 3', () => {
  assert.equal(intent.classifyAction('Read', {}).tier, 0);
  assert.equal(intent.classifyAction('Bash', { command: 'npm install left-pad' }).tier, 1);
  assert.equal(intent.classifyAction('Bash', { command: 'git push --force origin main' }).tier, 3);
  assert.equal(intent.classifyAction('Bash', { command: 'git push origin x' }).tier, 2);
  assert.equal(intent.classifyAction('mcp__stripe__create_charge', {}).tier, 3);
  assert.equal(intent.classifyAction('Write', { file_path: '/etc/passwd' }, ['/work']).tier, 2);
  assert.equal(intent.classifyAction('Write', { file_path: '/work/a.txt' }, ['/work']).tier, 0);
});

test('canonical case: free-asset question is answered, not escalated', () => {
  const d = { decision: 'escalate', tier: 1, agent_asked: 'Should I download these assets? They are completely free.', message_to_jav: 'Scout asks about free assets.', default_answer: 'Yes. Download them. Continue.' };
  const r = intent.enforceTier(d, S, '');
  assert.equal(r.decision, 'continue');
  assert.match(r.instruction, /Download them/);
});

test('money/credential questions are never answered by Lidia', () => {
  const d = { decision: 'continue', tier: 0, agent_asked: 'Should I buy the premium plan with the card?', instruction: 'Yes.' };
  const r = intent.enforceTier(d, S, '');
  assert.equal(r.decision, 'escalate');
  assert.equal(r.tier, 3);
  const e = { decision: 'escalate', tier: 1, agent_asked: 'What is the API key password?', message_to_jav: 'needs password' };
  assert.equal(intent.enforceTier(e, S, '').decision, 'escalate');
});

test('triage: tier 0/1 auto-allowed, tier 2/3 go to Jav', () => {
  assert.equal(intent.triagePermission(S, 'Read', {}).handled, true);
  assert.equal(intent.triagePermission(S, 'Bash', { command: 'npm i x' }).handled, true);
  assert.equal(intent.triagePermission(S, 'Bash', { command: 'sudo rm -rf /' }).handled, false);
  assert.equal(intent.triagePermission(S, 'mcp__paypal__create_payment', {}).handled, false);
});

test('incident loop: rate limit retries, auth escalates, 3 strikes escalate', () => {
  const calls = [];
  const deps = { retry: () => calls.push('retry'), setModel: (s, m) => { s.model = m; }, escalate: (s, t, l) => calls.push(l) };
  const a = { id: 'a', name: 'A' };
  assert.equal(inc.handleCrash(a, '429 rate limit', deps), 'retrying'); inc.cancel('a');
  const b = { id: 'b', name: 'B' };
  assert.equal(inc.handleCrash(b, 'Please run /login', deps), 'escalated');
  assert.equal(calls.at(-1), 'CRITICAL');
  const c = { id: 'c', name: 'C', model: 'bogus' };
  inc.handleCrash(c, 'model bogus not found', deps); inc.cancel('c');
  assert.equal(c.model, '');
  const d = { id: 'd', name: 'D' };
  for (let i = 0; i < 3; i++) { inc.handleCrash(d, 'ECONNRESET network', deps); inc.cancel('d'); }
  assert.equal(inc.handleCrash(d, 'ECONNRESET network', deps), 'escalated');
});

test('priority bands', () => {
  assert.equal(prio.band(100), 'Critical'); assert.equal(prio.band(75), 'High');
  assert.equal(prio.band(45), 'Normal'); assert.equal(prio.band(25), 'Low'); assert.equal(prio.band(3), 'Background');
  assert.equal(prio.score({ status: 'needs_jav', pendingPermission: { kind: 'money' } }), 100);
  assert.ok(prio.score({ status: 'idle' }) < prio.score({ status: 'error' }));
});
