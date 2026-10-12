// The underground world: layout, camera, characters and rendering.
import { art } from './assets.js';

export const ROOM_W = 480, ROOM_H = 270, SHAFT_W = 96, SLAB = 22, TOP = 70;
const CHAR_H = 100, LIDIA_H = 92; // Lidia is petite // on-screen heights; sprites scale by whole pixels to about this
const ZOMBIE_Y = -12;

const ROOM_TINT = { workshop: '#3b3a3f', library: '#38353a', server: '#2c3138', lab: '#2b3533', command: '#3d2f31' };
const FONT = '"Silkscreen", "VT323", monospace';
const BODY_FONT = '"VT323", monospace';
const ROOM_LABEL = { workshop: 'Workshop', library: 'Archive', server: 'Reactor', lab: 'Bio Lab' };

const cam = { x: 0, y: 260, zoom: 0.9 };
let canvas, ctx, dpr = 1;
let state = null;
let selected = null;           // session id or 'lidia'
const chars = new Map();       // session id -> entity
const lidia = { id: 'lidia', x: 0, y: 0, tx: 0, level: 0, dir: -1, bubble: null, t: 0, pause: 0, path: [] };
let handlers = {};
let roomRects = [];            // for hit testing
const zombies = Array.from({ length: 9 }, (_, i) => ({
  x: -1150 + i * 270 + Math.random() * 120, y: ZOMBIE_Y, dir: Math.random() < 0.5 ? -1 : 1,
  t: Math.random() * 10, pause: Math.random() * 4, speed: 10 + Math.random() * 14, walking: false,
}));

// ------------------------------------------------------------------ layout
function levelTop(level) { return TOP + level * (ROOM_H + SLAB); }
function floorY(level) { return levelTop(level) + ROOM_H - 14; }
function slotRect(i) {
  const level = 1 + Math.floor(i / 2);
  const right = i % 2 === 1;
  const x = right ? SHAFT_W / 2 : -SHAFT_W / 2 - ROOM_W;
  return { x, y: levelTop(level), w: ROOM_W, h: ROOM_H, level, right };
}
const BRIDGE = { x: SHAFT_W / 2, y: levelTop(0), w: ROOM_W, h: ROOM_H, level: 0, right: true };
const COMMS = { x: -SHAFT_W / 2 - ROOM_W, y: levelTop(0), w: ROOM_W, h: ROOM_H, level: 0, right: false };
function roomInner(r) { return { x0: r.x + 40, x1: r.x + r.w - 40 }; }
const doorX = (r) => (r.right ? r.x + 18 : r.x + r.w - 18);

// ------------------------------------------------------------------ public API
export function initGame(cv, h) {
  canvas = cv; ctx = cv.getContext('2d'); handlers = h;
  resize(); addEventListener('resize', resize);
  // Phones: fit one room plus the shaft across the screen.
  if (cv.clientWidth < 700) cam.zoom = cv.clientWidth / (ROOM_W + SHAFT_W + 60);
  bindInput();
  lidia.x = BRIDGE.x + BRIDGE.w * 0.6; lidia.y = floorY(0); lidia.tx = lidia.x;
  requestAnimationFrame(frame);
}

export function setState(st) {
  state = st;
  const ids = new Set(st.sessions.map(s => s.id));
  for (const id of chars.keys()) if (!ids.has(id)) chars.delete(id);
  st.sessions.forEach((s, i) => {
    const r = slotRect(i);
    let e = chars.get(s.id);
    if (!e) {
      const inner = roomInner(r);
      e = { id: s.id, x: inner.x0 + Math.random() * (inner.x1 - inner.x0), y: floorY(r.level), tx: 0, dir: 1,
            level: r.level, path: [], pause: Math.random() * 2, t: Math.random() * 10, bubble: null, home: i, away: false };
      e.tx = e.x;
      chars.set(s.id, e);
    }
    e.home = i;
    e.session = s;
    // Head back home when a report is over.
    if (e.away && s.status !== 'reporting') goHome(e);
  });
}

export function select(id) { selected = id; }

export function bubble(msg) {
  const ttl = Math.min(9000, 2500 + (msg.text || '').length * 45);
  if (msg.who === 'lidia' || msg.who === 'lidia-thinking') {
    lidia.bubble = { text: msg.who === 'lidia-thinking' ? '…' : msg.text, until: performance.now() + ttl, lidia: true };
  } else {
    const e = chars.get(msg.sessionId);
    if (e) e.bubble = { text: msg.text, until: performance.now() + ttl };
  }
}

/** Walk the dweller up the shaft to the bridge to report. */
export function report(sessionId) {
  const e = chars.get(sessionId);
  if (!e || e.away) return;
  const r = slotRect(e.home);
  const shaftX = 0;
  e.away = true;
  e.path = [
    { x: doorX(r), level: r.level }, { x: shaftX, level: r.level, shaft: true },
    { x: shaftX, level: 0, shaft: true }, { x: BRIDGE.x + 30, level: 0 },
    { x: lidia.x - 60 - Math.random() * 40, level: 0 },
  ];
}

function goHome(e) {
  e.away = false;
  const r = slotRect(e.home);
  const inner = roomInner(r);
  const spot = { x: inner.x0 + Math.random() * (inner.x1 - inner.x0), level: r.level };
  const door = { x: doorX(r), level: r.level };
  if (e.inShaft) e.path = [{ x: 0, level: r.level, shaft: true }, door, spot];
  else if (e.level === r.level) e.path = [spot];
  else e.path = [{ x: 0, level: e.level, shaft: true }, { x: 0, level: r.level, shaft: true }, door, spot];
}

let fly = null;  // camera animation in progress
/** Smoothly move the camera to someone (same framing as focusOn). */
export function flyTo(id, insetBottom = 0) {
  const from = { x: cam.x, y: cam.y };
  focusOn(id, insetBottom);
  const to = { x: cam.x, y: cam.y };
  cam.x = from.x; cam.y = from.y;
  fly = { from, to, t0: performance.now(), dur: 650 };
}

/** Center on someone. `insetBottom` (screen px) keeps them above an open bottom sheet. */
export function focusOn(id, insetBottom = 0) {
  const shift = insetBottom / 2 / cam.zoom;
  if (id === 'lidia') { cam.x = BRIDGE.x + BRIDGE.w / 2; cam.y = BRIDGE.y + ROOM_H / 2 + shift; return; }
  const e = chars.get(id);
  if (e) { cam.x = e.x; cam.y = e.y - ROOM_H / 2 + 20 + shift; }
}

export function zoomBy(f) { cam.zoom = Math.max(0.25, Math.min(2.5, cam.zoom * f)); }

// ------------------------------------------------------------------ input
function resize() {
  dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
}

function toWorld(sx, sy) {
  return { x: (sx - canvas.clientWidth / 2) / cam.zoom + cam.x, y: (sy - canvas.clientHeight / 2) / cam.zoom + cam.y };
}

function bindInput() {
  let drag = null;
  const pointers = new Map();
  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    fly = null;
    drag = { x: ev.clientX, y: ev.clientY, cx: cam.x, cy: cam.y, moved: false, pinch: null };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      drag.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: cam.zoom };
    }
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!drag) { canvas.style.cursor = hitTest(ev.offsetX, ev.offsetY) ? 'pointer' : 'grab'; return; }
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (drag.pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      cam.zoom = Math.max(0.25, Math.min(2.5, drag.pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / drag.pinch.d));
      drag.moved = true;
      return;
    }
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
    cam.x = drag.cx - dx / cam.zoom; cam.y = drag.cy - dy / cam.zoom;
    canvas.style.cursor = 'grabbing';
  });
  const end = (ev) => {
    pointers.delete(ev.pointerId);
    if (drag && !drag.moved && pointers.size === 0) {
      const hit = hitTest(ev.offsetX, ev.offsetY);
      if (hit) handlers.onPick?.(hit);
    }
    if (pointers.size === 0) drag = null;
    canvas.style.cursor = 'grab';
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const before = toWorld(ev.offsetX, ev.offsetY);
    cam.zoom = Math.max(0.25, Math.min(2.5, cam.zoom * Math.exp(-ev.deltaY * 0.0015)));
    const after = toWorld(ev.offsetX, ev.offsetY);
    cam.x += before.x - after.x; cam.y += before.y - after.y;
  }, { passive: false });
}

function hitTest(sx, sy) {
  const p = toWorld(sx, sy);
  const near = (e, h) => Math.abs(p.x - e.x) < 34 && p.y < e.y + 6 && p.y > e.y - h;
  if (near(lidia, LIDIA_H)) return { kind: 'lidia' };
  for (const e of chars.values()) if (near(e, CHAR_H)) return { kind: 'session', id: e.id };
  for (const r of roomRects) if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return r.hit;
  return null;
}

// ------------------------------------------------------------------ simulation
function step(e, dt, speed) {
  e.t += dt;
  if (e.path.length) {
    const wp = e.path[0];
    const ty = floorY(wp.level);
    e.inShaft = !!wp.shaft && Math.abs(e.x - wp.x) <= 2;
    if (Math.abs(e.x - wp.x) > 2) {
      const d = Math.sign(wp.x - e.x);
      e.dir = d;
      e.x += d * Math.min(Math.abs(wp.x - e.x), speed * dt);
      e.walking = true;
    } else if (Math.abs(e.y - ty) > 2) {
      e.y += Math.sign(ty - e.y) * Math.min(Math.abs(ty - e.y), 260 * dt);
      e.walking = false;
    } else {
      e.x = wp.x; e.y = ty; e.level = wp.level;
      e.path.shift();
      if (!e.path.length) e.inShaft = false;
    }
    return;
  }
  e.walking = false;
  e.pause -= dt;
  if (e.pause > 0) return;
  // Wander inside the room.
  const r = e === lidia ? BRIDGE : slotRect(e.home);
  if (e.away) return;
  const inner = roomInner(r);
  const target = inner.x0 + Math.random() * (inner.x1 - inner.x0);
  e.path = [{ x: target, level: r.level }];
  const s = e.session;
  const busy = s && s.status === 'working';
  e.pause = busy ? 0.6 + Math.random() * 1.6 : 2 + Math.random() * 5;
}

// ------------------------------------------------------------------ rendering
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (fly) {
    const k = Math.min(1, (now - fly.t0) / fly.dur), e = 1 - Math.pow(1 - k, 3);
    cam.x = fly.from.x + (fly.to.x - fly.from.x) * e;
    cam.y = fly.from.y + (fly.to.y - fly.from.y) * e;
    if (k >= 1) fly = null;
  }
  step(lidia, dt, 60);
  for (const z of zombies) {
    z.t += dt;
    z.pause -= dt;
    if (z.pause > 0) { z.walking = false; continue; }
    z.walking = true;
    z.x += z.dir * z.speed * dt;
    // shamble back and forth, bunching up around the hatch
    if (Math.abs(z.x) > 1250 || Math.random() < dt * 0.08) { z.dir *= -1; z.pause = 1 + Math.random() * 4; }
    if (Math.abs(z.x) < 70 && Math.random() < dt * 0.5) { z.dir = -Math.sign(z.x) || 1; z.pause = 2 + Math.random() * 3; }
  }
  for (const e of chars.values()) {
    const s = e.session;
    const still = s && (s.status === 'done' || s.status === 'needs_jav') && !e.path.length && !e.away;
    if (!still) step(e, dt, s?.status === 'working' || e.away ? 120 : 55);
    else e.t += dt;
  }
  draw(now);
  requestAnimationFrame(frame);
}

function draw(now) {
  const W = canvas.width, H = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0b0a0c';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, W / 2 - cam.x * cam.zoom * dpr, H / 2 - cam.y * cam.zoom * dpr);

  const n = state ? state.sessions.length : 0;
  const levels = 1 + Math.ceil((n + 1) / 2);
  const bottom = levelTop(levels) + 200;

  drawEarth(bottom);
  drawSurface();
  for (const z of zombies) drawZombie(z, now);
  drawShaft(bottom - 200);

  roomRects = [];
  drawRoom(COMMS, 'server', 'COMMS / ARMORY', { kind: 'tab', tab: 'connectors' }, null, now);
  drawRoom(BRIDGE, 'command', 'COMMAND', { kind: 'lidia' }, selected === 'lidia' ? '#d8dde3' : null, now);
  if (state) {
    state.sessions.forEach((s, i) => {
      const alert = s.status === 'needs_jav';
      const glow = alert ? (Math.floor(now / 350) % 2 ? '#ff2a1a' : '#5a0a06') : s.id === selected ? '#d8dde3' : null;
      drawRoom(slotRect(i), s.roomType, `${s.name.toUpperCase()} / ${(ROOM_LABEL[s.roomType] || s.roomType).toUpperCase()}`, { kind: 'session', id: s.id }, glow, now, alert);
    });
    drawDig(slotRect(n));
  }

  const lAnim = lidia.walking ? 'walk' : lidia.bubble && now < lidia.bubble.until ? 'command' : 'idle';
  drawCharacter(lidia, art.chars.lidia, lAnim, LIDIA_H, { name: 'CPT. LIDIA', color: '#ff5a4a', now, isLidia: true });
  for (const e of chars.values()) {
    const s = e.session;
    if (!s) continue;
    const alert = s.status === 'needs_jav';
    const anim = alert && !e.walking ? 'panic' : e.walking ? 'walk' : s.status === 'working' ? 'work' : 'rest';
    drawCharacter(e, alert ? art.chars.survivorRed : art.chars.survivor, anim, CHAR_H, {
      name: s.name.toUpperCase(), color: `hsl(${s.hue},45%,70%)`, now, alert, done: s.status === 'done',
      working: s.status === 'working', activity: s.activity, selected: s.id === selected,
    });
  }
}

function drawEarth(bottom) {
  const x0 = -4000, x1 = 4000, y1 = bottom + 3000;
  if (art.dirt) {
    ctx.save();
    ctx.scale(4, 4);
    ctx.fillStyle = ctx.createPattern(art.dirt, 'repeat');
    ctx.fillRect(x0 / 4, 0, (x1 - x0) / 4, y1 / 4);
    ctx.restore();
  } else {
    ctx.fillStyle = '#16131a';
    ctx.fillRect(x0, 0, x1 - x0, y1);
    // Blocky rock strata
    for (let i = 0; i < 900; i++) {
      const x = x0 + ((i * 7919) % (x1 - x0)), y = (i * 104729) % y1;
      const w = 8 + (i % 5) * 8, h = 8 + (i % 3) * 4;
      ctx.fillStyle = i % 7 === 0 ? '#2a2328' : i % 3 ? '#1d1a20' : '#211c22';
      ctx.fillRect(Math.round(x / 4) * 4, Math.round(y / 4) * 4, w, h);
    }
  }
  // Depth darkening
  const g = ctx.createLinearGradient(0, 0, 0, y1);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.7)');
  ctx.fillStyle = g; ctx.fillRect(x0, 0, x1 - x0, y1);
}

function drawSurface() {
  const w = 2560;
  if (art.surface) {
    const h = w * art.surface.height / art.surface.width;
    ctx.fillStyle = '#07080b'; ctx.fillRect(-4000, -h - 2000, 8000, h + 2000);
    ctx.drawImage(art.surface, -w / 2, -h + 6, w, h);
  } else {
    // Drawn fallback: a ruined city at night, smoke and fire.
    const h = 900, now = performance.now();
    const sky = ctx.createLinearGradient(0, -h, 0, 0);
    sky.addColorStop(0, '#07060a'); sky.addColorStop(0.6, '#1c0a0b'); sky.addColorStop(1, '#3a120c');
    ctx.fillStyle = '#07060a'; ctx.fillRect(-4000, -h - 2000, 8000, 2000);
    ctx.fillStyle = sky; ctx.fillRect(-4000, -h, 8000, h);
    ctx.fillStyle = '#c9c2b0'; ctx.fillRect(820, -h + 120, 36, 36); ctx.fillStyle = '#1c0a0b'; ctx.fillRect(838, -h + 114, 24, 30);
    // skyline: broken towers with a few lit windows
    for (let x = -4000, i = 0; x < 4000; i++) {
      const w = 90 + (i * 37) % 120, bh = 160 + (i * 97) % 300;
      ctx.fillStyle = i % 2 ? '#0d0b0f' : '#120f14';
      ctx.fillRect(x, -40 - bh, w, bh);
      ctx.fillStyle = '#07060a'; ctx.fillRect(x + w * 0.6, -40 - bh, w * 0.4, 20 + (i * 13) % 40); // collapsed corner
      for (let wy = -40 - bh + 30; wy < -60; wy += 26) for (let wx = x + 10; wx < x + w - 14; wx += 22)
        if ((wx * 7 + wy * 3 + i) % 23 === 0) { ctx.fillStyle = '#6a3a14'; ctx.fillRect(wx, wy, 8, 10); }
      x += w + 10;
    }
    // smoke columns
    for (const sx of [-900, 300, 1500]) {
      for (let k = 0; k < 10; k++) {
        ctx.fillStyle = `rgba(40,30,30,${0.35 - k * 0.03})`;
        const o = Math.sin(now / 1500 + k + sx) * 14;
        ctx.fillRect(sx + o - 20 - k * 4, -120 - k * 40, 40 + k * 8, 40);
      }
    }
    // street, wrecked cars, barricades
    ctx.fillStyle = '#1b1715'; ctx.fillRect(-4000, -40, 8000, 40);
    for (const cx of [-1100, -520, 640, 1180]) {
      ctx.fillStyle = '#2a1e1a'; ctx.fillRect(cx, -70, 110, 30); ctx.fillRect(cx + 20, -92, 60, 24);
      ctx.fillStyle = '#0a0809'; ctx.fillRect(cx + 10, -44, 22, 8); ctx.fillRect(cx + 78, -44, 22, 8);
    }
    for (const bx of [-260, 160]) {
      ctx.fillStyle = '#4a3420'; for (let k = 0; k < 4; k++) ctx.fillRect(bx, -48 - k * 14, 100, 10);
      ctx.fillStyle = '#5a5040'; ctx.fillRect(bx + 10, -100, 12, 60); ctx.fillRect(bx + 78, -100, 12, 60);
    }
    // burning barrels
    for (const fx of [-380, 420, 980]) {
      ctx.fillStyle = '#3a2a22'; ctx.fillRect(fx, -78, 30, 38);
      const fl = Math.floor(now / 120 + fx) % 3;
      ctx.fillStyle = '#ff7a1a'; ctx.fillRect(fx + 4, -96 - fl * 3, 22, 20 + fl * 3);
      ctx.fillStyle = '#ffd04a'; ctx.fillRect(fx + 10, -90 - fl * 2, 10, 12);
      ctx.fillStyle = 'rgba(255,110,30,0.10)'; ctx.fillRect(fx - 80, -200, 190, 160);
    }
    // hatch + headframe
    ctx.fillStyle = '#3a3f46'; ctx.fillRect(-70, -60, 140, 20);
    ctx.fillStyle = '#2a2e33'; ctx.fillRect(-56, -220, 12, 160); ctx.fillRect(44, -220, 12, 160); ctx.fillRect(-56, -228, 112, 12);
    const on = Math.floor(now / 600) % 2;
    ctx.fillStyle = on ? '#ff2a1a' : '#4a0a06'; ctx.fillRect(-6, -244, 12, 12);
  }
  ctx.fillStyle = '#0e0c0f';
  ctx.fillRect(-4000, 0, 8000, 10);
}

/** Seeded blood smears, drips and grime so every room looks like it survived something. */
function grime(r) {
  let seed = Math.abs(Math.floor(r.x * 7 + r.y * 13)) + 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const snap = (v) => Math.round(v / 3) * 3;
  // smear on the floor
  const fx = r.x + 40 + rnd() * (r.w - 140), fy = r.y + r.h - 10;
  ctx.fillStyle = 'rgba(70,4,6,0.85)';
  for (let i = 0; i < 14; i++) ctx.fillRect(snap(fx + rnd() * 90), snap(fy - rnd() * 6), 3 + snap(rnd() * 12), 3);
  // wall splatter with drips
  if (rnd() < 0.8) {
    const wx = r.x + 30 + rnd() * (r.w - 80), wy = r.y + 50 + rnd() * (r.h * 0.4);
    ctx.fillStyle = 'rgba(95,6,8,0.8)';
    for (let i = 0; i < 10; i++) ctx.fillRect(snap(wx + rnd() * 30 - 15), snap(wy + rnd() * 18 - 9), 3 + snap(rnd() * 6), 3 + snap(rnd() * 3));
    for (let i = 0; i < 3; i++) ctx.fillRect(snap(wx + rnd() * 24 - 12), snap(wy), 3, 9 + snap(rnd() * 30));
  }
  // claw marks
  if (rnd() < 0.5) {
    const cx = r.x + 30 + rnd() * (r.w - 60), cy = r.y + 40 + rnd() * 60;
    ctx.fillStyle = 'rgba(10,8,9,0.75)';
    for (let k = 0; k < 3; k++) for (let j = 0; j < 8; j++) ctx.fillRect(snap(cx + k * 9 + j * 2), snap(cy + j * 5), 3, 3);
  }
  // grime at the base of the walls
  ctx.fillStyle = 'rgba(20,16,10,0.35)';
  for (let x = r.x; x < r.x + r.w; x += 6) ctx.fillRect(x, r.y + r.h - 6 - snap(rnd() * 12), 6, 18);
}

function hazard(x, y, w, h) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = '#c9a227'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#141214';
  for (let i = -h; i < w + h; i += 16) { ctx.beginPath(); ctx.moveTo(x + i, y + h); ctx.lineTo(x + i + 8, y + h); ctx.lineTo(x + i + 8 + h, y); ctx.lineTo(x + i + h, y); ctx.fill(); }
  ctx.restore();
}

function drawShaft(bottom) {
  ctx.fillStyle = '#0f0e11';
  ctx.fillRect(-SHAFT_W / 2, 0, SHAFT_W, bottom);
  ctx.fillStyle = '#25232a';
  ctx.fillRect(-SHAFT_W / 2, 0, 8, bottom); ctx.fillRect(SHAFT_W / 2 - 8, 0, 8, bottom);
  // guide rails & cross bracing
  ctx.fillStyle = '#34313a';
  ctx.fillRect(-SHAFT_W / 2 + 14, 0, 4, bottom); ctx.fillRect(SHAFT_W / 2 - 18, 0, 4, bottom);
  for (let y = 0; y < bottom; y += 48) {
    ctx.fillStyle = '#1c1a20'; ctx.fillRect(-SHAFT_W / 2 + 8, y, SHAFT_W - 16, 4);
  }
  // cables
  ctx.fillStyle = '#0a090b'; ctx.fillRect(-6, 0, 3, bottom); ctx.fillRect(4, 0, 3, bottom);
  for (let l = 0; levelTop(l) < bottom; l++) hazard(-SHAFT_W / 2, levelTop(l) + ROOM_H, SHAFT_W, SLAB);
  // barricaded hatch at the top of the shaft
  ctx.save();
  for (const [dy, rot] of [[-30, -0.12], [-18, 0.1], [-6, -0.05]]) {
    ctx.save(); ctx.translate(0, dy); ctx.rotate(rot);
    ctx.fillStyle = '#4a3420'; ctx.fillRect(-SHAFT_W / 2 - 22, -5, SHAFT_W + 44, 10);
    ctx.fillStyle = '#2c1e12'; ctx.fillRect(-SHAFT_W / 2 - 22, 3, SHAFT_W + 44, 2);
    ctx.fillStyle = '#8a8a8a'; ctx.fillRect(-SHAFT_W / 2 - 16, -2, 3, 3); ctx.fillRect(SHAFT_W / 2 + 12, -2, 3, 3);
    ctx.restore();
  }
  ctx.fillStyle = 'rgba(95,6,8,0.85)'; ctx.fillRect(-20, -34, 9, 30); ctx.fillRect(-14, -8, 3, 14);
  ctx.restore();
}

function drawRoom(r, type, label, hit, glow, now = 0, alert = false) {
  roomRects.push({ ...r, hit });
  ctx.save();
  // Concrete shell
  ctx.fillStyle = '#060507';
  ctx.fillRect(r.x - 10, r.y - 10, r.w + 20, r.h + 10 + SLAB);
  const img = art.rooms[type];
  if (img) ctx.drawImage(img, r.x, r.y, r.w, r.h);
  else proceduralRoom(r, type, now);
  // Red emergency wash: always faint, strong and flashing when the dweller needs Jav.
  const flick = alert ? (Math.floor(now / 350) % 2 ? 0.32 : 0.12) : 0.05 + 0.02 * (Math.floor(now / 2300 + r.x) % 2);
  ctx.fillStyle = `rgba(200,10,10,${flick})`;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  // vignette
  const v = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
  v.addColorStop(0, 'rgba(0,0,0,0.35)'); v.addColorStop(0.35, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = v; ctx.fillRect(r.x, r.y, r.w, r.h);
  grime(r);
  // Grate floor slab
  ctx.fillStyle = '#2b2a2f'; ctx.fillRect(r.x - 10, r.y + r.h, r.w + 20, SLAB);
  ctx.fillStyle = '#18171b';
  for (let x = r.x - 10; x < r.x + r.w + 10; x += 8) ctx.fillRect(x, r.y + r.h + 6, 4, SLAB - 10);
  ctx.fillStyle = '#4a4850'; ctx.fillRect(r.x - 10, r.y + r.h, r.w + 20, 3);
  // Warning beacon
  const on = alert ? Math.floor(now / 350) % 2 : Math.floor(now / 1400 + r.y) % 2;
  ctx.fillStyle = on ? '#ff2a1a' : '#3a0805';
  ctx.fillRect(r.x + r.w - 26, r.y + 8, 12, 8);
  if (on) { ctx.fillStyle = 'rgba(255,40,20,0.18)'; ctx.fillRect(r.x + r.w - 46, r.y + 4, 52, 40); }
  if (glow) { ctx.strokeStyle = glow; ctx.lineWidth = 4; ctx.strokeRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8); }
  // Stencil label plate
  ctx.font = `12px ${FONT}`;
  const tw = Math.min(ctx.measureText(label).width + 14, r.w - 60);
  ctx.fillStyle = 'rgba(8,7,9,0.85)'; ctx.fillRect(r.x + 8, r.y + 8, tw, 20);
  ctx.fillStyle = '#c9a227'; ctx.fillRect(r.x + 8, r.y + 8, 3, 20);
  ctx.fillStyle = '#d8d4cc'; ctx.fillText(label, r.x + 16, r.y + 22, tw - 12);
  ctx.restore();
}

function proceduralRoom(r, type, now) {
  ctx.fillStyle = ROOM_TINT[type] || '#333';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  // riveted wall panels
  for (let x = r.x; x < r.x + r.w; x += 60) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(x, r.y, 3, r.h);
    ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(x + 3, r.y, 2, r.h);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    for (let y = r.y + 30; y < r.y + r.h; y += 40) { ctx.fillRect(x + 8, y, 4, 4); ctx.fillRect(x + 48, y, 4, 4); }
  }
  // ceiling pipes
  ctx.fillStyle = '#1f1e23'; ctx.fillRect(r.x, r.y + 2, r.w, 10);
  ctx.fillStyle = '#4b2a22'; ctx.fillRect(r.x, r.y + 14, r.w, 6);
  // fluorescent tubes (one flickers)
  for (let i = 0; i < 2; i++) {
    const lit = i === 0 || Math.floor(now / 90 + r.x) % 17 !== 0;
    ctx.fillStyle = lit ? '#cfe3e0' : '#3a4140'; ctx.fillRect(r.x + r.w * (0.25 + i * 0.4), r.y + 26, 60, 4);
    if (lit) { ctx.fillStyle = 'rgba(200,230,225,0.06)'; ctx.fillRect(r.x + r.w * (0.25 + i * 0.4) - 30, r.y + 30, 120, r.h - 40); }
  }
  // props per room
  const P = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(r.x + x * r.w, r.y + y * r.h, w * r.w, h * r.h); };
  if (type === 'workshop') { P(0.06, 0.62, 0.3, 0.06, '#5a5560'); P(0.08, 0.68, 0.03, 0.27, '#2a282e'); P(0.31, 0.68, 0.03, 0.27, '#2a282e'); P(0.12, 0.45, 0.1, 0.17, '#1b1d1e'); P(0.135, 0.48, 0.07, 0.1, '#2f7a4a'); P(0.62, 0.62, 0.3, 0.06, '#5a5560'); P(0.7, 0.3, 0.2, 0.2, '#2a282e'); }
  if (type === 'library') { for (let i = 0; i < 4; i++) { P(0.05 + i * 0.07, 0.25, 0.06, 0.7, '#2a282e'); for (let j = 0; j < 5; j++) P(0.055 + i * 0.07, 0.3 + j * 0.13, 0.05, 0.05, j % 2 ? '#6b5a3a' : '#4c4f57'); } P(0.6, 0.62, 0.25, 0.05, '#5a5560'); P(0.7, 0.5, 0.04, 0.12, '#c9a227'); }
  if (type === 'server') { for (let i = 0; i < 4; i++) { P(0.05 + i * 0.1, 0.2, 0.08, 0.75, '#1a1b1f'); for (let j = 0; j < 8; j++) P(0.06 + i * 0.1, 0.25 + j * 0.08, 0.015, 0.02, Math.floor(now / 300 + i * 3 + j) % 4 ? '#2fbf5a' : '#0d2a16'); } P(0.6, 0.45, 0.3, 0.5, '#3a3a40'); P(0.7, 0.55, 0.1, 0.12, '#c9a227'); }
  if (type === 'lab') { P(0.65, 0.2, 0.18, 0.75, '#1a2a26'); P(0.67, 0.25, 0.14, 0.62, `rgba(60,200,120,${0.35 + 0.1 * Math.sin(now / 500)})`); P(0.08, 0.62, 0.35, 0.05, '#5a5560'); P(0.12, 0.52, 0.03, 0.1, '#7fc9a0'); P(0.2, 0.55, 0.03, 0.07, '#c9a227'); }
  if (type === 'command') { for (let i = 0; i < 6; i++) { P(0.08 + i * 0.14, 0.2, 0.11, 0.16, '#141618'); P(0.09 + i * 0.14, 0.22, 0.09, 0.12, i % 3 === 1 ? '#7a1a14' : '#1f5a36'); } P(0.3, 0.62, 0.4, 0.08, '#4a4850'); P(0.32, 0.7, 0.36, 0.25, '#2a282e'); }
}

function drawDig(r) {
  roomRects.push({ ...r, hit: { kind: 'dig' } });
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.setLineDash([12, 8]);
  ctx.strokeStyle = '#c9a227'; ctx.lineWidth = 4;
  ctx.strokeRect(r.x + 8, r.y + 8, r.w - 16, r.h - 16);
  ctx.setLineDash([]);
  ctx.fillStyle = '#c9a227';
  ctx.font = `20px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('+ EXCAVATE ROOM', r.x + r.w / 2, r.y + r.h / 2);
  ctx.font = `18px ${BODY_FONT}`;
  ctx.fillStyle = '#9a958c';
  ctx.fillText('click to add a Claude session', r.x + r.w / 2, r.y + r.h / 2 + 24);
  ctx.restore();
}

/** Pick the current animation frame and its whole-pixel scale. */
function pose(anims, anim, t, targetH, fps = 9) {
  if (!anims) return null;
  const frames = anims[anim] || anims.walk || Object.values(anims)[0];
  const f = anim === 'rest' ? frames[0] : frames[Math.floor(t * fps) % frames.length];
  const S = Math.max(2, Math.round(targetH / f.height));
  return { f, S, w: f.width * S, h: f.height * S };
}

function drawZombie(z, now) {
  const p = pose(art.chars.zombie, z.walking ? 'walk' : 'idle', z.t, 92, z.walking ? 6 : 5);
  if (!p) return;
  ctx.save();
  ctx.translate(Math.round(z.x), z.y);
  if (z.dir < 0) ctx.scale(-1, 1);
  ctx.globalAlpha = 0.92;
  ctx.drawImage(p.f, Math.round(-p.w / 2), -p.h, p.w, p.h);
  ctx.restore();
}

function drawCharacter(e, anims, anim, targetH, o) {
  const p = pose(anims, anim, e.t, targetH, anim === 'panic' ? 12 : 9);
  const h = p ? p.h : targetH;
  const bob = 0;
  const x = Math.round(e.x), y = Math.round(e.y);
  ctx.save();
  if (e.inShaft) {
    ctx.fillStyle = '#3a3840'; ctx.fillRect(x - 38, y - h - 20, 76, h + 24);
    ctx.fillStyle = '#1a191d'; ctx.fillRect(x - 32, y - h - 14, 64, h + 12);
    hazard(x - 38, y - h - 20, 76, 6);
  }
  ctx.fillStyle = o.selected ? 'rgba(216,221,227,0.5)' : 'rgba(0,0,0,0.5)';
  ctx.fillRect(x - 24, y, 48, 4);
  ctx.translate(x, y);
  if (e.dir < 0) ctx.scale(-1, 1);
  if (p) ctx.drawImage(p.f, Math.round(-p.w / 2), -p.h, p.w, p.h);
  ctx.restore();

  ctx.save();
  ctx.font = `11px ${FONT}`;
  ctx.textAlign = 'center';
  const tw = ctx.measureText(o.name).width + 10;
  ctx.fillStyle = 'rgba(6,5,7,0.85)'; ctx.fillRect(x - tw / 2, y + 8, tw, 16);
  ctx.fillStyle = o.color; ctx.fillText(o.name, x, y + 20);
  if (o.working && o.activity) {
    ctx.font = `16px ${BODY_FONT}`;
    ctx.fillStyle = '#9fd4b0';
    ctx.fillText(`> ${o.activity}${'.'.repeat(Math.floor(o.now / 400) % 4)}`, x, y - h - 10 - bob);
  }
  if (o.alert) {
    const on = Math.floor(o.now / 300) % 2;
    ctx.fillStyle = on ? '#ff2a1a' : '#a00d06';
    ctx.fillRect(x - 12, y - h - 46, 24, 28);
    ctx.fillStyle = '#0a0809'; ctx.fillRect(x - 12, y - h - 18, 24, 3);
    ctx.fillStyle = '#fff'; ctx.fillRect(x - 3, y - h - 42, 6, 14); ctx.fillRect(x - 3, y - h - 25, 6, 5);
  } else if (o.done) {
    ctx.fillStyle = '#2fbf5a'; ctx.fillRect(x - 10, y - h - 34, 20, 20);
    ctx.fillStyle = '#0a0809'; ctx.font = `16px ${FONT}`; ctx.fillText('OK', x, y - h - 19);
  }
  ctx.restore();

  if (e.bubble && performance.now() < e.bubble.until) drawBubble(x, y - h - (o.alert ? 58 : 28), e.bubble.text, e.bubble.lidia);
}

function drawBubble(x, y, text, isLidia) {
  ctx.save();
  ctx.font = `17px ${BODY_FONT}`;
  const all = wrap(String(text).replace(/\s+/g, ' '), 240);
  const lines = all.slice(0, 4);
  if (all.length > 4) lines[3] = lines[3].slice(0, -1) + '…';
  const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 18, h = lines.length * 16 + 12;
  const bx = Math.round(x - w / 2), by = Math.round(y - h);
  ctx.fillStyle = '#0a0809'; ctx.fillRect(bx - 3, by - 3, w + 6, h + 6);
  ctx.fillStyle = isLidia ? '#2a0e0d' : '#16181a';
  ctx.fillRect(bx, by, w, h);
  ctx.fillStyle = isLidia ? '#ff4a3a' : '#5a6068'; ctx.fillRect(bx, by, w, 2);
  ctx.fillStyle = '#0a0809'; ctx.fillRect(x - 5, y + 2, 10, 4); ctx.fillRect(x - 2, y + 6, 4, 4);
  ctx.fillStyle = isLidia ? '#ffd9d2' : '#d8e6dc';
  lines.forEach((l, i) => ctx.fillText(l, bx + 9, by + 19 + i * 16));
  ctx.restore();
}

function wrap(text, maxW) {
  const words = text.split(' '); const lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}
