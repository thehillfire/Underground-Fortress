import test from 'node:test';
import assert from 'node:assert/strict';
import * as pool from '../server/pool.js';

const tick = () => new Promise(r => setImmediate(r));

test('the cap holds for every caller, and the next in line gets the freed place', async () => {
  pool.setCap(() => 2);
  assert.equal(await pool.take(), true);
  assert.equal(await pool.take(), true);
  let third = false;
  const waiting = pool.take().then(ok => { third = ok; });
  await tick();
  assert.equal(third, false, 'a third caller waits while two are running');
  assert.equal(pool.info().waiting, 1);
  pool.give();
  await waiting;
  assert.equal(third, true);
  pool.give(); pool.give();
  assert.equal(pool.info().active, 0);
});

test('a higher priority jumps the line, equal priority keeps arrival order', async () => {
  pool.setCap(() => 1);
  assert.equal(await pool.take(), true);
  const order = [];
  const a = pool.take({ priority: 0 }).then(() => order.push('agent'));
  const b = pool.take({ priority: 2 }).then(() => order.push('captain'));
  const c = pool.take({ priority: 0 }).then(() => order.push('agent2'));
  await tick();
  pool.give(); await b;     // captain (priority 2) is next
  pool.give(); await a;     // then the first agent to have queued
  pool.give(); await c;     // then the second
  assert.deepEqual(order, ['captain', 'agent', 'agent2']);
  pool.give();
});

test('a waiter that is stopped leaves the line and reports it', async () => {
  pool.setCap(() => 1);
  assert.equal(await pool.take(), true);
  const ac = new AbortController();
  const stopped = pool.take({ signal: ac.signal });
  ac.abort();
  assert.equal(await stopped, false);
  assert.equal(pool.info().waiting, 0);
  pool.give();
});

test('lane runs a call inside a place and gives the place back, even when the call throws', async () => {
  pool.setCap(() => 1);
  await assert.rejects(pool.lane(0, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(pool.info().active, 0);
  assert.equal(await pool.lane(0, async () => 'ok'), 'ok');
});
