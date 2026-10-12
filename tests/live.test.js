import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fort-live-'));
process.env.FORTRESS_DATA = root;
const live = await import('../server/live.js');

// 1x1 transparent PNG padded so it passes the "real image" size floor
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(3000, 7)]);

test('status questions are recognized, orders are not', () => {
  for (const q of ['what are you doing?', 'status', "how's it going", 'any update?', 'are you stuck?', 'where are you at'])
    assert.ok(live.isStatusQuestion(q), q);
  for (const q of ['write the landing page', 'please add a footer and run the tests', 'a'.repeat(300) + ' what are you doing'])
    assert.ok(!live.isStatusQuestion(q), q.slice(0, 30));
});

test('status text is built from real state, never invented', () => {
  const t = live.statusText({ activity: 'building', curTool: { name: 'Write', text: 'index.html' }, steps: 3, turnStart: Date.now() - 40000,
    todos: [{ text: 'page', status: 'completed' }, { text: 'tests', status: 'in_progress' }], log: [{ role: 'jav', text: 'go' }, { role: 'tool', tool: 'Write', text: 'index.html' }] });
  assert.match(t, /building \(Write: index\.html\)/); assert.match(t, /3 steps/); assert.match(t, /✓ page · ▶ tests/); assert.match(t, /Just did: Write index\.html/);
});

test('images: only real images, size-capped, copied under unique names', () => {
  const src = path.join(root, 'shot.png'); fs.writeFileSync(src, png);
  const dir = path.join(root, 'up');
  const a = live.copyIn(dir, src), b = live.copyIn(dir, src);
  assert.notEqual(a.name, b.name); assert.equal(a.type, 'image/png'); assert.ok(fs.existsSync(path.join(dir, a.name)));
  const txt = path.join(root, 'x.txt'); fs.writeFileSync(txt, 'hi');
  assert.throws(() => live.copyIn(dir, txt), /only png/);
});

test('tool results: images found in content blocks and MCP shapes', () => {
  const b64 = png.toString('base64');
  assert.equal(live.extractImages([{ type: 'text', text: 'ok' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }]).length, 1);
  assert.equal(live.extractImages({ content: [{ type: 'image', data: b64, mimeType: 'image/jpeg' }] })[0].mime, 'image/jpeg');
  assert.equal(live.extractImages('plain text').length, 0);
  const saved = live.saveData(path.join(root, 'up2'), b64, 'image/png', 'browser snapshot');
  assert.ok(saved.name.endsWith('.png') && saved.sha);
});

test('new images made by a command are found, old and tiny ones are not', () => {
  const w = path.join(root, 'ws'); fs.mkdirSync(path.join(w, 'out'), { recursive: true });
  const old = path.join(w, 'old.png'); fs.writeFileSync(old, png); fs.utimesSync(old, 1, 1);
  fs.writeFileSync(path.join(w, 'tiny.png'), 'x');
  fs.writeFileSync(path.join(w, 'out', 'new.png'), png);
  const got = live.newImages(w, Date.now() - 5000).map(f => path.basename(f));
  assert.deepEqual(got, ['new.png']);
});

test('fresh start keeps setup, backs up the rest, and only runs once', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fort-reset-')); fs.mkdirSync(path.join(d, 'data'));
  fs.writeFileSync(path.join(d, 'data', 'state.json'), JSON.stringify({ settings: { chatColor: '#2f7de0' }, connectors: [{ id: 'c' }], sessions: [{ id: 's', name: 'Old', log: [], queue: [] }], projects: [{ id: 'p' }], precedents: [{}] }));
  const run = (code) => new Promise((res) => { import('node:child_process').then(({ execFileSync }) => res(execFileSync('node', ['--input-type=module', '-e', code], { env: { ...process.env, FORTRESS_DATA: d }, cwd: path.resolve('.') }).toString())); });
  const out = await run("const {store}=await import('./server/store.js'); store.flush(); console.log(JSON.stringify([store.state.sessions.length, store.state.projects.length, store.state.connectors.length, store.state.settings.chatColor, !!store.resetNote])); process.exit(0)");
  assert.equal(out.trim(), '[0,0,1,"#2f7de0",true]');
  const backups = fs.readdirSync(path.join(d, 'data', 'backups')); assert.equal(backups.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'data', 'backups', backups[0], 'state.json'))).sessions.length, 1);
  const again = await run("const {store}=await import('./server/store.js'); console.log(!!store.resetNote); process.exit(0)");
  assert.equal(again.trim(), 'false');
});
