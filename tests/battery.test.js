import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
process.env.FORTRESS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fort-battery-'));
const { store, checkSettings } = await import('../server/store.js');
const battery = await import('../server/battery.js');

const MIN = 60e3;
const HOUR = 3600e3;
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
// Each case gets its own three-hour slot, so the one-hour window never sees another case's samples.
const slot = (n) => T0 + n * 3 * HOUR;

test('no reading yet: nothing is held back', () => {
  assert.equal(battery.forecast(slot(0)).known, false);
  assert.equal(battery.holdBackNewWork(slot(0)), false);
});

test('a steady drain is projected to the hour and the floor', () => {
  const t = slot(1);
  battery.record({ level: 80, ts: t - 60 * MIN });   // 80% an hour ago
  battery.record({ level: 74, ts: t });              // 74% now: 6 points an hour
  const f = battery.forecast(t);
  assert.equal(f.ratePerHour, 6);
  assert.equal(f.projectedInHour, 68);
  assert.equal(f.minutesToFloor, 540, 'from 74% down to the 20% floor at 6 points an hour');
  assert.equal(f.state, 'ok');
  assert.equal(battery.holdBackNewWork(t), false);
});

test('the floor within the hour holds background work, and charging releases it', () => {
  const t = slot(2);
  battery.record({ level: 40, ts: t - 60 * MIN });
  battery.record({ level: 24, ts: t });               // 16 points an hour: floor (20) in 15 minutes
  const f = battery.forecast(t);
  assert.equal(f.minutesToFloor, 15);
  assert.equal(f.state, 'slow');
  assert.equal(battery.holdBackNewWork(t), true);
  assert.equal(battery.tight(t), true, 'peer reviews and polish rounds pause');
  battery.record({ level: 25, charging: true, ts: t + MIN });
  assert.equal(battery.holdBackNewWork(t + MIN), false, 'charging releases the hold');
});

test('a span shorter than ten minutes is not trusted for a rate', () => {
  const t = slot(3);
  battery.record({ level: 60, ts: t - 2 * MIN });
  battery.record({ level: 10, ts: t });
  assert.equal(battery.forecast(t).ratePerHour, null);
});

test('readings outside 0-100 are refused', () => {
  assert.throws(() => battery.record({ level: 140 }), /0 to 100/);
  assert.throws(() => battery.record({ level: 'low' }), /0 to 100/);
});

test('the floor is a setting and is validated', () => {
  assert.equal(checkSettings({ batteryFloor: 25 }), null);
  assert.ok(checkSettings({ batteryFloor: 2 }));
  assert.ok(checkSettings({ batteryFloor: 20.5 }));
  store.state.settings.batteryFloor = 50;
  assert.equal(battery.forecast(slot(4)).floor, 50);
});
