// The underground world: layout, camera, characters and rendering.
//
// Projects are rooms. Rooms branch off a central lift shaft along tunnels, several per
// level and side, and grow with the number of agents working in them. Service ladders
// and utility pockets tie the levels together so the bunker reads as a network.
// On the surface, defenders on two barricade walls hold back the horde.
import { art } from './assets.js';

export const SHAFT_W = 96, SLAB = 22, TOP = 70;
const LEVEL_H = 410, MAX_H = 330;           // every level's floor lines up; rooms differ in width and height
const CHAR_H = 100, LIDIA_H = 92;           // on-screen heights (Lidia is petite)
const TUNNEL_H = 92;
const ZOMBIE_Y = -12;

const ROOM_TINT = { workshop: '#3b3a3f', library: '#38353a', server: '#2c3138', lab: '#2b3533', command: '#3d2f31', hall: '#34322f', garage: '#3a3530', vault: '#30333a' };
const FONT = '"Silkscreen", "VT323", monospace';
const BODY_FONT = '"VT323", monospace';
export const ROOM_LABEL = { workshop: 'Workshop', library: 'Archive', server: 'Reactor', lab: 'Bio Lab', hall: 'Ops Hall', garage: 'Garage', vault: 'Vault' };

const cam = { x: 0, y: 260, zoom: 0.9 };
let canvas, ctx, dpr = 1;
let state = null;
let selected = null;           // session id, 'lidia', or 'p:<project id>'
const chars = new Map();       // session id -> entity
const lidia = { id: 'lidia', x: 0, y: 0, tx: 0, level: 0, dir: -1, bubble: null, t: 0, pause: 0, path: [] };
let handlers = {};
let roomRects = [];            // for hit testing

// ------------------------------------------------------------------ layout
const roomBottom = (level) => TOP + level * LEVEL_H + MAX_H;
const floorY = (level) => roomBottom(level) - 14;
const BRIDGE = { x: SHAFT_W / 2 + 40, y: roomBottom(0) - 270, w: 480, h: 270, level: 0, side: 1 };
const COMMS = { x: -SHAFT_W / 2 - 40 - 480, y: roomBottom(0) - 270, w: 480, h: 270, level: 0, side: -1 };

// Build order of room slots: fill outward and downward together, so the bunker branches.
const SLOTS = (() => {
  const out = [];
  for (let level = 1; level <= 40; level++) for (let col = 0; col < 3; col++) for (const side of [1, -1])
    out.push({ level, col, side, key: level + col * 1.35 + (side < 0 ? 0.2 : 0) });
  return out.sort((a, b) => a.key - b.key);
})();
const gapFor = (level, side, col) => 46 + ((level * 37 + col * 53 + (side > 0 ? 11 : 0)) % 5) * 30;   // tunnel length

function roomSize(p, n) {
  let w = n >= 4 ? 780 : n >= 2 ? 600 : 430, h = n >= 4 ? 330 : n >= 2 ? 292 : 250;
  if (p?.roomType === 'hall') { w += 120; h = Math.max(h, 292); }
  if (p?.roomType === 'vault' || p?.roomType === 'lab') w -= 40;
  if (p?.roomType === 'server' || p?.roomType === 'garage') h = Math.min(MAX_H, h + 24);
  return { w, h };
}

let layout = { rooms: [], byProject: new Map(), dig: null, levels: 1, tunnels: [], ladders: [], pockets: [] };

function computeLayout() {
  const projects = state?.projects || [];
  const ends = new Map();                 // "level:side" -> outer edge distance from centre, per col
  const place = (slot, size) => {
    const k = `${slot.level}:${slot.side}`;
    const prev = ends.get(k) ?? SHAFT_W / 2;
    const start = prev + gapFor(slot.level, slot.side, slot.col);
    ends.set(k, start + size.w);
    const x = slot.side > 0 ? start : -(start + size.w);
    const tunnel = { level: slot.level, x0: slot.side > 0 ? prev : -start, x1: slot.side > 0 ? start : -prev };
    return { ...slot, ...size, x, y: roomBottom(slot.level) - size.h, start, end: start + size.w, tunnel };
  };
  const rooms = projects.map((p, i) => {
    const n = state.sessions.filter(s => s.projectId === p.id).length;
    return { ...place(SLOTS[i], roomSize(p, n)), project: p, members: n };
  });
  const dig = place(SLOTS[projects.length], { w: 430, h: 250 });
  const levels = Math.max(1, ...rooms.map(r => r.level), dig.level);

  // Service ladders between stacked rooms on the same side, through the rock.
  const ladders = [];
  for (let l = 0; l < levels; l++) for (const side of [1, -1]) {
    const a = l === 0 ? (side > 0 ? BRIDGE : COMMS) : rooms.filter(r => r.level === l && r.side === side).sort((p, q) => q.end - p.end)[0];
    const b = rooms.filter(r => r.level === l + 1 && r.side === side).sort((p, q) => q.end - p.end)[0];
    if (!a || !b) continue;
    const aEnd = a.end ?? (a.w + SHAFT_W / 2 + 40), reach = Math.min(aEnd, b.end) - 46;
    if (reach < SHAFT_W) continue;
    ladders.push({ x: side * reach - 12, y0: roomBottom(l) + SLAB, y1: b.y });
  }
  // Utility pockets (generator, pumps, water) at the far end of some tunnels.
  const pockets = [];
  for (let l = 1; l <= levels; l++) {
    const side = l % 2 ? 1 : -1;
    const outer = Math.max(SHAFT_W / 2, ...rooms.filter(r => r.level === l && r.side === side).map(r => r.end), dig.level === l && dig.side === side ? dig.end : 0);
    if (outer <= SHAFT_W / 2) continue;
    const start = outer + 60, w = 190, h = 160;
    pockets.push({ level: l, side, kind: ['generator', 'pumps', 'water'][l % 3], x: side > 0 ? start : -(start + w), y: roomBottom(l) - h, w, h,
      tunnel: { level: l, x0: side > 0 ? outer : -start, x1: side > 0 ? start : -outer } });
  }
  layout = { rooms, byProject: new Map(rooms.map(r => [r.project.id, r])), dig, levels, ladders, pockets };
}

const homeRect = (e) => layout.byProject.get(e.session?.projectId) || layout.dig;
function roomInner(r) { return { x0: r.x + 40, x1: r.x + r.w - 40 }; }

// ------------------------------------------------------------------ public API
export function initGame(cv, h) {
  canvas = cv; ctx = cv.getContext('2d'); handlers = h;
  resize(); addEventListener('resize', resize);
  // Phones: fit one room plus the shaft across the screen.
  if (cv.clientWidth < 700) cam.zoom = cv.clientWidth / (480 + SHAFT_W + 100);
  bindInput();
  lidia.x = BRIDGE.x + BRIDGE.w * 0.6; lidia.y = floorY(0); lidia.tx = lidia.x;
  requestAnimationFrame(frame);
}

export function setState(st) {
  state = st;
  st.projects ||= [];
  computeLayout();
  const ids = new Set(st.sessions.map(s => s.id));
  for (const id of chars.keys()) if (!ids.has(id)) chars.delete(id);
  st.sessions.forEach((s) => {
    let e = chars.get(s.id);
    const moved = e && e.session && e.session.projectId !== s.projectId;
    if (!e) {
      const r = layout.byProject.get(s.projectId) || layout.dig;
      const inner = roomInner(r);
      e = { id: s.id, x: inner.x0 + Math.random() * (inner.x1 - inner.x0), y: floorY(r.level), tx: 0, dir: 1,
            level: r.level, path: [], pause: Math.random() * 2, t: Math.random() * 10, bubble: null, away: false };
      chars.set(s.id, e);
    }
    e.session = s;
    // Walk to the new room after a move; head back home when a report is over.
    if (moved || (e.away && !e.visiting && s.status !== 'reporting')) goHome(e);
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

/** Route along floors and the central lift from wherever e is to (x, level). */
function route(e, x, level) {
  if (e.level === level && !e.inShaft) return [{ x, level }];
  return [{ x: 0, level: e.level, shaft: true }, { x: 0, level, shaft: true }, { x, level }];
}

/** Walk the agent up the shaft to the bridge to report. */
export function report(sessionId) {
  const e = chars.get(sessionId);
  if (!e || e.away) return;
  e.away = true;
  e.path = [...route(e, BRIDGE.x + 30, 0), { x: lidia.x - 60 - Math.random() * 40, level: 0 }];
}

/** A fellow owner walks over to another owner's room to review their work. */
export function visit(fromId, toId) {
  const e = chars.get(fromId), t = chars.get(toId);
  if (!e || !t) return;
  const tr = homeRect(t);
  e.away = true; e.visiting = true;
  e.path = route(e, tr.x + tr.w * (0.25 + Math.random() * 0.5), tr.level);
}
export function visitEnd(fromId) {
  const e = chars.get(fromId);
  if (!e) return;
  e.visiting = false;
  goHome(e);
}

function goHome(e) {
  e.away = false;
  const r = homeRect(e);
  const inner = roomInner(r);
  e.path = route(e, inner.x0 + Math.random() * (inner.x1 - inner.x0), r.level);
}

let fly = null;  // camera animation in progress
function flyCam(fn) {
  const from = { x: cam.x, y: cam.y };
  fn();
  const to = { x: cam.x, y: cam.y };
  cam.x = from.x; cam.y = from.y;
  fly = { from, to, t0: performance.now(), dur: 650 };
}
/** Smoothly move the camera to someone (same framing as focusOn). */
export function flyTo(id, insetBottom = 0) { flyCam(() => focusOn(id, insetBottom)); }
/** Smoothly move the camera to a project room. */
export function flyToProject(pid, insetBottom = 0) {
  const r = layout.byProject.get(pid);
  if (r) flyCam(() => { cam.x = r.x + r.w / 2; cam.y = r.y + r.h / 2 + insetBottom / 2 / cam.zoom; });
}

/** Center on someone. `insetBottom` (screen px) keeps them above an open bottom sheet. */
export function focusOn(id, insetBottom = 0) {
  const shift = insetBottom / 2 / cam.zoom;
  if (id === 'lidia') { cam.x = BRIDGE.x + BRIDGE.w / 2; cam.y = BRIDGE.y + BRIDGE.h / 2 + shift; return; }
  const e = chars.get(id);
  if (e) { cam.x = e.x; cam.y = e.y - 135 + 20 + shift; }
}

export function zoomBy(f) { cam.zoom = Math.max(0.2, Math.min(2.5, cam.zoom * f)); }

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
      cam.zoom = Math.max(0.2, Math.min(2.5, drag.pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / drag.pinch.d));
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
    cam.zoom = Math.max(0.2, Math.min(2.5, cam.zoom * Math.exp(-ev.deltaY * 0.0015)));
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
      e.y += Math.sign(ty - e.y) * Math.min(Math.abs(ty - e.y), 300 * dt);
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
  if (e.away) return;
  const r = e === lidia ? BRIDGE : homeRect(e);
  const inner = roomInner(r);
  e.path = [{ x: inner.x0 + Math.random() * (inner.x1 - inner.x0), level: r.level }];
  const busy = e.session && e.session.status === 'working';
  e.pause = busy ? 0.6 + Math.random() * 1.6 : 2 + Math.random() * 5;
}

// ------------------------------------------------------------------ the wall defense
const WALL_X = 520, WALL_H = 220, WALL_W = 180;
const PLATFORM_Y = -WALL_H + 22;
const defenders = [-1, 1].flatMap(side => [0, 1].map(k => ({
  side, x: side * (WALL_X - 36 + k * 58), t: Math.random() * 3, cool: 0.5 + Math.random(), anim: 'shoot', animT: 0, shot: null,
})));
const horde = Array.from({ length: 22 }, (_, i) => spawnZombie({ kind: i % 2 ? 'zombie2' : 'zombie' }, i % 2 ? 1 : -1, true));
const blood = [];

function spawnZombie(z, side, scatter = false) {
  Object.assign(z, {
    side, x: side * (WALL_X + 140 + Math.random() * (scatter ? 620 : 320)), y: ZOMBIE_Y, hp: 2 + Math.floor(Math.random() * 3),
    speed: 16 + Math.random() * 22, state: 'walk', st: 0, vx: 0, t: Math.random() * 10, fade: 1,
  });
  return z;
}

function stepDefense(dt) {
  const face = (z) => z.side * (WALL_X + WALL_W / 2 + 14);
  for (const z of horde) {
    z.t += dt; z.st += dt;
    if (z.state === 'dead') { if (z.st > 5) z.fade -= dt * 0.6; if (z.fade <= 0) spawnZombie(z, Math.random() < 0.5 ? -1 : 1); continue; }
    if (z.vx) { z.x += z.vx * dt; z.vx *= Math.pow(0.04, dt); if (Math.abs(z.vx) < 4) z.vx = 0; }
    if (z.state === 'hit') { if (z.st > 0.45) { z.state = 'walk'; z.st = 0; } continue; }
    const atWall = Math.abs(z.x) <= Math.abs(face(z)) + 2;
    if (atWall) { z.x = face(z); if (z.state !== 'attack') { z.state = 'attack'; z.st = 0; } }
    else { z.state = 'walk'; z.x -= z.side * z.speed * dt; }
  }
  for (const d of defenders) {
    d.t += dt; d.animT += dt; d.cool -= dt;
    if (d.shot && performance.now() > d.shot.until) d.shot = null;
    if (d.cool > 0) continue;
    const targets = horde.filter(z => z.side === d.side && z.state !== 'dead' && z.fade === 1 && Math.abs(z.x - d.x) < 1100);
    if (!targets.length) { d.cool = 0.4; continue; }
    const z = targets.sort((a, b) => Math.abs(a.x) - Math.abs(b.x))[0];
    const close = z.state === 'attack';
    // A zombie clawing at the wall gets shoved back with the rifle butt; everything else gets shot.
    if (close && Math.random() < 0.35) {
      d.anim = 'push'; d.animT = 0; d.cool = 0.9 + Math.random() * 0.5;
      z.state = 'hit'; z.st = 0; z.vx = z.side * (220 + Math.random() * 120);
      splat(z.x, z.y - 60, 6);
      continue;
    }
    d.anim = 'shoot'; d.animT = 0; d.cool = 0.45 + Math.random() * 0.9;
    const hit = Math.random() < 0.72;
    d.shot = { x: z.x + (hit ? 0 : z.side * (20 + Math.random() * 60)), y: z.y - 55 - Math.random() * 25, until: performance.now() + 70 };
    if (!hit) continue;
    z.hp -= 1; z.vx = z.side * (70 + Math.random() * 60);
    splat(z.x, z.y - 55, 9);
    if (z.hp <= 0) { z.state = 'dead'; z.st = 0; z.vx = z.side * 90; }
    else { z.state = 'hit'; z.st = 0; }
  }
  for (const b of blood) { b.life -= dt; b.vy += 900 * dt; b.x += b.vx * dt; b.y += b.vy * dt; if (b.y > ZOMBIE_Y) { b.y = ZOMBIE_Y; b.vx = 0; b.vy = 0; } }
  for (let i = blood.length - 1; i >= 0; i--) if (blood[i].life <= 0) blood.splice(i, 1);
}

function splat(x, y, n) {
  for (let i = 0; i < n; i++) blood.push({ x, y, vx: (Math.random() - 0.5) * 260, vy: -Math.random() * 260, life: 1.2 + Math.random() * 2.5 });
  if (blood.length > 240) blood.splice(0, blood.length - 240);
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
  stepDefense(dt);
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

  const bottom = roomBottom(layout.levels) + 260;
  drawEarth(bottom);
  drawSurface();
  drawDefense(now);

  roomRects = [];
  // Tunnels and ladders first, so rooms sit on top of them.
  for (const r of [...layout.rooms, layout.dig, ...layout.pockets]) if (r?.tunnel) drawTunnel(r.tunnel, now);
  for (const t of [{ level: 0, x0: -SHAFT_W / 2 - 40, x1: -SHAFT_W / 2 }, { level: 0, x0: SHAFT_W / 2, x1: SHAFT_W / 2 + 40 }]) drawTunnel(t, now);
  for (const l of layout.ladders) drawLadder(l);
  drawShaft(bottom - 260);
  for (const p of layout.pockets) drawPocket(p, now);

  drawRoom(COMMS, 'server', 'COMMS / ARMORY', { kind: 'tab', tab: 'connectors' }, null, now);
  drawRoom(BRIDGE, 'command', 'COMMAND', { kind: 'lidia' }, selected === 'lidia' ? '#d8dde3' : null, now);
  if (state) {
    for (const r of layout.rooms) {
      const ms = state.sessions.filter(s => s.projectId === r.project.id);
      const alert = ms.some(s => s.status === 'needs_jav');
      const mine = selected === `p:${r.project.id}` || ms.some(s => s.id === selected);
      const glow = alert ? (Math.floor(now / 350) % 2 ? '#ff2a1a' : '#5a0a06') : mine ? '#d8dde3' : null;
      const label = `${r.project.name.toUpperCase()} / ${(ROOM_LABEL[r.project.roomType] || r.project.roomType).toUpperCase()}`;
      drawRoom(r, r.project.roomType, label, { kind: 'project', id: r.project.id }, glow, now, alert, ms.length);
    }
    drawDig(layout.dig);
  }

  const lAnim = lidia.walking ? 'walk' : lidia.bubble && now < lidia.bubble.until ? 'command' : 'idle';
  drawCharacter(lidia, art.chars.lidia, lAnim, LIDIA_H, { name: 'CPT. LIDIA', color: '#ff5a4a', now, isLidia: true });
  for (const e of chars.values()) {
    const s = e.session;
    if (!s) continue;
    const alert = s.status === 'needs_jav';
    const anim = alert && !e.walking ? 'panic' : e.walking ? 'walk' : (s.status === 'working' || e.visiting) ? 'work' : 'rest';
    const look = art.cast?.length ? art.cast[(s.look ?? hash(s.id)) % art.cast.length] : null;
    drawCharacter(e, look ? (alert ? look.red : look.anims) : (alert ? art.chars.survivorRed : art.chars.survivor), anim, CHAR_H, {
      name: s.name.toUpperCase(), color: `hsl(${s.hue},45%,70%)`, now, alert, done: s.status === 'done',
      working: s.status === 'working' || e.visiting, activity: e.visiting ? 'reviewing' : s.activity, selected: s.id === selected,
    });
  }
}

const hash = (str) => [...String(str)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function drawEarth(bottom) {
  const x0 = -6000, x1 = 6000, y1 = bottom + 3000;
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
    for (let i = 0; i < 1400; i++) {
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
    ctx.fillStyle = '#07080b'; ctx.fillRect(-6000, -h - 2000, 12000, h + 2000);
    ctx.drawImage(art.surface, -w / 2, -h + 6, w, h);
    // Past the edge of the picture: dark ruins so the horde never walks into the void.
    ctx.fillStyle = '#0d0b0f'; ctx.fillRect(-6000, -260, 6000 - w / 2, 260); ctx.fillRect(w / 2, -260, 6000 - w / 2, 260);
  } else {
    // Drawn fallback: a ruined city at night, smoke and fire.
    const h = 900, now = performance.now();
    const sky = ctx.createLinearGradient(0, -h, 0, 0);
    sky.addColorStop(0, '#07060a'); sky.addColorStop(0.6, '#1c0a0b'); sky.addColorStop(1, '#3a120c');
    ctx.fillStyle = '#07060a'; ctx.fillRect(-6000, -h - 2000, 12000, 2000);
    ctx.fillStyle = sky; ctx.fillRect(-6000, -h, 12000, h);
    ctx.fillStyle = '#c9c2b0'; ctx.fillRect(820, -h + 120, 36, 36); ctx.fillStyle = '#1c0a0b'; ctx.fillRect(838, -h + 114, 24, 30);
    for (let x = -6000, i = 0; x < 6000; i++) {
      const bw = 90 + (i * 37) % 120, bh = 160 + (i * 97) % 300;
      ctx.fillStyle = i % 2 ? '#0d0b0f' : '#120f14';
      ctx.fillRect(x, -40 - bh, bw, bh);
      ctx.fillStyle = '#07060a'; ctx.fillRect(x + bw * 0.6, -40 - bh, bw * 0.4, 20 + (i * 13) % 40);
      for (let wy = -40 - bh + 30; wy < -60; wy += 26) for (let wx = x + 10; wx < x + bw - 14; wx += 22)
        if ((wx * 7 + wy * 3 + i) % 23 === 0) { ctx.fillStyle = '#6a3a14'; ctx.fillRect(wx, wy, 8, 10); }
      x += bw + 10;
    }
    for (const sx of [-1500, -900, 300, 1500]) {
      for (let k = 0; k < 10; k++) {
        ctx.fillStyle = `rgba(40,30,30,${0.35 - k * 0.03})`;
        const o = Math.sin(now / 1500 + k + sx) * 14;
        ctx.fillRect(sx + o - 20 - k * 4, -120 - k * 40, 40 + k * 8, 40);
      }
    }
    ctx.fillStyle = '#1b1715'; ctx.fillRect(-6000, -40, 12000, 40);
    for (const cx of [-1500, -1100, 1180, 1500]) {
      ctx.fillStyle = '#2a1e1a'; ctx.fillRect(cx, -70, 110, 30); ctx.fillRect(cx + 20, -92, 60, 24);
      ctx.fillStyle = '#0a0809'; ctx.fillRect(cx + 10, -44, 22, 8); ctx.fillRect(cx + 78, -44, 22, 8);
    }
    for (const fx of [-380, 420]) {
      ctx.fillStyle = '#3a2a22'; ctx.fillRect(fx, -78, 30, 38);
      const fl = Math.floor(now / 120 + fx) % 3;
      ctx.fillStyle = '#ff7a1a'; ctx.fillRect(fx + 4, -96 - fl * 3, 22, 20 + fl * 3);
      ctx.fillStyle = '#ffd04a'; ctx.fillRect(fx + 10, -90 - fl * 2, 10, 12);
      ctx.fillStyle = 'rgba(255,110,30,0.10)'; ctx.fillRect(fx - 80, -200, 190, 160);
    }
    ctx.fillStyle = '#3a3f46'; ctx.fillRect(-70, -60, 140, 20);
    ctx.fillStyle = '#2a2e33'; ctx.fillRect(-56, -220, 12, 160); ctx.fillRect(44, -220, 12, 160); ctx.fillRect(-56, -228, 112, 12);
    const on = Math.floor(now / 600) % 2;
    ctx.fillStyle = on ? '#ff2a1a' : '#4a0a06'; ctx.fillRect(-6, -244, 12, 12);
  }
  ctx.fillStyle = '#0e0c0f';
  ctx.fillRect(-6000, 0, 12000, 10);
}

function drawWall(side) {
  const cx = side * WALL_X;
  ctx.save();
  ctx.translate(cx, 4);
  if (side < 0) ctx.scale(-1, 1);
  if (art.wall) {
    const h = WALL_H + 20, w = Math.min(WALL_W * 1.6, h * art.wall.width / art.wall.height);
    ctx.drawImage(art.wall, -w / 2, -h, w, h);
  } else {
    const x0 = -WALL_W / 2;
    // sandbags
    for (let row = 0; row < 3; row++) for (let i = 0; i < 5; i++) {
      ctx.fillStyle = (i + row) % 2 ? '#5a4c34' : '#4c4030';
      ctx.fillRect(x0 + i * 30 + (row % 2) * 12 - 6, -26 - row * 22, 30, 20);
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(x0 + i * 30 + (row % 2) * 12 - 6, -10 - row * 22, 30, 4);
    }
    // welded scrap and corrugated sheets
    ctx.fillStyle = '#3a3c40'; ctx.fillRect(x0 + 6, -WALL_H + 20, WALL_W - 12, WALL_H - 86);
    ctx.fillStyle = '#2a2b2f'; for (let x = x0 + 10; x < x0 + WALL_W - 10; x += 12) ctx.fillRect(x, -WALL_H + 20, 5, WALL_H - 86);
    ctx.fillStyle = '#5a3a24'; ctx.fillRect(x0 + 2, -WALL_H + 54, WALL_W - 4, 10); ctx.fillRect(x0 + 2, -WALL_H + 92, WALL_W - 4, 10);
    ctx.fillStyle = 'rgba(110,8,10,0.85)'; ctx.fillRect(x0 + WALL_W - 34, -86, 18, 26); ctx.fillRect(x0 + WALL_W - 28, -60, 4, 22);
    ctx.fillStyle = '#0a0809'; for (const [bx, by] of [[30, -120], [64, -98], [96, -132], [118, -80]]) ctx.fillRect(x0 + bx, by, 4, 4);
    // walkway + barbed wire
    ctx.fillStyle = '#4a4850'; ctx.fillRect(x0 - 10, -WALL_H + 14, WALL_W + 20, 8);
    ctx.fillStyle = '#8a8a8a';
    for (let x = x0 + 40; x < x0 + WALL_W + 8; x += 10) { ctx.fillRect(x, -WALL_H + 2 + ((x / 10) % 2) * 4, 8, 2); ctx.fillRect(x + 3, -WALL_H, 2, 10); }
  }
  ctx.restore();
}

function drawDefense(now) {
  // Corpses and the horde behind the walls' faces, then the walls, then the defenders on top.
  for (const z of horde) drawZombie(z, now);
  drawWall(-1); drawWall(1);
  for (const b of blood) { ctx.fillStyle = `rgba(150,8,10,${Math.min(1, b.life)})`; ctx.fillRect(Math.round(b.x), Math.round(b.y), 5, 5); }
  for (const d of defenders) {
    const anim = d.anim === 'push' && d.animT < 0.6 ? 'push' : 'shoot';
    const frames = art.chars.defender?.[anim];
    const ph = anim === 'shoot' ? (d.animT < 0.18 ? 1 + Math.floor(d.animT / 0.06) % 2 : 0) : Math.floor(d.animT * 10);
    const p = frames && pose(art.chars.defender, anim, 0, 92);
    if (p) {
      const f = frames[Math.min(frames.length - 1, ph)] || frames[0];
      const S = p.S, w = f.width * S, h = f.height * S;
      ctx.save(); ctx.translate(Math.round(d.x), PLATFORM_Y); if (d.side < 0) ctx.scale(-1, 1);
      ctx.drawImage(f, Math.round(-w / 2), -h, w, h);
      ctx.restore();
    }
    if (d.shot) {
      const mx = d.x + d.side * 46, my = PLATFORM_Y - 48;
      ctx.strokeStyle = 'rgba(255,220,120,0.9)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(d.shot.x, d.shot.y); ctx.stroke();
      ctx.fillStyle = '#ffd04a'; ctx.fillRect(mx - 6 + d.side * 4, my - 6, 14, 12);
      ctx.fillStyle = 'rgba(255,170,40,0.18)'; ctx.fillRect(mx - 50, my - 40, 100, 80);
    }
  }
}

/** Seeded blood smears, drips and grime so every room looks like it survived something. */
function grime(r) {
  let seed = Math.abs(Math.floor(r.x * 7 + r.y * 13)) + 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const snap = (v) => Math.round(v / 3) * 3;
  const fx = r.x + 40 + rnd() * (r.w - 140), fy = r.y + r.h - 10;
  ctx.fillStyle = 'rgba(70,4,6,0.85)';
  for (let i = 0; i < 14; i++) ctx.fillRect(snap(fx + rnd() * 90), snap(fy - rnd() * 6), 3 + snap(rnd() * 12), 3);
  if (rnd() < 0.8) {
    const wx = r.x + 30 + rnd() * (r.w - 80), wy = r.y + 50 + rnd() * (r.h * 0.4);
    ctx.fillStyle = 'rgba(95,6,8,0.8)';
    for (let i = 0; i < 10; i++) ctx.fillRect(snap(wx + rnd() * 30 - 15), snap(wy + rnd() * 18 - 9), 3 + snap(rnd() * 6), 3 + snap(rnd() * 3));
    for (let i = 0; i < 3; i++) ctx.fillRect(snap(wx + rnd() * 24 - 12), snap(wy), 3, 9 + snap(rnd() * 30));
  }
  if (rnd() < 0.5) {
    const cx = r.x + 30 + rnd() * (r.w - 60), cy = r.y + 40 + rnd() * 60;
    ctx.fillStyle = 'rgba(10,8,9,0.75)';
    for (let k = 0; k < 3; k++) for (let j = 0; j < 8; j++) ctx.fillRect(snap(cx + k * 9 + j * 2), snap(cy + j * 5), 3, 3);
  }
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
  ctx.fillStyle = '#34313a';
  ctx.fillRect(-SHAFT_W / 2 + 14, 0, 4, bottom); ctx.fillRect(SHAFT_W / 2 - 18, 0, 4, bottom);
  for (let y = 0; y < bottom; y += 48) { ctx.fillStyle = '#1c1a20'; ctx.fillRect(-SHAFT_W / 2 + 8, y, SHAFT_W - 16, 4); }
  ctx.fillStyle = '#0a090b'; ctx.fillRect(-6, 0, 3, bottom); ctx.fillRect(4, 0, 3, bottom);
  for (let l = 0; roomBottom(l) < bottom; l++) hazard(-SHAFT_W / 2, roomBottom(l), SHAFT_W, SLAB);
  // barricaded hatch at the top of the shaft
  for (const [dy, rot] of [[-30, -0.12], [-18, 0.1], [-6, -0.05]]) {
    ctx.save(); ctx.translate(0, dy); ctx.rotate(rot);
    ctx.fillStyle = '#4a3420'; ctx.fillRect(-SHAFT_W / 2 - 22, -5, SHAFT_W + 44, 10);
    ctx.fillStyle = '#2c1e12'; ctx.fillRect(-SHAFT_W / 2 - 22, 3, SHAFT_W + 44, 2);
    ctx.fillStyle = '#8a8a8a'; ctx.fillRect(-SHAFT_W / 2 - 16, -2, 3, 3); ctx.fillRect(SHAFT_W / 2 + 12, -2, 3, 3);
    ctx.restore();
  }
  ctx.fillStyle = 'rgba(95,6,8,0.85)'; ctx.fillRect(-20, -34, 9, 30); ctx.fillRect(-14, -8, 3, 14);
}

/** A corridor cut through the rock at floor level between the shaft and rooms. */
function drawTunnel(t, now) {
  const x = Math.min(t.x0, t.x1), w = Math.abs(t.x1 - t.x0);
  if (w < 2) return;
  const y1 = roomBottom(t.level), y0 = y1 - TUNNEL_H;
  ctx.fillStyle = '#060507'; ctx.fillRect(x, y0 - 8, w, TUNNEL_H + 8 + SLAB);
  ctx.fillStyle = '#1e1c21'; ctx.fillRect(x, y0, w, TUNNEL_H);
  ctx.fillStyle = '#2a282e'; for (let bx = x; bx < x + w; bx += 40) ctx.fillRect(bx, y0, 4, TUNNEL_H);            // support ribs
  ctx.fillStyle = '#3a2620'; ctx.fillRect(x, y0 + 6, w, 5);                                                         // pipe
  ctx.fillStyle = '#26252b'; ctx.fillRect(x, y0 + 14, w, 3);                                                        // cable
  for (let lx = x + 20; lx < x + w - 10; lx += 90) {                                                                // caged lamps
    const lit = Math.floor(now / 110 + lx) % 29 !== 0;
    ctx.fillStyle = lit ? '#d8c27a' : '#3a3420'; ctx.fillRect(lx, y0 + 20, 8, 6);
    if (lit) { ctx.fillStyle = 'rgba(216,194,122,0.07)'; ctx.fillRect(lx - 26, y0 + 26, 60, TUNNEL_H - 26); }
  }
  ctx.fillStyle = '#2b2a2f'; ctx.fillRect(x, y1, w, SLAB);
  ctx.fillStyle = '#18171b'; for (let gx = x; gx < x + w; gx += 8) ctx.fillRect(gx, y1 + 6, 4, SLAB - 10);
  ctx.fillStyle = '#4a4850'; ctx.fillRect(x, y1, w, 3);
}

function drawLadder(l) {
  const h = l.y1 - l.y0;
  if (h <= 0) return;
  ctx.fillStyle = '#060507'; ctx.fillRect(l.x - 6, l.y0, 36, h);
  ctx.fillStyle = '#16141a'; ctx.fillRect(l.x, l.y0, 24, h);
  ctx.fillStyle = '#4a4850'; ctx.fillRect(l.x + 2, l.y0, 3, h); ctx.fillRect(l.x + 19, l.y0, 3, h);
  for (let y = l.y0 + 6; y < l.y1; y += 14) ctx.fillRect(l.x + 2, y, 20, 3);
}

/** Small machinery pockets that keep the fortress alive. Not clickable. */
function drawPocket(p, now) {
  const r = p;
  ctx.fillStyle = '#060507'; ctx.fillRect(r.x - 8, r.y - 8, r.w + 16, r.h + 8 + SLAB);
  ctx.fillStyle = '#26242a'; ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; for (let x = r.x; x < r.x + r.w; x += 38) ctx.fillRect(x, r.y, 3, r.h);
  const P = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(r.x + x, r.y + y, w, h); };
  if (p.kind === 'generator') {
    P(30, r.h - 80, 110, 66, '#3a3d36'); P(38, r.h - 72, 40, 30, '#22251f'); P(90, r.h - 100, 14, 24, '#2a2a2a');
    const on = Math.floor(now / 180) % 2; P(120, r.h - 74, 10, 8, on ? '#ffb030' : '#5a3a10');
    for (let k = 0; k < 4; k++) { ctx.fillStyle = `rgba(60,60,60,${0.25 - k * 0.05})`; ctx.fillRect(r.x + 92 + Math.sin(now / 400 + k) * 4, r.y + r.h - 120 - k * 18, 12 + k * 4, 14); }
  } else if (p.kind === 'pumps') {
    P(20, 30, r.w - 40, 12, '#3a2620'); P(40, 42, 12, r.h - 60, '#3a2620'); P(120, 42, 12, r.h - 60, '#3a2620');
    P(26, r.h - 54, 46, 40, '#2e3a40'); P(106, r.h - 54, 46, 40, '#2e3a40');
    P(60 + (Math.floor(now / 300) % 3) * 4, r.h - 70, 6, 10, '#5ad1ff');
  } else {
    P(30, 40, 60, r.h - 54, '#2c3338'); P(100, 60, 60, r.h - 74, '#2c3338');
    P(34, 40 + (r.h - 54) * 0.4, 52, (r.h - 54) * 0.6, 'rgba(60,120,140,0.35)'); P(104, 60 + (r.h - 74) * 0.5, 52, (r.h - 74) * 0.5, 'rgba(60,120,140,0.35)');
  }
  ctx.fillStyle = '#2b2a2f'; ctx.fillRect(r.x - 8, r.y + r.h, r.w + 16, SLAB);
  ctx.font = `10px ${FONT}`; ctx.fillStyle = '#8a857c';
  ctx.fillText(p.kind.toUpperCase(), r.x + 8, r.y + 16);
}

/** Room art cropped (not stretched) to the room's shape, keeping the floor. */
function drawCover(img, r) {
  const ar = r.w / r.h, iar = img.width / img.height;
  let sw = img.width, sh = img.height, sx = 0, sy = 0;
  if (iar > ar) { sw = sh * ar; sx = (img.width - sw) / 2; } else { sh = sw / ar; sy = img.height - sh; }
  ctx.drawImage(img, sx, sy, sw, sh, r.x, r.y, r.w, r.h);
}

function drawRoom(r, type, label, hit, glow, now = 0, alert = false, count = null) {
  roomRects.push({ ...r, hit });
  ctx.save();
  ctx.fillStyle = '#060507';
  ctx.fillRect(r.x - 10, r.y - 10, r.w + 20, r.h + 10 + SLAB);
  const img = art.rooms[type] || (type === 'hall' ? art.rooms.command : null);
  if (img) drawCover(img, r);
  else proceduralRoom(r, type, now);
  const flick = alert ? (Math.floor(now / 350) % 2 ? 0.32 : 0.12) : 0.05 + 0.02 * (Math.floor(now / 2300 + r.x) % 2);
  ctx.fillStyle = `rgba(200,10,10,${flick})`;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  const v = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
  v.addColorStop(0, 'rgba(0,0,0,0.35)'); v.addColorStop(0.35, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = v; ctx.fillRect(r.x, r.y, r.w, r.h);
  grime(r);
  ctx.fillStyle = '#2b2a2f'; ctx.fillRect(r.x - 10, r.y + r.h, r.w + 20, SLAB);
  ctx.fillStyle = '#18171b';
  for (let x = r.x - 10; x < r.x + r.w + 10; x += 8) ctx.fillRect(x, r.y + r.h + 6, 4, SLAB - 10);
  ctx.fillStyle = '#4a4850'; ctx.fillRect(r.x - 10, r.y + r.h, r.w + 20, 3);
  const on = alert ? Math.floor(now / 350) % 2 : Math.floor(now / 1400 + r.y) % 2;
  ctx.fillStyle = on ? '#ff2a1a' : '#3a0805';
  ctx.fillRect(r.x + r.w - 26, r.y + 8, 12, 8);
  if (on) { ctx.fillStyle = 'rgba(255,40,20,0.18)'; ctx.fillRect(r.x + r.w - 46, r.y + 4, 52, 40); }
  if (glow) { ctx.strokeStyle = glow; ctx.lineWidth = 4; ctx.strokeRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8); }
  // Stencil label plate, with a head count for project rooms
  ctx.font = `12px ${FONT}`;
  const tag = count != null ? ` · ${count}` : '';
  const tw = Math.min(ctx.measureText(label + tag).width + 14, r.w - 60);
  ctx.fillStyle = 'rgba(8,7,9,0.85)'; ctx.fillRect(r.x + 8, r.y + 8, tw, 20);
  ctx.fillStyle = '#c9a227'; ctx.fillRect(r.x + 8, r.y + 8, 3, 20);
  ctx.fillStyle = '#d8d4cc'; ctx.fillText(label + tag, r.x + 16, r.y + 22, tw - 12);
  ctx.restore();
}

function proceduralRoom(r, type, now) {
  ctx.fillStyle = ROOM_TINT[type] || '#333';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  for (let x = r.x; x < r.x + r.w; x += 60) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(x, r.y, 3, r.h);
    ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(x + 3, r.y, 2, r.h);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    for (let y = r.y + 30; y < r.y + r.h; y += 40) { ctx.fillRect(x + 8, y, 4, 4); ctx.fillRect(x + 48, y, 4, 4); }
  }
  ctx.fillStyle = '#1f1e23'; ctx.fillRect(r.x, r.y + 2, r.w, 10);
  ctx.fillStyle = '#4b2a22'; ctx.fillRect(r.x, r.y + 14, r.w, 6);
  const tubes = Math.max(2, Math.round(r.w / 240));
  for (let i = 0; i < tubes; i++) {
    const tx = r.x + r.w * ((i + 0.5) / tubes) - 30;
    const lit = i === 0 || Math.floor(now / 90 + r.x + i) % 17 !== 0;
    ctx.fillStyle = lit ? '#cfe3e0' : '#3a4140'; ctx.fillRect(tx, r.y + 26, 60, 4);
    if (lit) { ctx.fillStyle = 'rgba(200,230,225,0.06)'; ctx.fillRect(tx - 30, r.y + 30, 120, r.h - 40); }
  }
  const P = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(r.x + x * r.w, r.y + y * r.h, w * r.w, h * r.h); };
  if (type === 'workshop') { P(0.06, 0.62, 0.3, 0.06, '#5a5560'); P(0.08, 0.68, 0.03, 0.27, '#2a282e'); P(0.31, 0.68, 0.03, 0.27, '#2a282e'); P(0.12, 0.45, 0.1, 0.17, '#1b1d1e'); P(0.135, 0.48, 0.07, 0.1, '#2f7a4a'); P(0.62, 0.62, 0.3, 0.06, '#5a5560'); P(0.7, 0.3, 0.2, 0.2, '#2a282e'); }
  if (type === 'library') { for (let i = 0; i < 4; i++) { P(0.05 + i * 0.07, 0.25, 0.06, 0.7, '#2a282e'); for (let j = 0; j < 5; j++) P(0.055 + i * 0.07, 0.3 + j * 0.13, 0.05, 0.05, j % 2 ? '#6b5a3a' : '#4c4f57'); } P(0.6, 0.62, 0.25, 0.05, '#5a5560'); P(0.7, 0.5, 0.04, 0.12, '#c9a227'); }
  if (type === 'server') { for (let i = 0; i < 4; i++) { P(0.05 + i * 0.1, 0.2, 0.08, 0.75, '#1a1b1f'); for (let j = 0; j < 8; j++) P(0.06 + i * 0.1, 0.25 + j * 0.08, 0.015, 0.02, Math.floor(now / 300 + i * 3 + j) % 4 ? '#2fbf5a' : '#0d2a16'); } P(0.6, 0.45, 0.3, 0.5, '#3a3a40'); P(0.7, 0.55, 0.1, 0.12, '#c9a227'); }
  if (type === 'lab') { P(0.65, 0.2, 0.18, 0.75, '#1a2a26'); P(0.67, 0.25, 0.14, 0.62, `rgba(60,200,120,${0.35 + 0.1 * Math.sin(now / 500)})`); P(0.08, 0.62, 0.35, 0.05, '#5a5560'); P(0.12, 0.52, 0.03, 0.1, '#7fc9a0'); P(0.2, 0.55, 0.03, 0.07, '#c9a227'); }
  if (type === 'command') { for (let i = 0; i < 6; i++) { P(0.08 + i * 0.14, 0.2, 0.11, 0.16, '#141618'); P(0.09 + i * 0.14, 0.22, 0.09, 0.12, i % 3 === 1 ? '#7a1a14' : '#1f5a36'); } P(0.3, 0.62, 0.4, 0.08, '#4a4850'); P(0.32, 0.7, 0.36, 0.25, '#2a282e'); }
  if (type === 'hall') {
    P(0.3, 0.18, 0.4, 0.28, '#2a2620'); P(0.31, 0.2, 0.38, 0.24, '#4a4030');
    for (let k = 0; k < 7; k++) P(0.33 + ((k * 37) % 30) / 100, 0.24 + ((k * 13) % 16) / 100, 0.008, 0.016, '#c01a14');
    for (let i = 0; i < 4; i++) { P(0.05 + i * 0.24, 0.66, 0.16, 0.05, '#5a5560'); P(0.08 + i * 0.24, 0.53, 0.06, 0.13, '#141618'); P(0.09 + i * 0.24, 0.55, 0.04, 0.08, i % 2 ? '#1f5a36' : '#2f7a4a'); }
  }
  if (type === 'garage') {
    P(0.35, 0.5, 0.42, 0.28, '#4a3a2a'); P(0.4, 0.38, 0.22, 0.14, '#3a2e22'); P(0.42, 0.4, 0.08, 0.08, '#5a7a8a');
    P(0.38, 0.76, 0.08, 0.12, '#141214'); P(0.66, 0.76, 0.08, 0.12, '#141214'); P(0.33, 0.86, 0.46, 0.04, '#c9a227');
    for (let i = 0; i < 3; i++) P(0.05 + i * 0.07, 0.68, 0.055, 0.25, i % 2 ? '#6a2a1a' : '#2a4a2a');
    P(0.86, 0.3, 0.1, 0.4, '#2a282e');
  }
  if (type === 'vault') {
    for (let i = 0; i < 3; i++) { P(0.05 + i * 0.17, 0.22, 0.14, 0.73, '#2a282e'); for (let j = 0; j < 4; j++) P(0.06 + i * 0.17, 0.27 + j * 0.17, 0.12, 0.1, ['#5a4a30', '#3a4a5a', '#4a3a3a', '#5a5a40'][(i + j) % 4]); }
    ctx.fillStyle = '#4a4850'; ctx.beginPath(); ctx.arc(r.x + r.w * 0.8, r.y + r.h * 0.55, r.h * 0.26, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2a282e'; ctx.beginPath(); ctx.arc(r.x + r.w * 0.8, r.y + r.h * 0.55, r.h * 0.2, 0, Math.PI * 2); ctx.fill();
    P(0.79, 0.5, 0.02, 0.1, '#c9a227');
  }
}

function drawDig(r) {
  if (!r) return;
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
  ctx.fillText('+ NEW PROJECT', r.x + r.w / 2, r.y + r.h / 2);
  ctx.font = `18px ${BODY_FONT}`;
  ctx.fillStyle = '#9a958c';
  ctx.fillText('tap to dig a room and move agents in', r.x + r.w / 2, r.y + r.h / 2 + 24);
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
  const set = art.chars[z.kind] || art.chars.zombie;
  const anim = z.state === 'walk' ? 'walk' : z.state === 'attack' ? (set.attack ? 'attack' : 'idle') : (set.hit ? 'hit' : 'idle');
  let p = pose(set, anim, z.state === 'hit' || z.state === 'dead' ? Math.min(z.st, 0.6) : z.t, 92, z.state === 'attack' ? 8 : 6);
  if (z.state === 'dead' && set.hit) { const fr = set.hit; p = { ...p, f: fr[fr.length - 1] }; }
  if (!p) return;
  ctx.save();
  ctx.globalAlpha = 0.95 * Math.max(0, z.fade);
  ctx.translate(Math.round(z.x), z.y);
  // Facing the wall; the original zombie art has no death row, so it topples over instead.
  const toward = -z.side;
  if (toward < 0) ctx.scale(-1, 1);
  if (z.state === 'attack') ctx.translate(Math.floor(z.t * 8) % 2 ? 4 : 0, 0);
  if (z.state === 'hit') ctx.rotate(-0.15);
  if (z.state === 'dead' && !set.hit) ctx.rotate(-Math.min(1.45, z.st * 5));
  ctx.drawImage(p.f, Math.round(-p.w / 2), -p.h, p.w, p.h);
  if (z.state === 'hit') { ctx.globalCompositeOperation = 'source-atop'; ctx.fillStyle = 'rgba(255,40,30,0.35)'; ctx.fillRect(-p.w / 2, -p.h, p.w, p.h); }
  ctx.restore();
}

function drawCharacter(e, anims, anim, targetH, o) {
  const p = pose(anims, anim, e.t, targetH, anim === 'panic' ? 12 : 9);
  const h = p ? p.h : targetH;
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
    ctx.fillText(`> ${o.activity}${'.'.repeat(Math.floor(o.now / 400) % 4)}`, x, y - h - 10);
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

/** Point the camera at a world position (used by the screenshot tests). */
export function lookAt(x, y) { fly = null; cam.x = x; cam.y = y; }
