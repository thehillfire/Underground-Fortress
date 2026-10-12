// World themes: five procedural looks for the SAME world (same layout, state, behavior).
//
//   fortress     the original underground bunker (default; game.js uses its own code, so it stays pixel-identical)
//   spaceship    Lidia = Ship's AI Core (glowing brain in a jar)
//   westernTown  Lidia = Sheriff
//   pirateCove   Lidia = Captain
//   cyberpunk    Cyberpunk Village, Lidia = Mainframe
//
// A theme is a plain object in WORLD_THEMES. Every art hook is optional per theme and swappable per id:
// a hand-drawn pass can replace any single hook (or the whole entry) without touching game.js.
// See docs/theme-sdk.md. Sound lives in sound.js; accessibility CSS in a11y.css.
import { art } from './assets.js';
import * as sound from './sound.js';

// ------------------------------------------------------------------ tiny helpers
const rng = (seed) => { let s = Math.abs(Math.floor(seed)) % 2147483647 || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); };
const hash = (a, b = 0) => { const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); };
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const rect = (ctx) => (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
const grad = (ctx, y0, y1, stops) => { const g = ctx.createLinearGradient(0, y0, 0, y1); stops.forEach(([o, c]) => g.addColorStop(o, c)); return g; };

function outlineC(src, col = '#070506') {
  const c = mk(src.width + 2, src.height + 2), g = c.getContext('2d');
  const sil = mk(src.width, src.height), sg = sil.getContext('2d');
  sg.drawImage(src, 0, 0); sg.globalCompositeOperation = 'source-in'; sg.fillStyle = col; sg.fillRect(0, 0, sil.width, sil.height);
  for (const [dx, dy] of [[0, 1], [2, 1], [1, 0], [1, 2]]) g.drawImage(sil, dx, dy);
  g.drawImage(src, 1, 1);
  return c;
}
function sprite(w, h, fn) {
  const c = mk(w, h), g = c.getContext('2d');
  fn((x, y, ww, hh, col) => { g.fillStyle = col; g.fillRect(x, y, ww, hh); }, g);
  return outlineC(c);
}
const animSet = (names, fn) => Object.fromEntries(names.map(a => [a, Array.from({ length: 6 }, (_, i) => fn(a, i))]));

// Recolor a whole sprite set (cached per set + theme). `color` blend keeps the shading, swaps the hues.
const skinCache = new WeakMap();
function recolor(anims, id, spec) {
  if (!anims || !spec) return anims;
  let per = skinCache.get(anims);
  if (!per) skinCache.set(anims, per = new Map());
  if (per.has(id + spec.color)) return per.get(id + spec.color);
  const out = {};
  for (const [k, frames] of Object.entries(anims)) out[k] = frames.map((f) => {
    const c = mk(f.width, f.height), g = c.getContext('2d');
    g.drawImage(f, 0, 0);
    g.globalCompositeOperation = spec.mode || 'color'; g.globalAlpha = spec.alpha ?? 0.4; g.fillStyle = spec.color; g.fillRect(0, 0, c.width, c.height);
    g.globalAlpha = 1; g.globalCompositeOperation = 'destination-in'; g.drawImage(f, 0, 0);
    return c;
  });
  per.set(id + spec.color, out);
  return out;
}

// ------------------------------------------------------------------ shared drawing kits
function stripes(ctx, x, y, w, h, c1, c2, step = 16) {
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = c1; ctx.fillRect(x, y, w, h); ctx.fillStyle = c2;
  for (let i = -h; i < w + h; i += step) { ctx.beginPath(); ctx.moveTo(x + i, y + h); ctx.lineTo(x + i + step / 2, y + h); ctx.lineTo(x + i + step / 2 + h, y); ctx.lineTo(x + i + h, y); ctx.fill(); }
  ctx.restore();
}

/** Earth/backdrop tile fill: a theme draws one small tile once, we repeat it. */
const tileCache = new Map();
function tiled(ctx, key, size, draw, x0, y0, w, h) {
  let t = tileCache.get(key);
  if (!t) { t = mk(size, size); draw(t.getContext('2d'), size); tileCache.set(key, t); }
  ctx.fillStyle = ctx.createPattern(t, 'repeat'); ctx.fillRect(x0, y0, w, h);
}

function depthShade(ctx, x0, x1, y1, a = 0.7) {
  ctx.fillStyle = grad(ctx, 0, y1, [[0, 'rgba(0,0,0,0)'], [1, `rgba(0,0,0,${a})`]]);
  ctx.fillRect(x0, 0, x1 - x0, y1);
}

/** Shared room shell: backing, themed interior, shade, alert wash, floor slab, status light, glow, label plate. */
function roomShell(T, ctx, r, type, label, glow, now, alert, count, G) {
  const pal = T.palette;
  ctx.save();
  ctx.fillStyle = pal.void; ctx.fillRect(r.x - 10, r.y - 10, r.w + 20, r.h + 10 + G.SLAB);
  ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
  T.roomBody(ctx, r, type, now);
  ctx.fillStyle = grad(ctx, r.y, r.y + r.h, [[0, 'rgba(0,0,0,0.35)'], [0.35, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.25)']]);
  ctx.fillRect(r.x, r.y, r.w, r.h);
  const flick = alert ? (Math.floor(now / 350) % 2 ? 0.3 : 0.1) : 0;
  if (flick) { ctx.fillStyle = `rgba(${pal.alertRGB},${flick})`; ctx.fillRect(r.x, r.y, r.w, r.h); }
  ctx.restore();
  ctx.fillStyle = pal.floor; ctx.fillRect(r.x - 10, r.y + r.h, r.w + 20, G.SLAB);
  ctx.fillStyle = pal.floorGroove; for (let x = r.x - 10; x < r.x + r.w + 10; x += 8) ctx.fillRect(x, r.y + r.h + 6, 4, G.SLAB - 10);
  ctx.fillStyle = pal.floorTop; ctx.fillRect(r.x - 10, r.y + r.h, r.w + 20, 3);
  const on = alert ? Math.floor(now / 350) % 2 : Math.floor(now / 1400 + r.y) % 2;
  ctx.fillStyle = on ? pal.statusOn : pal.statusOff; ctx.fillRect(r.x + r.w - 26, r.y + 8, 12, 8);
  if (on) { ctx.fillStyle = `rgba(${pal.alertRGB},0.16)`; ctx.fillRect(r.x + r.w - 46, r.y + 4, 52, 40); }
  if (glow) { ctx.strokeStyle = glow; ctx.lineWidth = 4; ctx.strokeRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8); }
  ctx.font = `12px ${T.fonts.title}`;
  const tag = count != null ? ` · ${count}` : '';
  const tw = Math.min(ctx.measureText(label + tag).width + 14, r.w - 60);
  ctx.fillStyle = pal.plate; ctx.fillRect(r.x + 8, r.y + 8, tw, 20);
  ctx.fillStyle = pal.accent; ctx.fillRect(r.x + 8, r.y + 8, 3, 20);
  ctx.fillStyle = pal.plateText; ctx.fillText(label + tag, r.x + 16, r.y + 22, tw - 12);
  ctx.restore();
}

function digShell(T, ctx, r) {
  const pal = T.palette;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.setLineDash([12, 8]); ctx.strokeStyle = pal.accent; ctx.lineWidth = 4;
  ctx.strokeRect(r.x + 8, r.y + 8, r.w - 16, r.h - 16); ctx.setLineDash([]);
  ctx.fillStyle = pal.accent; ctx.font = `20px ${T.fonts.title}`; ctx.textAlign = 'center';
  ctx.fillText(T.digText[0], r.x + r.w / 2, r.y + r.h / 2);
  ctx.font = `18px ${T.fonts.body}`; ctx.fillStyle = pal.muted;
  ctx.fillText(T.digText[1], r.x + r.w / 2, r.y + r.h / 2 + 24);
  ctx.restore();
}

function ladderShell(T, ctx, l) {
  const h = l.y1 - l.y0, p = T.palette;
  if (h <= 0) return;
  ctx.fillStyle = p.void; ctx.fillRect(l.x - 6, l.y0, 36, h);
  ctx.fillStyle = p.ladderBack; ctx.fillRect(l.x, l.y0, 24, h);
  ctx.fillStyle = p.ladder; ctx.fillRect(l.x + 2, l.y0, 3, h); ctx.fillRect(l.x + 19, l.y0, 3, h);
  for (let y = l.y0 + 6; y < l.y1; y += 14) ctx.fillRect(l.x + 2, y, 20, 3);
}

function tunnelShell(T, ctx, x, w, y0, y1, G, now) {
  const p = T.palette;
  ctx.fillStyle = p.void; ctx.fillRect(x, y0 - 8, w, G.TUNNEL_H + 8 + G.SLAB);
  ctx.fillStyle = p.tunnel; ctx.fillRect(x, y0, w, G.TUNNEL_H);
  T.tunnelDecor(ctx, x, w, y0, y1, now);
  ctx.fillStyle = p.floor; ctx.fillRect(x, y1, w, G.SLAB);
  ctx.fillStyle = p.floorGroove; for (let gx = x; gx < x + w; gx += 8) ctx.fillRect(gx, y1 + 6, 4, G.SLAB - 10);
  ctx.fillStyle = p.floorTop; ctx.fillRect(x, y1, w, 3);
}

function pocketShell(T, ctx, p, G, now) {
  const pal = T.palette;
  ctx.fillStyle = pal.void; ctx.fillRect(p.x - 8, p.y - 8, p.w + 16, p.h + 8 + G.SLAB);
  ctx.fillStyle = pal.tunnel; ctx.fillRect(p.x, p.y, p.w, p.h);
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; for (let x = p.x; x < p.x + p.w; x += 38) ctx.fillRect(x, p.y, 3, p.h);
  T.pocketDecor(ctx, p, now);
  ctx.fillStyle = pal.floor; ctx.fillRect(p.x - 8, p.y + p.h, p.w + 16, G.SLAB);
  ctx.fillStyle = pal.floorTop; ctx.fillRect(p.x - 8, p.y + p.h, p.w + 16, 3);
  ctx.font = `10px ${T.fonts.title}`; ctx.fillStyle = pal.muted;
  ctx.fillText((T.pocketNames[p.kind] || p.kind).toUpperCase(), p.x + 8, p.y + 16);
}

// ================================================================== SPACESHIP
const SHIP = {
  id: 'spaceship', label: 'Spaceship',
  palette: { void: '#02040a', accent: '#4cd4ff', muted: '#7d93ad', text: '#cfeaff', plate: 'rgba(3,8,16,0.88)', plateText: '#d6ecff',
    floor: '#222d40', floorGroove: '#121a28', floorTop: '#4cd4ff', tunnel: '#141c2b', ladder: '#3b4c68', ladderBack: '#0e1522',
    statusOn: '#ff9a3c', statusOff: '#3a2410', alertRGB: '255,90,60', ui: '#4cd4ff', bg: '#02040a' },
  fonts: { title: '"Orbitron", "Silkscreen", monospace', body: '"Share Tech Mono", "VT323", monospace', google: 'Orbitron:wght@600&family=Share+Tech+Mono' },
  lidiaName: "SHIP'S AI CORE", lidiaColor: '#7ee8ff', enemyName: 'Alien',
  roomLabels: { workshop: 'Fabricator', library: 'Data Core', server: 'Reactor', lab: 'Bio Lab', hall: 'Ops Deck', garage: 'Hangar', vault: 'Cryo Vault' },
  fixedLabels: { comms: 'COMMS / ARMORY', command: 'BRIDGE' },
  digText: ['+ NEW MODULE', 'tap to build a module and move crew in'],
  pocketNames: { generator: 'fusion core', pumps: 'coolant', water: 'o2 recycler' },
  agentSkin: { color: '#7ec8ff', alpha: 0.3 }, enemySkin: { color: '#9a4dff', alpha: 0.55 }, defenderSkin: { color: '#4cd4ff', alpha: 0.35 },
  earth(ctx, x0, x1, y1) {
    tiled(ctx, 'ship-hull', 192, (g, n) => {
      const P = rect(g), R = rng(11);
      P(0, 0, n, n, '#0c121c');
      for (let y = 0; y < n; y += 48) for (let x = 0; x < n; x += 64) {
        P(x, y, 64, 48, ((x / 64 + y / 48) % 2) ? '#101826' : '#0e1520');
        P(x, y, 64, 2, '#1b2638'); P(x, y, 2, 48, '#080c14');
        for (const [rx, ry] of [[5, 5], [57, 5], [5, 41], [57, 41]]) P(x + rx, y + ry, 2, 2, '#2a3a54');
      }
      for (let i = 0; i < 6; i++) { const y = Math.floor(R() * 4) * 48 + 20; P(0, y, n, 2, 'rgba(76,212,255,0.14)'); }
    }, x0, 0, x1 - x0, y1);
    depthShade(ctx, x0, x1, y1);
  },
  surface(ctx, now) {
    const P = rect(ctx), H = 1100;
    P(-6000, -H - 2000, 12000, 2000, '#02030a');
    ctx.fillStyle = grad(ctx, -H, 0, [[0, '#02030a'], [0.6, '#0a1230'], [1, '#18305e']]); ctx.fillRect(-6000, -H, 12000, H);
    for (const [cx, cy, r, c] of [[-1400, -700, 380, 'rgba(120,60,200,0.10)'], [1200, -500, 460, 'rgba(40,150,220,0.09)'], [100, -900, 300, 'rgba(200,60,150,0.07)']]) {
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
    }
    for (let i = 0; i < 260; i++) {
      const x = -3200 + hash(i) * 6400, y = -H + 40 + hash(i, 2) * (H - 140), a = 0.35 + 0.65 * Math.abs(Math.sin(now / (600 + hash(i, 3) * 900) + i));
      ctx.fillStyle = `rgba(220,240,255,${a})`; ctx.fillRect(Math.round(x), Math.round(y), hash(i, 4) > 0.85 ? 4 : 2, hash(i, 4) > 0.85 ? 4 : 2);
    }
    const pg = ctx.createRadialGradient(760, -700, 20, 800, -680, 230);
    pg.addColorStop(0, '#6ab0ff'); pg.addColorStop(0.6, '#2a5aa8'); pg.addColorStop(1, '#0c1c44');
    ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(800, -680, 200, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(200,220,255,0.5)'; ctx.lineWidth = 6; ctx.beginPath(); ctx.ellipse(800, -680, 310, 62, -0.35, 0, 7); ctx.stroke();
    ctx.fillStyle = '#9aa7b8'; ctx.beginPath(); ctx.arc(-1100, -520, 56, 0, 7); ctx.fill(); ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.arc(-1085, -508, 44, 0, 7); ctx.fill();
    // far station
    P(-1900, -300, 360, 12, '#1d2a40'); P(-1740, -380, 20, 92, '#1d2a40'); P(-1830, -330, 200, 10, '#2a3a58');
    P(-1744, -392, 28, 12, Math.floor(now / 500) % 2 ? '#ff9a3c' : '#4a2a10');
    // outer hull deck
    P(-6000, -46, 12000, 46, '#18212f'); P(-6000, -46, 12000, 4, '#4cd4ff');
    for (let x = -6000; x < 6000; x += 90) { P(x, -42, 3, 42, '#0c121c'); }
    for (let x = -5900; x < 6000; x += 180) P(x, -40, 8, 4, Math.floor(now / 400 + x / 180) % 3 ? '#4cd4ff' : '#143648');
    for (const ax of [-1500, -1100, 1180, 1500]) { P(ax, -120, 6, 76, '#2a3a58'); P(ax - 20, -96, 46, 4, '#2a3a58'); P(ax - 2, -126, 10, 8, Math.floor(now / 700 + ax) % 2 ? '#ff4a3a' : '#4a1410'); }
    P(-6000, 0, 12000, 10, '#0c1018');
  },
  wall(ctx, W, H) {
    const P = rect(ctx), x0 = -W / 2, t = performance.now();
    P(x0, -30, W, 30, '#222d40'); P(x0, -30, W, 3, '#4cd4ff');
    for (const px of [x0 + 6, x0 + W - 30]) { P(px, -H + 24, 24, H - 54, '#2b3a55'); P(px + 4, -H + 24, 4, H - 54, '#4a5e80'); P(px + 6, -H + 34, 12, 12, '#4cd4ff'); P(px + 6, -90, 12, 12, '#4cd4ff'); }
    const a = 0.22 + 0.1 * Math.sin(t / 300);
    ctx.fillStyle = grad(ctx, -H + 30, -30, [[0, `rgba(76,212,255,${a + 0.12})`], [1, `rgba(76,212,255,${a})`]]);
    ctx.fillRect(x0 + 30, -H + 30, W - 60, H - 60);
    ctx.fillStyle = 'rgba(200,245,255,0.55)';
    for (let y = -H + 36; y < -34; y += 14) ctx.fillRect(x0 + 30, y + ((t / 40) % 14), W - 60, 1);
    P(x0 - 10, -H + 14, W + 20, 8, '#3b4c68');
  },
  shaft: (ctx, bottom, G, now) => shaftKit(SHIP, ctx, bottom, G, now, { core: '#070d18', rail: '#2b3a55', rail2: '#4cd4ff', slabA: '#1d2a40', slabB: '#4cd4ff', pulse: 'rgba(76,212,255,0.55)', step: 56 }),
  tunnelDecor(ctx, x, w, y0, y1, now) {
    const P = rect(ctx);
    for (let bx = x; bx < x + w; bx += 40) P(bx, y0, 4, 92, '#1d2a40');
    P(x, y0 + 6, w, 5, '#223149'); P(x, y0 + 14, w, 3, '#0e1522');
    for (let lx = x + 20; lx < x + w - 10; lx += 90) {
      const lit = Math.floor(now / 140 + lx) % 31 !== 0;
      P(lx, y0 + 20, 36, 4, lit ? '#bfeaff' : '#2a3a48');
      if (lit) { ctx.fillStyle = 'rgba(120,220,255,0.07)'; ctx.fillRect(lx - 24, y0 + 24, 84, 68); }
    }
    for (let sx = x + 10; sx < x + w - 10; sx += 120) P(sx, y1 - 18, 10, 18, '#243249');
  },
  pocketDecor(ctx, p, now) {
    const P = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(p.x + x, p.y + y, w, h); };
    if (p.kind === 'generator') { P(40, p.h - 110, 90, 96, '#1d2a40'); const g = 0.4 + 0.3 * Math.sin(now / 300); P(60, p.h - 90, 50, 50, `rgba(76,212,255,${g})`); P(70, p.h - 80, 30, 30, '#d8f6ff'); }
    else if (p.kind === 'pumps') { P(30, 40, p.w - 60, 10, '#2b3a55'); P(50, 50, 12, p.h - 70, '#2b3a55'); P(120, 50, 12, p.h - 70, '#2b3a55'); P(40 + (Math.floor(now / 250) % 4) * 6, p.h - 60, 6, 10, '#4cd4ff'); }
    else { P(30, 36, 60, p.h - 50, '#16303a'); P(100, 56, 60, p.h - 70, '#16303a'); P(34, 40 + (p.h - 50) * 0.4, 52, (p.h - 50) * 0.6, 'rgba(60,220,140,0.4)'); P(104, 60 + (p.h - 70) * 0.5, 52, (p.h - 70) * 0.5, 'rgba(60,220,140,0.4)'); }
  },
  roomBody(ctx, r, type, now) {
    const P = rect(ctx), F = (x, y, w, h, c) => P(r.x + x * r.w, r.y + y * r.h, w * r.w, h * r.h, c);
    P(r.x, r.y, r.w, r.h, '#1a2434');
    for (let x = r.x; x < r.x + r.w; x += 60) { P(x, r.y, 3, r.h, 'rgba(0,0,0,0.4)'); P(x + 3, r.y, 2, r.h, 'rgba(160,210,255,0.06)'); for (let y = r.y + 30; y < r.y + r.h; y += 40) { P(x + 8, y, 3, 3, 'rgba(0,0,0,0.45)'); } }
    P(r.x, r.y + 2, r.w, 8, '#10182a'); P(r.x, r.y + 12, r.w, 3, '#4cd4ff');
    const tubes = Math.max(2, Math.round(r.w / 220));
    for (let i = 0; i < tubes; i++) { const tx = r.x + r.w * ((i + 0.5) / tubes) - 40; P(tx, r.y + 24, 80, 4, '#d4f2ff'); ctx.fillStyle = 'rgba(160,225,255,0.05)'; ctx.fillRect(tx - 30, r.y + 28, 140, r.h - 40); }
    const wx = r.x + r.w * (0.42 + hash(r.x) * 0.2);
    P(wx, r.y + r.h * 0.3, 64, 64, '#0a0f1a'); P(wx + 4, r.y + r.h * 0.3 + 4, 56, 56, '#03060f');
    for (let k = 0; k < 7; k++) P(wx + 8 + hash(k, r.x) * 44, r.y + r.h * 0.3 + 8 + hash(k, 5) * 44, 2, 2, '#fff');
    if (type === 'workshop') { F(0.06, 0.64, 0.3, 0.06, '#4a5a74'); F(0.08, 0.7, 0.03, 0.25, '#222d40'); F(0.31, 0.7, 0.03, 0.25, '#222d40'); F(0.18, 0.3, 0.02, 0.34, '#6a7a94'); F(0.14, 0.3, 0.1, 0.03, '#6a7a94'); F(0.14, 0.33, 0.03, 0.1, Math.floor(now / 200) % 2 ? '#ff9a3c' : '#a05a1c'); F(0.64, 0.64, 0.28, 0.06, '#4a5a74'); }
    if (type === 'library') { for (let i = 0; i < 4; i++) { F(0.05 + i * 0.07, 0.25, 0.06, 0.7, '#222d40'); for (let j = 0; j < 5; j++) F(0.058 + i * 0.07, 0.3 + j * 0.13, 0.045, 0.06, (i + j) % 2 ? '#2a9fd0' : '#7a5ad6'); } F(0.62, 0.62, 0.22, 0.05, '#4a5a74'); F(0.7, 0.4, 0.06, 0.22, `rgba(76,212,255,${0.4 + 0.2 * Math.sin(now / 400)})`); }
    if (type === 'server') { for (let i = 0; i < 4; i++) { F(0.05 + i * 0.1, 0.2, 0.08, 0.75, '#0e1522'); for (let j = 0; j < 8; j++) F(0.06 + i * 0.1, 0.25 + j * 0.08, 0.015, 0.02, Math.floor(now / 300 + i * 3 + j) % 4 ? '#4cd4ff' : '#0a2a38'); } F(0.62, 0.45, 0.28, 0.5, '#2a3650'); F(0.7, 0.55, 0.1, 0.12, '#ff9a3c'); }
    if (type === 'lab') { for (const fx of [0.62, 0.78]) { F(fx, 0.2, 0.12, 0.75, '#122a2c'); F(fx + 0.01, 0.25, 0.1, 0.62, `rgba(70,255,170,${0.35 + 0.1 * Math.sin(now / 500 + fx)})`); for (let b = 0; b < 3; b++) F(fx + 0.03 + b * 0.025, 0.8 - ((now / 2000 + b * 0.3) % 1) * 0.5, 0.01, 0.015, 'rgba(220,255,240,0.7)'); } F(0.08, 0.64, 0.35, 0.05, '#4a5a74'); F(0.12, 0.52, 0.03, 0.12, '#7fe3ff'); }
    if (type === 'command') { F(0.1, 0.18, 0.8, 0.3, '#0a1220'); F(0.11, 0.2, 0.78, 0.26, '#0e2a44'); for (let i = 0; i < 9; i++) F(0.14 + hash(i, 1) * 0.7, 0.23 + hash(i, 2) * 0.2, 0.01, 0.015, '#bfe8ff'); F(0.3, 0.64, 0.4, 0.07, '#3b4c68'); F(0.33, 0.71, 0.34, 0.24, '#222d40'); F(0.4, 0.5, 0.2, 0.14, 'rgba(76,212,255,0.25)'); }
    if (type === 'hall') { F(0.34, 0.2, 0.32, 0.32, 'rgba(76,212,255,0.14)'); ctx.strokeStyle = 'rgba(120,225,255,0.7)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(r.x + r.w * 0.5, r.y + r.h * 0.36, r.h * 0.12, 0, 7); ctx.stroke(); for (let i = 0; i < 4; i++) { F(0.05 + i * 0.24, 0.68, 0.16, 0.05, '#3b4c68'); F(0.08 + i * 0.24, 0.55, 0.06, 0.13, '#0e1522'); F(0.09 + i * 0.24, 0.57, 0.04, 0.08, i % 2 ? '#1f6a8a' : '#2a9fd0'); } }
    if (type === 'garage') { F(0.3, 0.55, 0.46, 0.22, '#5a6a86'); F(0.4, 0.42, 0.2, 0.14, '#3b4c68'); F(0.45, 0.45, 0.1, 0.07, '#7fe3ff'); F(0.72, 0.6, 0.12, 0.1, '#2a3650'); F(0.26, 0.78, 0.58, 0.04, '#ff9a3c'); F(0.06, 0.4, 0.1, 0.5, '#222d40'); }
    if (type === 'vault') { for (let i = 0; i < 3; i++) { F(0.05 + i * 0.17, 0.3, 0.14, 0.65, '#16303a'); F(0.065 + i * 0.17, 0.35, 0.11, 0.45, `rgba(140,230,255,${0.25 + 0.08 * Math.sin(now / 600 + i)})`); } ctx.fillStyle = '#3b4c68'; ctx.beginPath(); ctx.arc(r.x + r.w * 0.8, r.y + r.h * 0.55, r.h * 0.26, 0, 7); ctx.fill(); ctx.fillStyle = '#16202e'; ctx.beginPath(); ctx.arc(r.x + r.w * 0.8, r.y + r.h * 0.55, r.h * 0.19, 0, 7); ctx.fill(); F(0.79, 0.5, 0.02, 0.1, '#4cd4ff'); }
  },
  lidiaAnims() {
    return animSet(['walk', 'idle', 'command'], (anim, i) => sprite(18, 30, (P) => {
      const yb = anim === 'walk' ? i % 2 : (i % 6 < 3 ? 0 : 1);
      // hover thruster + base
      P(7, 27, 4, anim === 'walk' ? 3 : 2 + (i % 2), '#4cd4ff'); P(8, 27, 2, 1, '#ffffff');
      P(3, 24, 12, 3, '#3b4660'); P(5, 27, 8, 1, '#232b3d'); P(4, 25, 1, 1, i % 2 ? '#ff9a3c' : '#7a4a1c'); P(13, 25, 1, 1, '#4cd4ff');
      // jar
      P(3, 6 + yb, 12, 18, '#1c3f55'); P(4, 8 + yb, 10, 15, '#256c8a'); P(4, 8 + yb, 1, 13, '#7fe3ff'); P(13, 10 + yb, 1, 9, '#164a63');
      P(3, 4 + yb, 12, 3, '#6a7894'); P(7, 2 + yb, 4, 2, '#8c9bb5'); P(15, 12 + yb, 2, 1, '#8a97ad'); P(16, 12 + yb, 1, 9, '#8a97ad');
      // brain (pulses)
      const big = i % 6 < 3, bx = big ? 4 : 5, bw = big ? 10 : 8;
      P(bx, 10 + yb, bw, 7, '#ee8fac'); P(bx + 1, 9 + yb, bw - 2, 1, '#ee8fac'); P(bx + 1, 11 + yb, bw - 2, 1, '#b85f7c'); P(bx + 2, 13 + yb, bw - 4, 1, '#b85f7c'); P(9, 10 + yb, 1, 6, '#b85f7c');
      P(bx + 1, 15 + yb, 2, 1, '#b85f7c'); P(8, 17 + yb, 2, 4, '#c8718c');
      if (anim === 'command') { P(1 + (i % 3), 8 + yb, 1, 1, '#ffffff'); P(15 - (i % 3), 15 + yb, 1, 1, '#4cd4ff'); P(2, 14 + yb, 2, 1, '#4cd4ff'); }
      if (anim === 'idle' && i % 6 === 0) P(6, 9 + yb, 6, 1, '#ffd0de');
    }));
  },
  portrait() {
    return outlineC(sprite(44, 56, (P) => {
      P(6, 48, 32, 8, '#3b4660'); P(8, 46, 28, 3, '#232b3d'); P(10, 6, 24, 6, '#6a7894'); P(16, 3, 12, 4, '#8c9bb5');
      P(10, 10, 24, 38, '#1c3f55'); P(12, 12, 20, 33, '#256c8a'); P(12, 12, 2, 28, '#7fe3ff');
      P(14, 20, 16, 14, '#ee8fac'); P(16, 18, 12, 3, '#ee8fac'); P(16, 24, 12, 2, '#b85f7c'); P(15, 29, 14, 2, '#b85f7c'); P(22, 20, 1, 12, '#b85f7c'); P(21, 34, 3, 8, '#c8718c');
      P(34, 22, 6, 2, '#8a97ad'); P(38, 22, 2, 20, '#8a97ad'); P(14, 40, 4, 1, '#4cd4ff');
    }), '#0a1018');
  },
  ambient(ctx, v, now, layer) {
    if (layer !== 'front') return;
    const vw = v.x1 - v.x0, vh = v.y1 - v.y0;
    for (let i = 0; i < 46; i++) {
      const x = v.x0 + ((hash(i) * vw + now * 0.012 * (0.4 + hash(i, 1))) % vw), y = v.y0 + ((hash(i, 2) * vh + now * 0.006 * (hash(i, 3) - 0.3)) % vh + vh) % vh;
      ctx.fillStyle = `rgba(150,225,255,${0.12 + 0.2 * Math.abs(Math.sin(now / 800 + i))})`; ctx.fillRect(Math.round(x), Math.round(y), 2, 2);
    }
    const k = Math.floor(now / 8000), ph = (now % 8000) / 900;
    if (ph < 1 && v.y0 < -100) {
      const sx = v.x0 + hash(k) * vw, sy = Math.max(v.y0, -900) + hash(k, 2) * 200;
      ctx.strokeStyle = `rgba(220,240,255,${1 - ph})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(sx + ph * 380, sy + ph * 150); ctx.lineTo(sx + ph * 380 - 80, sy + ph * 150 - 31); ctx.stroke();
    }
  },
  soundSpec: {
    master: 0.5,
    drones: [{ type: 'sine', freq: 55, gain: 0.07, detune: 5, lfo: { rate: 0.07, depth: 0.35 } }, { type: 'triangle', freq: 110.5, gain: 0.025, lfo: { rate: 0.11, depth: 0.6 } }, { type: 'sine', freq: 329.6, gain: 0.008, lfo: { rate: 0.2, depth: 0.9 } }],
    noise: [{ color: 'brown', gain: 0.03, filter: { type: 'lowpass', freq: 240 } }],
    events: [{ fx: 'blip', every: [3, 9], gain: 0.05 }, { fx: 'ping', every: [10, 24], gain: 0.05 }, { fx: 'chime', every: [25, 50], gain: 0.04 }],
    ui: { click: 'blip', message: 'chime', alert: 'alarm', done: 'ping' },
  },
};

// ================================================================== WESTERN TOWN
const WEST = {
  id: 'westernTown', label: 'Western Town',
  palette: { void: '#150b05', accent: '#e8b04a', muted: '#b89a6c', text: '#f3dfb6', plate: 'rgba(40,22,10,0.9)', plateText: '#f6e6c0',
    floor: '#6b4426', floorGroove: '#3c2412', floorTop: '#a8743c', tunnel: '#3a2412', ladder: '#8a5a30', ladderBack: '#24150a',
    statusOn: '#ffb030', statusOff: '#4a2e10', alertRGB: '230,60,30', ui: '#e8b04a', bg: '#150b05' },
  fonts: { title: '"Rye", "Georgia", serif', body: '"Special Elite", "Courier New", monospace', google: 'Rye&family=Special+Elite' },
  lidiaName: 'SHERIFF', lidiaColor: '#ffd36a', enemyName: 'Outlaw',
  roomLabels: { workshop: 'Smithy', library: 'Records', server: 'Telegraph', lab: 'Apothecary', hall: 'Saloon', garage: 'Stables', vault: 'Bank Vault' },
  fixedLabels: { comms: 'TELEGRAPH / ARMORY', command: "SHERIFF'S OFFICE" },
  digText: ['+ NEW CLAIM', 'tap to stake a claim and move hands in'],
  pocketNames: { generator: 'boiler', pumps: 'windmill pump', water: 'water tower' },
  agentSkin: { color: '#d9a066', alpha: 0.35 }, enemySkin: { color: '#b07038', alpha: 0.55 }, defenderSkin: { color: '#6b8fb8', alpha: 0.3 },
  earth(ctx, x0, x1, y1) {
    tiled(ctx, 'west-strata', 256, (g, n) => {
      const P = rect(g), cols = ['#8c4a2a', '#a65f35', '#6e3a22', '#b57a44', '#7a4128', '#98562f'];
      let y = 0, i = 0;
      while (y < n) { const h = 14 + Math.floor(hash(i) * 30); P(0, y, n, h, cols[i % cols.length]); P(0, y, n, 2, 'rgba(0,0,0,0.25)'); y += h; i++; }
      const R = rng(5);
      for (let k = 0; k < 90; k++) P(Math.floor(R() * n / 4) * 4, Math.floor(R() * n / 4) * 4, 4 + Math.floor(R() * 3) * 4, 4, R() > 0.5 ? 'rgba(0,0,0,0.2)' : 'rgba(255,220,160,0.12)');
    }, x0, 0, x1 - x0, y1);
    depthShade(ctx, x0, x1, y1, 0.78);
  },
  surface(ctx, now) {
    const P = rect(ctx), H = 1100;
    P(-6000, -H - 2000, 12000, 2000, '#4a2a4a');
    ctx.fillStyle = grad(ctx, -H, 0, [[0, '#4a2a4a'], [0.35, '#c4506a'], [0.7, '#f09a58'], [1, '#ffd890']]); ctx.fillRect(-6000, -H, 12000, H);
    const sg = ctx.createRadialGradient(-300, -330, 10, -300, -330, 340); sg.addColorStop(0, 'rgba(255,245,200,1)'); sg.addColorStop(0.3, 'rgba(255,220,140,0.55)'); sg.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = sg; ctx.fillRect(-700, -700, 800, 800); ctx.fillStyle = '#fff2c0'; ctx.beginPath(); ctx.arc(-300, -330, 90, 0, 7); ctx.fill();
    // mesas, three layers
    [['#b4604a', 300, 0.6], ['#92463a', 240, 0.8], ['#6e3030', 190, 1]].forEach(([col, base, k], li) => {
      ctx.fillStyle = col;
      for (let x = -3200, i = 0; x < 3200; i++) { const w = 220 + hash(i, li) * 260, h = base * (0.5 + hash(i, li + 3) * 0.7); const top = -40 - h;
        ctx.fillRect(x, top, w, h + 40); ctx.fillRect(x + 16, top - 18, w - 32, 20); ctx.fillRect(x + 40, top - 30, w - 80, 14); x += w + 40 + hash(i, 9) * 220 * k; }
    });
    // false-front town
    const bcol = ['#6b4426', '#7d5030', '#58361e'];
    for (let i = 0, x = 640; i < 6; i++) { const w = 120 + hash(i) * 50, h = 110 + hash(i, 1) * 60; P(x, -40 - h, w, h, bcol[i % 3]); P(x - 6, -40 - h - 22, w + 12, 26, bcol[(i + 1) % 3]); P(x + 14, -40 - h + 20, 24, 30, '#ffd070'); P(x + w - 40, -40 - h + 20, 24, 30, '#ffd070'); P(x + w / 2 - 12, -40 - 44, 24, 44, '#2a170c'); x += w + 14; }
    for (let i = 0, x = -1400; i < 5; i++) { const w = 120 + hash(i, 4) * 50, h = 100 + hash(i, 5) * 60; P(x, -40 - h, w, h, bcol[(i + 2) % 3]); P(x - 6, -40 - h - 22, w + 12, 26, bcol[i % 3]); P(x + 14, -40 - h + 20, 24, 30, '#ffd070'); P(x + w / 2 - 12, -84, 24, 44, '#2a170c'); x -= w + 14 + 40; }
    for (const cx of [-1900, -1000, 420, 1900, 2300]) { P(cx, -150, 14, 110, '#3f7a3a'); P(cx - 22, -118, 12, 40, '#3f7a3a'); P(cx - 22, -118, 34, 10, '#3f7a3a'); P(cx + 14, -100, 12, 30, '#3f7a3a'); P(cx + 14, -100, -4 + 14, 10, '#3f7a3a'); }
    P(-6000, -40, 12000, 40, '#d9a766');
    for (let x = -6000; x < 6000; x += 24) P(x + hash(x) * 20, -36 + hash(x, 2) * 30, 4, 2, 'rgba(120,70,30,0.35)');
    for (let x = -1700; x < 1700; x += 220) { P(x, -64, 8, 28, '#5a3a1e'); P(x - 30, -58, 70, 5, '#7d5030'); }
    P(-6000, 0, 12000, 10, '#a9743c');
  },
  wall(ctx, W, H) {
    const P = rect(ctx), x0 = -W / 2;
    for (let row = 0; row < 3; row++) for (let i = 0; i < 6; i++) { P(x0 + i * 30 + (row % 2) * 14 - 8, -24 - row * 22, 30, 20, (i + row) % 2 ? '#7d5030' : '#6b4426'); P(x0 + i * 30 + (row % 2) * 14 - 8, -8 - row * 22, 30, 3, 'rgba(0,0,0,0.3)'); }
    for (let x = x0 + 4; x < x0 + W - 6; x += 20) { P(x, -H + 20, 16, H - 90, (x / 20) % 2 ? '#7d5030' : '#6b4426'); P(x, -H + 20, 3, H - 90, 'rgba(255,220,160,0.18)'); P(x + 4, -H + 8 + ((x / 20) % 3) * 6, 8, 14, '#5a3a1e'); }
    P(x0, -H + 50, W, 10, '#4a2e16'); P(x0, -H + 96, W, 10, '#4a2e16');
    for (let k = 0; k < 8; k++) P(x0 + 6 + k * 22, -H + 53, 3, 3, '#c9a35a');
    P(x0 + 18, -64, 20, 26, '#7a1c10'); P(x0 + 22, -60, 12, 4, '#a8743c');
    P(x0 - 10, -H + 14, W + 20, 8, '#8a5a30');
    ctx.strokeStyle = '#9a9a9a'; ctx.lineWidth = 2; ctx.beginPath(); for (let x = x0; x < x0 + W; x += 12) { ctx.lineTo(x, -H + 8 + (Math.floor(x / 12) % 2) * 8); } ctx.stroke();
  },
  shaft: (ctx, bottom, G, now) => shaftKit(WEST, ctx, bottom, G, now, { core: '#1d1108', rail: '#6b4426', rail2: '#a8743c', slabA: '#8a5a30', slabB: '#3c2412', pulse: 'rgba(0,0,0,0)', step: 64, braces: true }),
  tunnelDecor(ctx, x, w, y0, y1, now) {
    const P = rect(ctx);
    for (let bx = x + 6; bx < x + w - 6; bx += 56) { P(bx, y0, 10, 92, '#6b4426'); P(bx - 4, y0, 18, 8, '#8a5a30'); }
    P(x, y0 + 4, w, 8, '#5a3a1e');
    for (let lx = x + 30; lx < x + w - 10; lx += 110) {
      const fl = 0.8 + 0.2 * Math.sin(now / 90 + lx);
      P(lx, y0 + 14, 8, 12, '#2a1a10'); P(lx + 1, y0 + 16, 6, 8, `rgba(255,${180 + fl * 40},70,1)`);
      const g = ctx.createRadialGradient(lx + 4, y0 + 20, 2, lx + 4, y0 + 20, 54); g.addColorStop(0, `rgba(255,190,80,${0.22 * fl})`); g.addColorStop(1, 'rgba(255,190,80,0)'); ctx.fillStyle = g; ctx.fillRect(lx - 50, y0, 108, 92);
    }
    P(x, y1 - 6, w, 3, '#6a6a70'); for (let tx = x; tx < x + w; tx += 22) P(tx, y1 - 3, 12, 3, '#4a2e16');
  },
  pocketDecor(ctx, p, now) {
    const P = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(p.x + x, p.y + y, w, h); };
    if (p.kind === 'generator') { P(30, p.h - 90, 100, 76, '#4a4a50'); P(40, p.h - 100, 24, 16, '#2e2e34'); const o = Math.sin(now / 200); P(100, p.h - 70, 10, 10, o > 0 ? '#ffb030' : '#6a4410'); for (let k = 0; k < 4; k++) { ctx.fillStyle = `rgba(230,230,230,${0.28 - k * 0.06})`; ctx.fillRect(p.x + 46 + Math.sin(now / 400 + k) * 5, p.y + p.h - 130 - k * 16, 14 + k * 4, 12); } }
    else if (p.kind === 'pumps') { P(80, 40, 6, p.h - 54, '#6b4426'); const a = now / 500; ctx.save(); ctx.translate(p.x + 83, p.y + 44); ctx.rotate(a); ctx.fillStyle = '#c9a35a'; for (let k = 0; k < 6; k++) { ctx.rotate(Math.PI / 3); ctx.fillRect(0, -3, 38, 6); } ctx.restore(); P(60, p.h - 30, 46, 16, '#3c4a58'); }
    else { P(50, 40, 90, 50, '#7d5030'); P(60, 90, 8, p.h - 104, '#5a3a1e'); P(122, 90, 8, p.h - 104, '#5a3a1e'); P(54, 44, 82, 6, '#5a3a1e'); P(70, p.h - 34, 50, 20, 'rgba(80,150,200,0.5)'); }
  },
  roomBody(ctx, r, type, now) {
    const P = rect(ctx), F = (x, y, w, h, c) => P(r.x + x * r.w, r.y + y * r.h, w * r.w, h * r.h, c);
    P(r.x, r.y, r.w, r.h, '#6e4a2c');
    for (let y = r.y; y < r.y + r.h; y += 18) { P(r.x, y, r.w, 2, 'rgba(0,0,0,0.3)'); if (hash(y, r.x) > 0.5) for (let x = r.x + hash(y) * 80; x < r.x + r.w; x += 120) P(x, y + 2, 3, 3, 'rgba(0,0,0,0.3)'); }
    for (let x = r.x + 10; x < r.x + r.w; x += 46) P(x, r.y + 20, 14, r.h, 'rgba(255,220,160,0.05)');
    P(r.x, r.y, r.w, 10, '#4a2e16'); P(r.x, r.y + 10, r.w, 3, '#2a170c');
    const n = Math.max(2, Math.round(r.w / 200));
    for (let i = 0; i < n; i++) { const lx = r.x + r.w * ((i + 0.5) / n); P(lx - 1, r.y + 12, 2, 20, '#2a170c'); P(lx - 8, r.y + 30, 16, 12, '#3a2412'); P(lx - 5, r.y + 32, 10, 8, '#ffcf70'); const g = ctx.createRadialGradient(lx, r.y + 38, 4, lx, r.y + 38, 90); g.addColorStop(0, 'rgba(255,200,100,0.28)'); g.addColorStop(1, 'rgba(255,200,100,0)'); ctx.fillStyle = g; ctx.fillRect(lx - 90, r.y + 30, 180, r.h); }
    if (type === 'workshop') { F(0.06, 0.64, 0.3, 0.06, '#4a3a2a'); F(0.1, 0.5, 0.1, 0.14, '#2a2a2e'); F(0.12, 0.44, 0.06, 0.06, '#3a3a40'); F(0.62, 0.45, 0.2, 0.25, '#3a2412'); F(0.64, 0.5, 0.16, 0.14, Math.floor(now / 160) % 3 ? '#ff7a1a' : '#ffb040'); F(0.5, 0.7, 0.3, 0.25, '#4a4a50'); }
    if (type === 'library') { for (let i = 0; i < 4; i++) { F(0.05 + i * 0.07, 0.25, 0.06, 0.7, '#3a2412'); for (let j = 0; j < 5; j++) F(0.058 + i * 0.07, 0.3 + j * 0.13, 0.045, 0.06, ['#7a1c10', '#2a4a2a', '#c9a35a', '#3a4a6a'][(i + j) % 4]); } F(0.6, 0.62, 0.26, 0.05, '#4a2e16'); F(0.68, 0.5, 0.04, 0.12, '#e8b04a'); }
    if (type === 'server') { F(0.08, 0.6, 0.3, 0.06, '#4a2e16'); F(0.14, 0.5, 0.1, 0.1, '#c9a35a'); F(0.17, 0.46, 0.04, 0.04, Math.floor(now / 250) % 2 ? '#fff' : '#6a5a30'); F(0.55, 0.15, 0.003, 0.5, '#2a170c'); F(0.55, 0.65, 0.2, 0.3, '#3a2412'); for (let i = 0; i < 4; i++) F(0.58 + i * 0.04, 0.68, 0.025, 0.04, '#c9a35a'); }
    if (type === 'lab') { for (let i = 0; i < 3; i++) { F(0.06 + i * 0.1, 0.25, 0.08, 0.04, '#4a2e16'); for (let j = 0; j < 3; j++) F(0.07 + i * 0.1 + j * 0.02, 0.18, 0.012, 0.07, ['#5ac28a', '#c24a4a', '#e8b04a'][(i + j) % 3]); } F(0.58, 0.5, 0.3, 0.06, '#4a2e16'); F(0.62, 0.38, 0.04, 0.12, '#7fc9a0'); F(0.7, 0.4, 0.04, 0.1, '#c24a4a'); }
    if (type === 'command') { F(0.08, 0.25, 0.1, 0.25, '#e6dcc0'); F(0.1, 0.28, 0.06, 0.04, '#1a1a1a'); F(0.1, 0.34, 0.06, 0.02, '#7a1c10'); F(0.3, 0.6, 0.4, 0.08, '#4a2e16'); F(0.33, 0.68, 0.34, 0.27, '#3a2412'); F(0.75, 0.3, 0.14, 0.3, '#2a2a30'); F(0.77, 0.32, 0.1, 0.05, '#7a1c10'); }
    if (type === 'hall') { F(0.05, 0.6, 0.9, 0.05, '#4a2e16'); F(0.05, 0.65, 0.9, 0.3, '#3a2412'); for (let i = 0; i < 5; i++) F(0.1 + i * 0.16, 0.5, 0.025, 0.1, ['#7ac28a', '#c27a2a', '#e8b04a', '#7a9ac2'][i % 4]); F(0.3, 0.2, 0.4, 0.2, '#2a170c'); F(0.31, 0.22, 0.38, 0.16, '#c9a35a'); }
    if (type === 'garage') { F(0.3, 0.55, 0.36, 0.2, '#5a3a1e'); F(0.34, 0.45, 0.28, 0.1, '#7d5030'); F(0.7, 0.35, 0.2, 0.55, '#6e5030'); for (let i = 0; i < 5; i++) F(0.06 + i * 0.045, 0.7, 0.03, 0.25, '#c9a35a'); F(0.28, 0.75, 0.04, 0.2, '#2a170c'); F(0.6, 0.75, 0.04, 0.2, '#2a170c'); }
    if (type === 'vault') { for (let i = 0; i < 3; i++) { F(0.05 + i * 0.17, 0.4, 0.13, 0.55, '#6e5a30'); F(0.06 + i * 0.17, 0.5, 0.11, 0.04, '#e8b04a'); } ctx.fillStyle = '#4a4a50'; ctx.beginPath(); ctx.arc(r.x + r.w * 0.8, r.y + r.h * 0.55, r.h * 0.27, 0, 7); ctx.fill(); ctx.fillStyle = '#2e2e34'; ctx.beginPath(); ctx.arc(r.x + r.w * 0.8, r.y + r.h * 0.55, r.h * 0.2, 0, 7); ctx.fill(); F(0.79, 0.5, 0.02, 0.1, '#e8b04a'); }
  },
  lidiaAnims() {
    return animSet(['walk', 'idle', 'command'], (anim, i) => sprite(18, 30, (P) => {
      const ph = (i / 6) * Math.PI * 2, step = anim === 'walk' ? Math.round(Math.sin(ph) * 1.5) : 0, bob = anim === 'walk' ? (i % 3 === 0 ? 0 : 1) : (i % 6 < 3 ? 0 : 1);
      const skin = '#e6b896', ty = 13 + bob, hy = 7 + bob;
      P(7 - step, 21, 2, 7, '#3a4a66'); P(9 + step, 21, 2, 7, '#3a4a66'); P(6 - step, 27, 3, 2, '#3a2414'); P(9 + step, 27, 3, 2, '#3a2414');
      P(6, ty, 6, 9 - bob, '#e6dcc0'); P(6, ty, 2, 8, '#7a4a24'); P(10, ty, 2, 8, '#7a4a24'); P(6, ty + 7, 6, 1, '#2a1a10'); P(8, ty + 7, 2, 1, '#e6b422'); P(10, ty + 1, 2, 2, '#f2d13b'); P(11, ty + 2, 1, 1, '#c99a1c');
      P(7, hy, 4, 5, skin); P(7, hy + 3, 4, 1, '#4a2e1a'); P(10, hy + 2, 1, 1, '#111'); P(6, hy + 1, 1, 3, '#5a3a22');
      P(4, hy - 1, 10, 2, '#b98a4a'); P(6, hy - 4, 6, 3, '#c49a58'); P(6, hy - 2, 6, 1, '#5a3a1a'); P(3, hy - 2, 2, 1, '#b98a4a'); P(13, hy - 2, 2, 1, '#b98a4a');
      if (anim === 'command') { P(11, ty + 1, 5, 2, '#e6dcc0'); P(16, ty + 1 - (i % 3 === 0 ? 1 : 0), 2, 1, skin); P(5, ty + 3, 1, 3, '#e6dcc0'); }
      else if (anim === 'idle') { P(11, ty + 2, 2, 4, '#e6dcc0'); P(12, ty + 6, 4, 1, '#6a6a72'); P(12, ty + 6, 1, 2, '#3a2a1a'); if (i % 6 === 3) P(5, hy + 3, 1, 1, '#fff'); }
      else { const sw = anim === 'walk' ? Math.round(-Math.sin(ph) * 1.5) : 0; P(10 + sw, ty + 1, 2, 6, '#e6dcc0'); P(10 + sw, ty + 7, 2, 1, skin); P(11, ty + 7, 3, 2, '#3a2a1a'); }
    }));
  },
  portrait() {
    return outlineC(sprite(44, 56, (P) => {
      const skin = '#e6b896';
      P(6, 40, 32, 16, '#7a4a24'); P(16, 38, 12, 18, '#e6dcc0'); P(26, 44, 6, 6, '#f2d13b'); P(28, 46, 2, 2, '#c99a1c');
      P(15, 14, 15, 24, skin); P(18, 32, 9, 3, '#4a2e1a'); P(19, 30, 7, 2, '#4a2e1a'); P(18, 22, 3, 2, '#1a1010'); P(25, 22, 3, 2, '#1a1010'); P(21, 25, 3, 4, '#c99a7a');
      P(8, 12, 30, 4, '#b98a4a'); P(14, 2, 18, 11, '#c49a58'); P(14, 9, 18, 3, '#5a3a1a'); P(6, 11, 4, 3, '#b98a4a'); P(36, 11, 4, 3, '#b98a4a');
    }), '#0a0808');
  },
  ambient(ctx, v, now, layer) {
    if (layer !== 'front') return;
    const vw = v.x1 - v.x0, vh = v.y1 - v.y0;
    for (let i = 0; i < 38; i++) {
      const x = v.x0 + ((hash(i) * vw + now * (0.05 + hash(i, 1) * 0.07)) % vw), y = v.y0 + hash(i, 2) * vh + Math.sin(now / 700 + i) * 6;
      ctx.fillStyle = `rgba(235,200,150,${0.10 + 0.14 * hash(i, 3)})`; ctx.fillRect(Math.round(x), Math.round(y), 3 + (i % 3), 2);
    }
    if (v.y1 > -40 && v.y0 < 0) {
      const t = now / 1000, x = v.x0 - 120 + ((t * 80) % (vw + 240)), by = -22 - Math.abs(Math.sin(t * 3.2)) * 26;
      ctx.save(); ctx.translate(x, by); ctx.rotate(t * 5); ctx.strokeStyle = '#8a6a3a'; ctx.lineWidth = 3;
      for (let k = 0; k < 6; k++) { ctx.rotate(Math.PI / 3); ctx.beginPath(); ctx.arc(8, 0, 14, 0, 4.2); ctx.stroke(); }
      ctx.restore();
    }
  },
  soundSpec: {
    master: 0.5,
    drones: [{ type: 'sine', freq: 73.4, gain: 0.025, lfo: { rate: 0.05, depth: 0.5 } }],
    noise: [{ color: 'pink', gain: 0.05, filter: { type: 'bandpass', freq: 520, q: 0.7 }, lfo: { rate: 0.08, depth: 0.8 } }],
    events: [{ fx: 'gust', every: [8, 20], gain: 0.05 }, { fx: 'creak', every: [10, 26], gain: 0.07 }, { fx: 'bell', every: [30, 60], gain: 0.025 }, { fx: 'clop', every: [14, 34], gain: 0.04 }],
    ui: { click: 'clop', message: 'bell', alert: 'alarm', done: 'bell' },
  },
};

// ================================================================== PIRATE COVE
const PIRATE = {
  id: 'pirateCove', label: 'Pirate Cove',
  palette: { void: '#030f18', accent: '#f0c040', muted: '#8fb0c0', text: '#f6e7c1', plate: 'rgba(10,26,40,0.9)', plateText: '#f8ecc8',
    floor: '#5a3a1e', floorGroove: '#2e1c0c', floorTop: '#b8893f', tunnel: '#3a2512', ladder: '#9a6a34', ladderBack: '#1a1006',
    statusOn: '#ffc040', statusOff: '#4a3410', alertRGB: '230,70,40', ui: '#f0c040', bg: '#030f18' },
  fonts: { title: '"Pirata One", "Georgia", serif', body: '"IM Fell English", "Georgia", serif', google: 'Pirata+One&family=IM+Fell+English' },
  lidiaName: 'CAPTAIN', lidiaColor: '#ff6a5a', enemyName: 'Undead',
  roomLabels: { workshop: 'Carpentry', library: 'Charts', server: 'Powder Room', lab: 'Surgeon', hall: 'Great Cabin', garage: 'Cargo Hold', vault: 'Treasure Hold' },
  fixedLabels: { comms: 'SIGNALS / ARMORY', command: 'QUARTERDECK' },
  digText: ['+ NEW CABIN', 'tap to build a cabin and sign hands on'],
  pocketNames: { generator: 'galley stove', pumps: 'bilge pump', water: 'water casks' },
  agentSkin: { color: '#e0b070', alpha: 0.3 }, enemySkin: { color: '#6fd6c8', alpha: 0.55 }, defenderSkin: { color: '#c0392b', alpha: 0.35 },
  earth(ctx, x0, x1, y1, now) {
    ctx.fillStyle = grad(ctx, 0, y1, [[0, '#0f5a78'], [0.12, '#0b4262'], [0.5, '#072a44'], [1, '#03101c']]); ctx.fillRect(x0, 0, x1 - x0, y1);
    tiled(ctx, 'pirate-sea', 256, (g, n) => {
      const R = rng(9);
      for (let k = 0; k < 70; k++) { g.fillStyle = R() > 0.5 ? 'rgba(120,200,230,0.07)' : 'rgba(0,0,0,0.12)'; g.fillRect(Math.floor(R() * n / 4) * 4, Math.floor(R() * n / 4) * 4, 8 + Math.floor(R() * 6) * 8, 4); }
    }, x0, 0, x1 - x0, y1);
    ctx.fillStyle = 'rgba(160,230,255,0.08)';
    for (let k = 0; k < 18; k++) { const y = 30 + k * 140, off = Math.sin(now / 1800 + k) * 40; for (let x = x0; x < x1; x += 320) ctx.fillRect(x + off + hash(k) * 80, y, 120, 3); }
    depthShade(ctx, x0, x1, y1, 0.55);
  },
  surface(ctx, now) {
    const P = rect(ctx), H = 1100;
    P(-6000, -H - 2000, 12000, 2000, '#1a2850');
    ctx.fillStyle = grad(ctx, -H, -230, [[0, '#1a2850'], [0.45, '#8a4a7a'], [0.8, '#ff9a60'], [1, '#ffd890']]); ctx.fillRect(-6000, -H, 12000, H - 230);
    const sg = ctx.createRadialGradient(400, -300, 6, 400, -300, 300); sg.addColorStop(0, 'rgba(255,240,190,1)'); sg.addColorStop(0.3, 'rgba(255,200,120,0.5)'); sg.addColorStop(1, 'rgba(255,170,100,0)');
    ctx.fillStyle = sg; ctx.fillRect(0, -640, 800, 640); P(350, -330, 100, 100, '#fff0b8');
    for (let i = 0; i < 9; i++) { ctx.fillStyle = 'rgba(255,220,200,0.18)'; ctx.fillRect(-2600 + i * 640 + Math.sin(now / 4000 + i) * 30, -620 + hash(i) * 200, 300, 14); }
    // sea
    ctx.fillStyle = grad(ctx, -230, -40, [[0, '#2a7aa0'], [1, '#0f4468']]); ctx.fillRect(-6000, -230, 12000, 190);
    for (let k = 0; k < 14; k++) { const y = -222 + k * 13; ctx.fillStyle = `rgba(230,250,255,${0.08 + (k % 3) * 0.04})`; for (let x = -3000; x < 3000; x += 90) ctx.fillRect(x + ((now / (30 + k * 4) + k * 37) % 90) - 90, y + Math.sin(now / 600 + x / 90 + k) * 2, 36, 2); }
    // ships in the distance
    for (const [sx, sc] of [[-1300, 1], [1500, 0.8], [-300, 0.6]]) {
      P(sx - 60 * sc, -232 - 28 * sc, 120 * sc, 28 * sc, '#2e1a0c'); P(sx - 3, -232 - 150 * sc, 6, 130 * sc, '#2e1a0c');
      ctx.fillStyle = '#efe2c0'; ctx.beginPath(); ctx.moveTo(sx + 6, -232 - 140 * sc); ctx.lineTo(sx + 56 * sc, -232 - 40 * sc); ctx.lineTo(sx + 6, -232 - 40 * sc); ctx.fill();
      ctx.beginPath(); ctx.moveTo(sx - 6, -232 - 130 * sc); ctx.lineTo(sx - 50 * sc, -232 - 40 * sc); ctx.lineTo(sx - 6, -232 - 40 * sc); ctx.fill();
    }
    // island
    P(900, -260, 300, 40, '#2a5a3a'); P(940, -300, 220, 44, '#2f6a40'); P(1020, -330, 90, 34, '#357548');
    // beach / dock
    P(-6000, -40, 12000, 40, '#e8cc92');
    for (let x = -6000; x < 6000; x += 20) P(x + hash(x) * 16, -34 + hash(x, 3) * 28, 4, 2, 'rgba(160,110,50,0.35)');
    for (const px of [-1700, -1050, 1250, 1900]) { P(px, -190, 12, 150, '#6a4a28'); for (let k = 0; k < 5; k++) { ctx.save(); ctx.translate(px + 6, -190); ctx.rotate(-1.2 + k * 0.6 + Math.sin(now / 900 + px) * 0.05); ctx.fillStyle = '#2f7a40'; ctx.fillRect(0, -4, 70, 8); ctx.restore(); } }
    for (let x = -900; x < 900; x += 160) { P(x, -64, 10, 30, '#5a3a1e'); P(x - 4, -66, 18, 5, '#7a5028'); }
    P(-6000, 0, 12000, 10, '#a98550');
  },
  wall(ctx, W, H) {
    const P = rect(ctx), x0 = -W / 2;
    for (let row = 0; row < 3; row++) for (let i = 0; i < 4; i++) { const bx = x0 + 6 + i * 42 + (row % 2) * 20; P(bx, -36 - row * 40, 36, 36, (i + row) % 2 ? '#7a5028' : '#6a4420'); P(bx, -36 - row * 40, 36, 3, '#a8803c'); P(bx + 16, -36 - row * 40, 4, 36, '#4a2e16'); P(bx + 3, -22 - row * 40, 30, 3, '#2e1c0c'); }
    P(x0 + 4, -H + 50, W - 8, H - 130, '#5a3a1e'); for (let y = -H + 56; y < -90; y += 14) { P(x0 + 4, y, W - 8, 2, '#2e1c0c'); }
    P(x0 + 4, -H + 50, W - 8, 8, '#8a5a30');
    P(x0 + 46, -H + 100, 40, 40, '#1a0e04'); P(x0 + 50, -H + 104, 32, 32, '#0a0604'); P(x0 + 60, -H + 112, 28, 14, '#3a3a40'); P(x0 + 88, -H + 114, 14, 10, '#2a2a30');
    P(x0 + 120, -H + 70, 24, 24, '#e8e0c8'); P(x0 + 124, -H + 76, 4, 6, '#111'); P(x0 + 134, -H + 76, 4, 6, '#111'); P(x0 + 128, -H + 86, 8, 3, '#111');
    P(x0 - 10, -H + 14, W + 20, 8, '#8a5a30');
    P(x0 + W - 16, -H - 40, 6, 60, '#4a2e16'); ctx.fillStyle = '#14121a'; ctx.beginPath(); ctx.moveTo(x0 + W - 10, -H - 38); ctx.lineTo(x0 + W + 30, -H - 24 + Math.sin(performance.now() / 300) * 3); ctx.lineTo(x0 + W - 10, -H - 8); ctx.fill();
  },
  shaft: (ctx, bottom, G, now) => shaftKit(PIRATE, ctx, bottom, G, now, { core: '#1a0f06', rail: '#5a3a1e', rail2: '#c8a060', slabA: '#8a5a30', slabB: '#c8a060', pulse: 'rgba(0,0,0,0)', step: 56, ropes: true }),
  tunnelDecor(ctx, x, w, y0, y1, now) {
    const P = rect(ctx);
    for (let by = y0; by < y1; by += 10) P(x, by, w, 1, 'rgba(0,0,0,0.3)');
    for (let bx = x + 8; bx < x + w - 6; bx += 64) { P(bx, y0, 8, 92, '#5a3a1e'); P(bx + 8, y0 + 40, 36, 3, '#2e1c0c'); }
    P(x, y0 + 4, w, 6, '#4a2e16');
    for (let lx = x + 40; lx < x + w - 30; lx += 130) {
      ctx.fillStyle = '#0b2b44'; ctx.beginPath(); ctx.arc(lx, y0 + 30, 15, 0, 7); ctx.fill(); ctx.fillStyle = '#2a7aa0'; ctx.beginPath(); ctx.arc(lx, y0 + 30, 11, 0, 7); ctx.fill();
      ctx.strokeStyle = '#c8a060'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(lx, y0 + 30, 15, 0, 7); ctx.stroke();
      P(lx + 40, y0 + 12, 2, 10, '#2a1a10'); P(lx + 36, y0 + 22, 10, 12, '#3a2412'); const fl = 0.8 + 0.2 * Math.sin(now / 100 + lx); P(lx + 38, y0 + 24, 6, 8, `rgba(255,${180 + fl * 40},70,1)`);
      const g = ctx.createRadialGradient(lx + 41, y0 + 28, 2, lx + 41, y0 + 28, 50); g.addColorStop(0, `rgba(255,190,80,${0.22 * fl})`); g.addColorStop(1, 'rgba(255,190,80,0)'); ctx.fillStyle = g; ctx.fillRect(lx - 10, y0, 100, 92);
    }
  },
  pocketDecor(ctx, p, now) {
    const P = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(p.x + x, p.y + y, w, h); };
    if (p.kind === 'generator') { P(30, p.h - 84, 100, 70, '#3a3a40'); P(40, p.h - 94, 16, 14, '#2a2a30'); P(60, p.h - 62, 60, 40, '#1a1a1e'); P(66, p.h - 56, 48, 28, Math.floor(now / 140) % 3 ? '#ff7a1a' : '#ffb040'); }
    else if (p.kind === 'pumps') { P(70, 40, 8, p.h - 60, '#8a5a30'); const a = Math.sin(now / 400) * 0.6; ctx.save(); ctx.translate(p.x + 74, p.y + 44); ctx.rotate(a); ctx.fillStyle = '#c8a060'; ctx.fillRect(-4, 0, 8, 70); ctx.fillRect(-26, 66, 52, 8); ctx.restore(); P(40, p.h - 30, 70, 16, '#2a7aa0'); }
    else { for (let k = 0; k < 3; k++) { P(24 + k * 52, p.h - 70 - (k % 2) * 20, 44, 56 + (k % 2) * 20, '#7a5028'); P(24 + k * 52, p.h - 54, 44, 4, '#c8a060'); P(24 + k * 52, p.h - 34, 44, 4, '#c8a060'); } }
  },
  roomBody(ctx, r, type, now) {
    const P = rect(ctx), F = (x, y, w, h, c) => P(r.x + x * r.w, r.y + y * r.h, w * r.w, h * r.h, c);
    P(r.x, r.y, r.w, r.h, '#6e4524');
    for (let y = r.y + 12; y < r.y + r.h; y += 14) { P(r.x, y, r.w, 2, 'rgba(0,0,0,0.32)'); }
    for (let x = r.x + 30; x < r.x + r.w; x += 90) P(x + hash(x) * 20, r.y, 2, r.h, 'rgba(0,0,0,0.22)');
    P(r.x, r.y, r.w, 12, '#44290f'); P(r.x, r.y + 12, r.w, 3, '#c8a060');
    for (let bx = r.x + 40; bx < r.x + r.w; bx += 160) { P(bx, r.y + 15, 10, r.h, '#4a2e16'); }
    const wx = r.x + r.w * (0.38 + hash(r.x) * 0.25);
    ctx.fillStyle = '#c8a060'; ctx.beginPath(); ctx.arc(wx, r.y + r.h * 0.32, 24, 0, 7); ctx.fill(); ctx.fillStyle = '#2a7aa0'; ctx.beginPath(); ctx.arc(wx, r.y + r.h * 0.32, 18, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(wx - 12, r.y + r.h * 0.32 - 10 + Math.sin(now / 900) * 3, 24, 3);
    const n = Math.max(2, Math.round(r.w / 220));
    for (let i = 0; i < n; i++) { const lx = r.x + r.w * ((i + 0.5) / n) + 40; P(lx - 1, r.y + 15, 2, 16, '#1a1006'); P(lx - 7, r.y + 30, 14, 14, '#2a1a10'); const fl = 0.85 + 0.15 * Math.sin(now / 110 + i); P(lx - 4, r.y + 33, 8, 8, `rgba(255,${190 + fl * 30},80,1)`); const g = ctx.createRadialGradient(lx, r.y + 38, 3, lx, r.y + 38, 100); g.addColorStop(0, `rgba(255,190,90,${0.26 * fl})`); g.addColorStop(1, 'rgba(255,190,90,0)'); ctx.fillStyle = g; ctx.fillRect(lx - 100, r.y + 20, 200, r.h); }
    if (type === 'workshop') { F(0.06, 0.64, 0.32, 0.06, '#8a5a30'); F(0.1, 0.55, 0.04, 0.09, '#9aa3ad'); F(0.16, 0.58, 0.08, 0.06, '#7a8590'); F(0.6, 0.35, 0.3, 0.3, '#4a2e16'); F(0.62, 0.38, 0.26, 0.04, '#9aa3ad'); F(0.62, 0.45, 0.26, 0.04, '#9aa3ad'); }
    if (type === 'library') { F(0.06, 0.55, 0.38, 0.06, '#8a5a30'); F(0.1, 0.45, 0.3, 0.1, '#e2d0a0'); F(0.14, 0.48, 0.1, 0.01, '#9a2a1a'); F(0.28, 0.49, 0.08, 0.01, '#2a3a5a'); for (let i = 0; i < 3; i++) { F(0.6 + i * 0.1, 0.25, 0.08, 0.7, '#3a2412'); for (let j = 0; j < 4; j++) F(0.605 + i * 0.1, 0.3 + j * 0.16, 0.07, 0.08, ['#7a1c10', '#2a4a2a', '#c8a060'][(i + j) % 3]); } }
    if (type === 'server') { for (let i = 0; i < 6; i++) { F(0.06 + (i % 3) * 0.1, 0.72 - Math.floor(i / 3) * 0.2, 0.08, 0.2, '#5a3a1e'); F(0.06 + (i % 3) * 0.1, 0.78 - Math.floor(i / 3) * 0.2, 0.08, 0.02, '#1a1a1e'); } F(0.62, 0.55, 0.2, 0.4, '#1a1a1e'); F(0.66, 0.5, 0.12, 0.05, Math.floor(now / 160) % 2 ? '#ff7a1a' : '#8a3a10'); }
    if (type === 'lab') { F(0.06, 0.6, 0.32, 0.1, '#6a4a2a'); F(0.1, 0.5, 0.04, 0.1, '#7fc9a0'); F(0.18, 0.52, 0.04, 0.08, '#c24a4a'); F(0.6, 0.55, 0.3, 0.07, '#8a5a30'); F(0.62, 0.62, 0.26, 0.3, '#4a2e16'); F(0.7, 0.32, 0.1, 0.2, '#e6dcc0'); }
    if (type === 'command') { F(0.4, 0.15, 0.22, 0.5, '#7a5028'); F(0.45, 0.35, 0.12, 0.12, '#c8a060'); ctx.strokeStyle = '#c8a060'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(r.x + r.w * 0.51, r.y + r.h * 0.41, r.h * 0.14, 0, 7); ctx.stroke(); for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; ctx.beginPath(); ctx.moveTo(r.x + r.w * 0.51, r.y + r.h * 0.41); ctx.lineTo(r.x + r.w * 0.51 + Math.cos(a) * r.h * 0.2, r.y + r.h * 0.41 + Math.sin(a) * r.h * 0.2); ctx.stroke(); } F(0.06, 0.7, 0.2, 0.25, '#4a2e16'); }
    if (type === 'hall') { F(0.2, 0.62, 0.6, 0.06, '#8a5a30'); F(0.22, 0.68, 0.03, 0.27, '#4a2e16'); F(0.74, 0.68, 0.03, 0.27, '#4a2e16'); for (let i = 0; i < 4; i++) F(0.28 + i * 0.12, 0.56, 0.04, 0.06, ['#c8a060', '#9aa3ad', '#7a1c10', '#c8a060'][i]); F(0.3, 0.2, 0.4, 0.22, '#e2d0a0'); F(0.32, 0.24, 0.36, 0.01, '#8a5a30'); F(0.4, 0.3, 0.2, 0.01, '#8a5a30'); }
    if (type === 'garage') { for (let i = 0; i < 6; i++) F(0.06 + (i % 3) * 0.1, 0.72 - Math.floor(i / 3) * 0.24, 0.09, 0.22, '#7a5028'); F(0.5, 0.55, 0.3, 0.4, '#8a5a30'); F(0.5, 0.65, 0.3, 0.03, '#c8a060'); F(0.84, 0.2, 0.01, 0.75, '#c8a060'); }
    if (type === 'vault') { for (let i = 0; i < 3; i++) { F(0.05 + i * 0.17, 0.62, 0.15, 0.3, '#6a4220'); F(0.05 + i * 0.17, 0.62, 0.15, 0.04, '#c8a060'); F(0.07 + i * 0.17, 0.56, 0.11, 0.06, '#f0c040'); F(0.085 + i * 0.17, 0.52, 0.04, 0.04, '#f6d870'); } F(0.64, 0.45, 0.28, 0.45, '#4a2e16'); F(0.66, 0.5, 0.24, 0.1, '#c8a060'); F(0.76, 0.6, 0.04, 0.04, '#f0c040'); }
  },
  lidiaAnims() {
    return animSet(['walk', 'idle', 'command'], (anim, i) => sprite(20, 30, (P) => {
      const ph = (i / 6) * Math.PI * 2, step = anim === 'walk' ? Math.round(Math.sin(ph) * 1.5) : 0, bob = anim === 'walk' ? (i % 3 === 0 ? 0 : 1) : (i % 6 < 3 ? 0 : 1);
      const skin = '#e0b090', ty = 13 + bob, hy = 8 + bob, coat = '#9a1f2a', coatDk = '#5e0f18', gold = '#e6b422';
      P(7 - step, 22, 2, 6, '#1a1218'); P(9 + step, 22, 2, 6, '#1a1218'); P(6 - step, 24, 3, 5, '#2a1a10'); P(9 + step, 24, 3, 5, '#2a1a10'); P(5 - step, 24, 4, 1, '#c8a060');
      P(6, ty, 7, 10 - bob, coat); P(6, ty + 7, 7, 1, coatDk); P(8, ty, 2, 3, '#f2efe6'); P(7, ty + 3, 1, 1, gold); P(7, ty + 5, 1, 1, gold); P(5, ty + 8, 9, 1, '#2a1a10');
      P(4, ty + 7, 1, 6, '#9aa3ad'); P(3, ty + 6, 3, 1, gold);
      P(7, hy, 5, 5, skin); P(11, hy + 2, 1, 1, '#000'); P(7, hy + 1, 5, 1, '#000'); P(6, hy + 2, 2, 3, '#2a1a10'); P(8, hy + 4, 3, 1, '#3a2418');
      P(4, hy - 2, 11, 2, '#14121a'); P(6, hy - 4, 7, 3, '#14121a'); P(4, hy - 2, 11, 1, gold); P(13, hy - 5, 2, 4, '#c0392b'); P(3, hy - 3, 2, 2, '#14121a'); P(14, hy - 3, 2, 2, '#14121a');
      if (anim === 'command') { P(12, ty + 1, 3, 2, coat); P(15, ty - 1 - (i % 3 === 0 ? 1 : 0), 2, 2, skin); P(16, ty - 8, 1, 8, '#cfd8e3'); P(15, ty - 1, 3, 1, gold); P(5, ty + 3, 1, 4, coat); }
      else if (anim === 'idle') { P(12, ty + 2, 2, 5, coat); P(12, ty + 7, 2, 1, skin); if (i % 6 === 2) P(6, hy - 5, 1, 1, '#fff'); }
      else { const sw = anim === 'walk' ? Math.round(-Math.sin(ph) * 1.5) : 0; P(12 + sw, ty + 1, 2, 6, coat); P(12 + sw, ty + 7, 2, 1, skin); }
    }));
  },
  portrait() {
    return outlineC(sprite(44, 56, (P) => {
      const skin = '#e0b090';
      P(6, 42, 32, 14, '#9a1f2a'); P(18, 40, 8, 16, '#f2efe6'); P(8, 44, 4, 4, '#e6b422'); P(32, 44, 4, 4, '#e6b422');
      P(14, 14, 17, 26, skin); P(16, 32, 13, 8, '#2a1a10'); P(14, 28, 3, 8, '#2a1a10'); P(28, 28, 3, 8, '#2a1a10');
      P(24, 21, 4, 3, '#000'); P(14, 19, 17, 1, '#000'); P(18, 22, 3, 2, '#1a1010'); P(21, 26, 3, 4, '#c99a7a'); P(19, 34, 8, 1, '#8a4a3a');
      P(6, 11, 33, 4, '#14121a'); P(10, 3, 25, 9, '#14121a'); P(6, 11, 33, 2, '#e6b422'); P(33, 0, 6, 10, '#c0392b');
    }), '#05080c');
  },
  ambient(ctx, v, now, layer) {
    const vw = v.x1 - v.x0, vh = v.y1 - v.y0;
    if (layer === 'back') {
      for (let i = 0; i < 34; i++) {
        const span = Math.max(vh, 600), x = v.x0 + hash(i) * vw + Math.sin(now / 900 + i) * 8, y = v.y1 - ((hash(i, 1) * span + now * (0.03 + hash(i, 2) * 0.05)) % span);
        if (y < 30) continue;
        const r = 2 + hash(i, 3) * 4; ctx.strokeStyle = 'rgba(200,240,255,0.35)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke();
      }
      return;
    }
    if (v.y0 < -300) for (let i = 0; i < 4; i++) {
      const x = v.x0 + ((now * (0.03 + i * 0.01) + i * 700) % (vw + 300)) - 150, y = Math.max(v.y0 + 60, -750) + i * 55 + Math.sin(now / 800 + i) * 14, f = Math.sin(now / 160 + i * 2) * 5;
      ctx.strokeStyle = '#f2eee0'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x - 14, y + f); ctx.quadraticCurveTo(x - 6, y - 8, x, y); ctx.quadraticCurveTo(x + 6, y - 8, x + 14, y + f); ctx.stroke();
    }
  },
  soundSpec: {
    master: 0.55,
    drones: [{ type: 'sine', freq: 49, gain: 0.04, lfo: { rate: 0.06, depth: 0.5 } }],
    noise: [{ color: 'brown', gain: 0.1, filter: { type: 'lowpass', freq: 520 }, lfo: { rate: 0.1, depth: 0.7 } }, { color: 'pink', gain: 0.025, filter: { type: 'highpass', freq: 1800 }, lfo: { rate: 0.12, depth: 0.9 } }],
    events: [{ fx: 'creak', every: [5, 13], gain: 0.09 }, { fx: 'gull', every: [12, 30], gain: 0.05 }, { fx: 'bell', every: [28, 60], gain: 0.035 }, { fx: 'drip', every: [6, 16], gain: 0.05 }],
    ui: { click: 'drip', message: 'bell', alert: 'alarm', done: 'bell' },
  },
};

// ================================================================== CYBERPUNK VILLAGE
const CYBER = {
  id: 'cyberpunk', label: 'Cyberpunk Village',
  palette: { void: '#03010a', accent: '#ff2a9d', muted: '#8a7aae', text: '#e8f6ff', plate: 'rgba(8,3,20,0.9)', plateText: '#e8f6ff',
    floor: '#1c1730', floorGroove: '#0c0818', floorTop: '#22e6ff', tunnel: '#120d22', ladder: '#3a2f66', ladderBack: '#0a0618',
    statusOn: '#ff2a9d', statusOff: '#3a0f2a', alertRGB: '255,40,120', ui: '#22e6ff', bg: '#03010a' },
  fonts: { title: '"Audiowide", "Orbitron", monospace', body: '"Share Tech Mono", "VT323", monospace', google: 'Audiowide&family=Share+Tech+Mono' },
  lidiaName: 'MAINFRAME', lidiaColor: '#22e6ff', enemyName: 'Rogue',
  roomLabels: { workshop: 'Chop Shop', library: 'Data Vault', server: 'Server Stack', lab: 'Bio-Hack Lab', hall: 'Night Market', garage: 'Garage', vault: 'Crypto Vault' },
  fixedLabels: { comms: 'UPLINK / ARMORY', command: 'NEXUS' },
  digText: ['+ NEW STALL', 'tap to rent a stall and plug agents in'],
  pocketNames: { generator: 'fusion rig', pumps: 'coolant loop', water: 'water recycler' },
  agentSkin: { color: '#b46bff', alpha: 0.3 }, enemySkin: { color: '#ff2a9d', alpha: 0.5 }, defenderSkin: { color: '#22e6ff', alpha: 0.35 },
  earth(ctx, x0, x1, y1, now) {
    tiled(ctx, 'cyber-megastructure', 256, (g, n) => {
      const P = rect(g), R = rng(21);
      P(0, 0, n, n, '#0e0a1c');
      for (let y = 0; y < n; y += 64) for (let x = 0; x < n; x += 64) { P(x, y, 64, 64, ((x + y) / 64) % 2 ? '#120e24' : '#0f0b1f'); P(x, y, 64, 2, '#1c1636'); P(x, y, 2, 64, '#07040f'); }
      for (let k = 0; k < 8; k++) { const y = Math.floor(R() * 8) * 32 + 12; P(0, y, n, 3, k % 2 ? 'rgba(255,42,157,0.20)' : 'rgba(34,230,255,0.16)'); P(Math.floor(R() * 8) * 32, y, 3, 28, 'rgba(34,230,255,0.14)'); }
      for (let k = 0; k < 24; k++) P(Math.floor(R() * 64) * 4, Math.floor(R() * 64) * 4, 4, 4, R() > 0.5 ? 'rgba(255,225,74,0.25)' : 'rgba(34,230,255,0.2)');
    }, x0, 0, x1 - x0, y1);
    depthShade(ctx, x0, x1, y1, 0.75);
  },
  surface(ctx, now) {
    const P = rect(ctx), H = 1100;
    P(-6000, -H - 2000, 12000, 2000, '#07031a');
    ctx.fillStyle = grad(ctx, -H, 0, [[0, '#07031a'], [0.55, '#240a46'], [0.9, '#6a1470'], [1, '#a01a78']]); ctx.fillRect(-6000, -H, 12000, H);
    ctx.fillStyle = '#d8d0f0'; ctx.beginPath(); ctx.arc(-700, -760, 54, 0, 7); ctx.fill(); ctx.fillStyle = 'rgba(80,40,140,0.4)'; ctx.beginPath(); ctx.arc(-684, -750, 42, 0, 7); ctx.fill();
    [['#150a30', 520, 0.25], ['#1c0e40', 380, 0.5], ['#10081f', 260, 1]].forEach(([col, base, k], li) => {
      for (let x = -3400, i = 0; x < 3400; i++) {
        const w = 70 + hash(i, li) * 90, h = base * (0.45 + hash(i, li + 5) * 0.8), top = -40 - h;
        P(x, top, w, h + 40, col);
        if (li === 2) for (let wy = top + 14; wy < -50; wy += 18) for (let wx = x + 8; wx < x + w - 10; wx += 14) { const on = hash(wx, wy) > 0.55; if (on) P(wx, wy, 6, 8, Math.floor(now / 1700 + hash(wx, wy) * 20) % 11 === 0 ? '#1a1030' : (hash(wx, wy, 1) > 0.5 ? '#22e6ff' : hash(wx, wy) > 0.8 ? '#ffe14a' : '#ff2a9d')); }
        else for (let wy = top + 16; wy < -60; wy += 26) for (let wx = x + 8; wx < x + w - 8; wx += 20) if (hash(wx, wy) > 0.7) P(wx, wy, 5, 6, 'rgba(255,42,157,0.55)');
        if (li === 1 && hash(i, 77) > 0.7) { P(x + w / 2 - 1, top - 40, 2, 40, '#3a2f66'); P(x + w / 2 - 3, top - 44, 6, 6, Math.floor(now / 600 + i) % 2 ? '#ff2a9d' : '#400f2a'); }
        x += w + 4 + hash(i, 8) * 10 * k;
      }
    });
    // neon billboards
    ctx.textAlign = 'center';
    [[-1000, -430, 'RAMEN', '#ff2a9d'], [820, -520, 'NEO·NET', '#22e6ff'], [-1900, -380, 'CYBER+', '#ffe14a'], [1700, -420, 'MEGA', '#ff2a9d']].forEach(([bx, by, txt, col], i) => {
      const on = Math.floor(now / 90 + i * 7) % 47 !== 0;
      P(bx - 100, by - 36, 200, 64, '#07040f'); ctx.strokeStyle = on ? col : '#2a1a3a'; ctx.lineWidth = 4; ctx.strokeRect(bx - 96, by - 32, 192, 56);
      ctx.font = `34px ${CYBER.fonts.title}`; ctx.fillStyle = on ? col : '#2a1a3a'; ctx.shadowColor = col; ctx.shadowBlur = on ? 14 : 0; ctx.fillText(txt, bx, by + 12); ctx.shadowBlur = 0;
    });
    ctx.textAlign = 'start';
    // holographic cone
    const hg = ctx.createLinearGradient(0, -420, 0, -40); hg.addColorStop(0, 'rgba(34,230,255,0)'); hg.addColorStop(1, `rgba(34,230,255,${0.2 + 0.05 * Math.sin(now / 300)})`);
    ctx.fillStyle = hg; ctx.beginPath(); ctx.moveTo(-1250, -40); ctx.lineTo(-1190, -420); ctx.lineTo(-1130, -40); ctx.fill();
    // wet street
    P(-6000, -40, 12000, 40, '#120d1f'); P(-6000, -40, 12000, 3, '#22e6ff');
    for (let x = -6000; x < 6000; x += 160) { P(x + 40, -30, 70, 3, 'rgba(255,42,157,0.35)'); P(x + 90, -18, 40, 2, 'rgba(34,230,255,0.3)'); }
    for (const lx of [-1500, -700, 700, 1500]) { P(lx, -130, 6, 90, '#2a2145'); P(lx - 22, -134, 50, 8, '#2a2145'); P(lx - 22, -128, 12, 6, '#ffe14a'); }
    P(-6000, 0, 12000, 10, '#0a0618');
  },
  wall(ctx, W, H) {
    const P = rect(ctx), x0 = -W / 2, t = performance.now();
    for (let i = 0; i < 4; i++) { P(x0 + 4 + i * 44, -48 - (i % 2) * 6, 40, 48 + (i % 2) * 6, '#2a2538'); stripes(ctx, x0 + 4 + i * 44, -14, 40, 14, '#ffe14a', '#120d1f', 12); }
    P(x0 + 8, -H + 24, 14, H - 70, '#1c1730'); P(x0 + W - 22, -H + 24, 14, H - 70, '#1c1730'); P(x0 + 12, -H + 24, 3, H - 70, '#22e6ff'); P(x0 + W - 18, -H + 24, 3, H - 70, '#22e6ff');
    for (let y = -H + 40; y < -60; y += 22) { const a = 0.5 + 0.4 * Math.sin(t / 200 + y); ctx.fillStyle = `rgba(255,42,157,${a})`; ctx.fillRect(x0 + 22, y, W - 44, 3); }
    P(x0 + 40, -100, 100, 36, '#07040f'); ctx.strokeStyle = '#22e6ff'; ctx.lineWidth = 2; ctx.strokeRect(x0 + 42, -98, 96, 32); P(x0 + 50, -88, 60, 4, '#22e6ff'); P(x0 + 50, -80, 40, 4, '#ff2a9d');
    P(x0 - 10, -H + 14, W + 20, 8, '#3a2f66'); P(x0 - 10, -H + 14, W + 20, 2, '#22e6ff');
  },
  shaft: (ctx, bottom, G, now) => shaftKit(CYBER, ctx, bottom, G, now, { core: '#07040f', rail: '#2a2145', rail2: '#ff2a9d', slabA: '#ffe14a', slabB: '#120d1f', pulse: 'rgba(34,230,255,0.6)', step: 48, neon: true }),
  tunnelDecor(ctx, x, w, y0, y1, now) {
    const P = rect(ctx);
    for (let bx = x; bx < x + w; bx += 40) P(bx, y0, 4, 92, '#1c1730');
    P(x, y0 + 6, w, 5, '#2a1a4a'); P(x, y0 + 14, w, 3, '#ff2a9d'); P(x, y0 + 19, w, 2, 'rgba(34,230,255,0.7)');
    for (let lx = x + 24; lx < x + w - 10; lx += 100) {
      const lit = Math.floor(now / 90 + lx) % 37 !== 0, col = (lx / 100 | 0) % 2 ? '255,42,157' : '34,230,255';
      P(lx, y0 + 28, 40, 3, lit ? `rgb(${col})` : '#2a1a3a');
      if (lit) { ctx.fillStyle = `rgba(${col},0.08)`; ctx.fillRect(lx - 30, y0 + 31, 100, 61); }
    }
    for (let sx = x + 30; sx < x + w - 30; sx += 150) { P(sx, y1 - 40, 22, 40, '#1c1730'); P(sx + 3, y1 - 36, 16, 8, Math.floor(now / 500 + sx) % 2 ? '#22e6ff' : '#0f3a44'); }
  },
  pocketDecor(ctx, p, now) {
    const P = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(p.x + x, p.y + y, w, h); };
    if (p.kind === 'generator') { P(36, p.h - 100, 100, 86, '#1c1730'); const g = 0.5 + 0.4 * Math.sin(now / 250); P(52, p.h - 84, 68, 54, `rgba(255,42,157,${g})`); P(66, p.h - 72, 40, 30, '#ffe0f0'); }
    else if (p.kind === 'pumps') { P(26, 40, p.w - 52, 8, '#22e6ff'); P(46, 48, 10, p.h - 66, '#2a2145'); P(120, 48, 10, p.h - 66, '#2a2145'); for (let k = 0; k < 6; k++) P(48, 52 + ((now / 20 + k * 20) % (p.h - 80)), 6, 6, '#22e6ff'); }
    else { P(30, 40, 60, p.h - 54, '#1c1730'); P(100, 60, 60, p.h - 74, '#1c1730'); P(34, 44 + (p.h - 54) * 0.4, 52, (p.h - 54) * 0.6, 'rgba(34,230,255,0.4)'); P(104, 64 + (p.h - 74) * 0.5, 52, (p.h - 74) * 0.5, 'rgba(34,230,255,0.4)'); }
  },
  roomBody(ctx, r, type, now) {
    const P = rect(ctx), F = (x, y, w, h, c) => P(r.x + x * r.w, r.y + y * r.h, w * r.w, h * r.h, c);
    P(r.x, r.y, r.w, r.h, '#15102a');
    for (let x = r.x; x < r.x + r.w; x += 60) { P(x, r.y, 3, r.h, 'rgba(0,0,0,0.5)'); P(x + 3, r.y, 1, r.h, 'rgba(34,230,255,0.18)'); for (let y = r.y + 36; y < r.y + r.h; y += 44) P(x + 10, y, 8, 2, 'rgba(255,42,157,0.25)'); }
    P(r.x, r.y + 2, r.w, 8, '#0c0818'); P(r.x, r.y + 12, r.w, 3, '#ff2a9d');
    const n = Math.max(2, Math.round(r.w / 200));
    for (let i = 0; i < n; i++) { const tx = r.x + r.w * ((i + 0.5) / n) - 45, col = i % 2 ? '255,42,157' : '34,230,255'; P(tx, r.y + 24, 90, 4, `rgb(${col})`); ctx.fillStyle = `rgba(${col},0.06)`; ctx.fillRect(tx - 30, r.y + 28, 150, r.h - 40); }
    if (type === 'workshop') { F(0.06, 0.64, 0.3, 0.06, '#3a3358'); F(0.1, 0.4, 0.02, 0.24, '#5a5280'); F(0.1, 0.4, 0.12, 0.03, '#5a5280'); F(0.2, 0.43, 0.02, 0.08, Math.floor(now / 120) % 2 ? '#ffe14a' : '#7a6a20'); F(0.6, 0.5, 0.3, 0.2, '#1c1730'); F(0.64, 0.54, 0.22, 0.1, 'rgba(34,230,255,0.4)'); F(0.5, 0.7, 0.3, 0.25, '#2a2145'); }
    if (type === 'library') { for (let i = 0; i < 4; i++) { F(0.05 + i * 0.07, 0.25, 0.06, 0.7, '#1c1730'); for (let j = 0; j < 5; j++) F(0.058 + i * 0.07, 0.3 + j * 0.13, 0.045, 0.06, (i + j) % 2 ? '#22e6ff' : '#ff2a9d'); } F(0.6, 0.62, 0.26, 0.05, '#3a3358'); F(0.66, 0.3, 0.14, 0.3, `rgba(34,230,255,${0.2 + 0.1 * Math.sin(now / 300)})`); }
    if (type === 'server') { for (let i = 0; i < 4; i++) { F(0.05 + i * 0.1, 0.2, 0.08, 0.75, '#0c0818'); for (let j = 0; j < 8; j++) F(0.06 + i * 0.1, 0.25 + j * 0.08, 0.015, 0.02, Math.floor(now / 250 + i * 3 + j) % 4 ? (j % 2 ? '#22e6ff' : '#ff2a9d') : '#1a1030'); } F(0.6, 0.45, 0.3, 0.5, '#2a2145'); F(0.7, 0.55, 0.1, 0.12, '#ffe14a'); }
    if (type === 'lab') { for (const fx of [0.62, 0.78]) { F(fx, 0.2, 0.12, 0.75, '#150a2a'); F(fx + 0.01, 0.25, 0.1, 0.62, `rgba(180,90,255,${0.35 + 0.15 * Math.sin(now / 400 + fx)})`); } F(0.08, 0.62, 0.35, 0.05, '#3a3358'); F(0.12, 0.5, 0.03, 0.12, '#22e6ff'); F(0.2, 0.54, 0.03, 0.08, '#ff2a9d'); }
    if (type === 'command') { for (let i = 0; i < 6; i++) { F(0.08 + i * 0.14, 0.2, 0.11, 0.16, '#07040f'); F(0.09 + i * 0.14, 0.22, 0.09, 0.12, Math.floor(now / 700 + i) % 3 ? 'rgba(34,230,255,0.5)' : 'rgba(255,42,157,0.55)'); } F(0.3, 0.62, 0.4, 0.08, '#3a3358'); F(0.32, 0.7, 0.36, 0.25, '#1c1730'); }
    if (type === 'hall') { for (let i = 0; i < 4; i++) { F(0.05 + i * 0.24, 0.62, 0.18, 0.05, '#3a3358'); F(0.07 + i * 0.24, 0.42, 0.14, 0.2, '#07040f'); F(0.08 + i * 0.24, 0.44, 0.12, 0.05, i % 2 ? '#ff2a9d' : '#22e6ff'); F(0.08 + i * 0.24, 0.52, 0.12, 0.02, '#ffe14a'); } F(0.3, 0.18, 0.4, 0.14, 'rgba(255,225,74,0.2)'); }
    if (type === 'garage') { F(0.3, 0.55, 0.42, 0.22, '#2a2145'); F(0.38, 0.42, 0.26, 0.14, '#1c1730'); F(0.4, 0.44, 0.22, 0.08, 'rgba(34,230,255,0.5)'); F(0.34, 0.77, 0.08, 0.14, '#07040f'); F(0.64, 0.77, 0.08, 0.14, '#07040f'); F(0.3, 0.8, 0.44, 0.02, '#ff2a9d'); F(0.06, 0.4, 0.12, 0.5, '#1c1730'); }
    if (type === 'vault') { for (let i = 0; i < 3; i++) { F(0.05 + i * 0.17, 0.25, 0.14, 0.7, '#1c1730'); for (let j = 0; j < 4; j++) F(0.06 + i * 0.17, 0.3 + j * 0.16, 0.12, 0.1, ['#ff2a9d', '#22e6ff', '#ffe14a', '#b46bff'][(i + j) % 4] + '55'); } ctx.fillStyle = '#2a2145'; ctx.beginPath(); ctx.arc(r.x + r.w * 0.8, r.y + r.h * 0.55, r.h * 0.26, 0, 7); ctx.fill(); ctx.strokeStyle = '#22e6ff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(r.x + r.w * 0.8, r.y + r.h * 0.55, r.h * 0.2, 0, 7); ctx.stroke(); }
  },
  lidiaAnims() {
    return animSet(['walk', 'idle', 'command'], (anim, i) => sprite(18, 30, (P) => {
      const j = anim === 'walk' ? i % 2 : 0;
      P(4, 26, 10, 3, '#15102a'); P(5 + j, 27, 2, 2, '#5a5280'); P(11 - j, 27, 2, 2, '#5a5280'); P(4, 25, 10, 1, '#3a2f66');
      P(4, 8, 10, 18, '#1c1730'); P(4, 8, 1, 18, '#3a3358'); P(13, 8, 1, 18, '#0c0818');
      for (let k = 0; k < 4; k++) { P(5, 18 + k * 2, 3, 1, (i + k) % 3 ? '#22e6ff' : '#0b3a44'); P(10, 18 + k * 2, 3, 1, (i + k * 2) % 4 ? '#ff2a9d' : '#4a0f33'); }
      P(5, 9, 8, 7, '#05060c'); const blink = i === 5;
      P(6, 10, 2, blink ? 1 : 3, '#22e6ff'); P(10, 10, 2, blink ? 1 : 3, '#22e6ff');
      if (anim === 'command') { P(6, 14, 6, 1, '#ff2a9d'); P(14, 13, 3, 1, '#3a3358'); P(17, 11 - (i % 3 === 0 ? 1 : 0), 1, 4, '#22e6ff'); } else P(7, 14, 4, 1, anim === 'idle' && i % 6 < 3 ? '#22e6ff' : '#0b5a6a');
      P(9, 4, 1, 5, '#6a6a7a'); P(8, 2, 3, 2, i % 2 ? '#ff2a9d' : '#6a1a40'); if (i % 2) P(7, 1, 5, 1, 'rgba(255,42,157,0.5)');
    }));
  },
  portrait() {
    return outlineC(sprite(44, 56, (P) => {
      P(8, 8, 28, 44, '#1c1730'); P(8, 8, 2, 44, '#3a3358'); P(10, 10, 24, 22, '#05060c'); P(12, 14, 6, 8, '#22e6ff'); P(26, 14, 6, 8, '#22e6ff'); P(14, 16, 2, 3, '#e8fcff'); P(28, 16, 2, 3, '#e8fcff');
      P(14, 26, 16, 2, '#ff2a9d'); P(12, 28, 4, 2, '#ff2a9d'); P(28, 28, 4, 2, '#ff2a9d');
      for (let k = 0; k < 6; k++) { P(12, 36 + k * 2, 8, 1, k % 2 ? '#22e6ff' : '#0b3a44'); P(24, 36 + k * 2, 8, 1, k % 2 ? '#ff2a9d' : '#4a0f33'); }
      P(21, 0, 2, 8, '#6a6a7a'); P(19, 0, 6, 3, '#ff2a9d');
    }), '#05030c');
  },
  ambient(ctx, v, now, layer) {
    if (layer !== 'front') return;
    const vw = v.x1 - v.x0, ybot = Math.min(v.y1, 0);
    if (ybot > v.y0) {
      const span = ybot - v.y0;
      ctx.strokeStyle = 'rgba(160,200,255,0.30)'; ctx.lineWidth = 1.5; ctx.beginPath();
      for (let i = 0; i < 90; i++) { const x = v.x0 + hash(i) * vw, y = v.y0 + ((hash(i, 1) * span + now * (0.7 + hash(i, 2) * 0.5)) % span); ctx.moveTo(x, y); ctx.lineTo(x - 4, y + 18); }
      ctx.stroke();
    }
    const vh = v.y1 - v.y0, k = Math.floor(now / 140);
    for (let i = 0; i < 9; i++) if (hash(k, i) > 0.6) { ctx.fillStyle = hash(k, i + 40) > 0.5 ? 'rgba(255,42,157,0.55)' : 'rgba(34,230,255,0.55)'; ctx.fillRect(Math.round(v.x0 + hash(k, i + 10) * vw), Math.round(v.y0 + hash(k, i + 20) * vh), 6 + (i % 3) * 4, 2); }
  },
  soundSpec: {
    master: 0.5,
    drones: [{ type: 'sawtooth', freq: 41.2, gain: 0.04, detune: 8, filter: { type: 'lowpass', freq: 220, q: 2 }, lfo: { rate: 0.13, depth: 0.5 } }, { type: 'square', freq: 82.4, gain: 0.012, filter: { type: 'lowpass', freq: 300, q: 4 }, lfo: { rate: 0.5, depth: 0.7 } }],
    noise: [{ color: 'white', gain: 0.025, filter: { type: 'highpass', freq: 3200 }, lfo: { rate: 0.2, depth: 0.4 } }, { color: 'pink', gain: 0.03, filter: { type: 'lowpass', freq: 700 } }],
    events: [{ fx: 'glitch', every: [4, 11], gain: 0.05 }, { fx: 'blip', every: [3, 8], gain: 0.04 }, { fx: 'honk', every: [20, 45], gain: 0.03 }, { fx: 'zap', every: [14, 32], gain: 0.04 }],
    ui: { click: 'glitch', message: 'ping', alert: 'zap', done: 'ping' },
  },
};

// ------------------------------------------------------------------ shared lift-shaft kit
function shaftKit(T, ctx, bottom, G, now, o) {
  const P = rect(ctx), hw = G.SHAFT_W / 2, p = T.palette;
  P(-hw, 0, G.SHAFT_W, bottom, o.core);
  P(-hw, 0, 8, bottom, o.rail); P(hw - 8, 0, 8, bottom, o.rail);
  P(-hw + 14, 0, 3, bottom, o.rail2 + (o.neon || o.pulse === 'rgba(76,212,255,0.55)' ? '' : '99')); P(hw - 17, 0, 3, bottom, o.rail2 + (o.neon || o.pulse === 'rgba(76,212,255,0.55)' ? '' : '99'));
  for (let y = 0; y < bottom; y += o.step) {
    P(-hw + 8, y, G.SHAFT_W - 16, 4, o.rail);
    if (o.braces) { ctx.strokeStyle = o.rail; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(-hw + 8, y + 4); ctx.lineTo(hw - 8, y + o.step); ctx.stroke(); }
    if (o.ropes) { ctx.strokeStyle = '#c8a060'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-hw + 10, y); ctx.lineTo(hw - 10, y + o.step / 2); ctx.lineTo(-hw + 10, y + o.step); ctx.stroke(); }
  }
  if (o.pulse !== 'rgba(0,0,0,0)') { ctx.fillStyle = o.pulse; for (let k = 0; k < bottom / 300 + 1; k++) { const y = ((now * 0.18 + k * 300) % (bottom + 100)) - 50; ctx.fillRect(-hw + 14, y, 3, 26); ctx.fillRect(hw - 17, bottom - y - 26 < 0 ? 0 : bottom - y - 26, 3, 26); } }
  P(-6, 0, 3, bottom, 'rgba(0,0,0,0.5)'); P(4, 0, 3, bottom, 'rgba(0,0,0,0.5)');
  for (let l = 0; G.roomBottom(l) < bottom; l++) stripes(ctx, -hw, G.roomBottom(l), G.SHAFT_W, G.SLAB, o.slabA, o.slabB, 16);
  // sealed hatch at the top
  if (T.id === 'spaceship') { P(-hw - 14, -40, G.SHAFT_W + 28, 40, '#2b3a55'); ctx.strokeStyle = '#4cd4ff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, -20, 15, 0, 7); ctx.stroke(); P(-3, -34, 6, 28, '#1d2a40'); P(-hw - 10, -8, 8, 4, Math.floor(now / 500) % 2 ? '#ff4a3a' : '#4a1410'); }
  else if (T.id === 'cyberpunk') { P(-hw - 14, -34, G.SHAFT_W + 28, 34, '#1c1730'); stripes(ctx, -hw - 14, -8, G.SHAFT_W + 28, 8, '#ffe14a', '#120d1f', 12); P(-hw + 6, -26, G.SHAFT_W - 12, 4, '#22e6ff'); P(-hw + 6, -18, G.SHAFT_W - 12, 3, '#ff2a9d'); }
  else {
    for (const [dy, rot] of [[-30, -0.12], [-18, 0.1], [-6, -0.05]]) { ctx.save(); ctx.translate(0, dy); ctx.rotate(rot); P(-hw - 22, -5, G.SHAFT_W + 44, 10, p.floorTop); P(-hw - 22, 3, G.SHAFT_W + 44, 2, p.floorGroove); P(-hw - 16, -2, 3, 3, '#9a9a9a'); P(hw + 12, -2, 3, 3, '#9a9a9a'); ctx.restore(); }
  }
}

// ------------------------------------------------------------------ registry
const FORTRESS = {
  id: 'fortress', label: 'Fortress',
  palette: { void: '#0b0a0c', accent: '#c9a227', muted: '#9a958c', text: '#d8d4cc', ui: '#b0222a', bg: '#0b0a0c' },
  fonts: { title: '"Silkscreen", "VT323", monospace', body: '"VT323", monospace', google: '' },
  lidiaName: 'CPT. LIDIA', lidiaColor: '#ff5a4a', enemyName: 'Zombie',
  // No art hooks: game.js keeps its original code path, so this theme is pixel-identical to before.
  soundSpec: {
    master: 0.5,
    drones: [{ type: 'sine', freq: 48, gain: 0.06, detune: 4, lfo: { rate: 0.06, depth: 0.4 } }],
    noise: [{ color: 'brown', gain: 0.05, filter: { type: 'lowpass', freq: 300 } }],
    events: [{ fx: 'drip', every: [3, 9], gain: 0.05 }, { fx: 'thump', every: [12, 30], gain: 0.05 }, { fx: 'creak', every: [18, 40], gain: 0.04 }],
    ui: { click: 'blip', message: 'chime', alert: 'alarm', done: 'chime' },
  },
};

const finish = (T) => {
  T.ladder = (ctx, l) => ladderShell(T, ctx, l);
  T.tunnel = (ctx, x, w, y0, y1, G, now) => tunnelShell(T, ctx, x, w, y0, y1, G, now);
  T.pocket = (ctx, p, G, now) => pocketShell(T, ctx, p, G, now);
  T.room = (ctx, r, type, label, glow, now, alert, count, G) => roomShell(T, ctx, r, type, label, glow, now, alert, count, G);
  T.dig = (ctx, r) => digShell(T, ctx, r);
  let lid = null;
  T.lidia = () => lid || (lid = T.lidiaAnims());
  let pt = null;
  T.portraitCanvas = () => pt || (pt = T.portrait());
  T.skin = (anims, role) => recolor(anims, T.id, role === 'enemy' ? T.enemySkin : role === 'defender' ? T.defenderSkin : T.agentSkin);
  return T;
};

export const WORLD_THEMES = {
  fortress: FORTRESS,
  spaceship: finish(SHIP),
  westernTown: finish(WEST),
  pirateCove: finish(PIRATE),
  cyberpunk: finish(CYBER),
};
export const WORLD_THEME_IDS = Object.keys(WORLD_THEMES);
export const DEFAULT_WORLD_THEME = 'fortress';

// ------------------------------------------------------------------ runtime state
let current = FORTRESS;
const opts = { reduceMotion: false, osReduce: false };
const listeners = new Set();
let fade = null;                 // { snap, t0 }

/** The active theme object. Fortress has no art hooks, so game.js falls through to its own code. */
export const currentTheme = () => current;
/** The active theme, or null for the original fortress (what game.js hooks test). */
export const activeTheme = () => (current.id === 'fortress' ? null : current);
export const isReducedMotion = () => opts.reduceMotion || opts.osReduce;
/** Subscribe to theme changes; fires immediately with the current theme. Returns an unsubscribe. */
export function onWorldTheme(fn) { listeners.add(fn); try { fn(current); } catch { /* */ } return () => listeners.delete(fn); }

const fontLinks = new Set();
function loadFonts(T) {
  if (!T.fonts.google || fontLinks.has(T.id) || typeof document === 'undefined') return;
  fontLinks.add(T.id);
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = `https://fonts.googleapis.com/css2?family=${T.fonts.google}&display=swap`;
  l.onload = () => { try { T.fonts.title.split(',').slice(0, 1).concat(T.fonts.body.split(',').slice(0, 1)).forEach(f => document.fonts.load(`16px ${f.trim()}`)); } catch { /* */ } };
  document.head.appendChild(l);
}

// Dialogue portrait (talk.js reads art.portrait): swap it through an accessor so it follows the theme.
let origPortrait = art.portrait;
try {
  Object.defineProperty(art, 'portrait', { configurable: true, enumerable: true, get: () => (activeTheme()?.portraitCanvas?.() || origPortrait), set: (v) => { origPortrait = v; } });
} catch { /* art frozen: portrait just stays the default */ }

/** Switch the world theme (animated crossfade unless reduced motion). Returns the applied id. */
export function applyWorldTheme(id) {
  const T = WORLD_THEMES[id] || FORTRESS;
  if (T === current) return T.id;
  const cv = typeof document !== 'undefined' ? document.getElementById('world') : null;
  if (cv && cv.width && !isReducedMotion()) {
    const snap = mk(cv.width, cv.height);
    try { snap.getContext('2d').drawImage(cv, 0, 0); fade = { snap, t0: performance.now() }; } catch { fade = null; }
  } else fade = null;
  current = T;
  loadFonts(T);
  if (typeof document !== 'undefined') {
    const de = document.documentElement, b = document.body;
    de.dataset.worldTheme = T.id; if (b) b.dataset.worldTheme = T.id;
    de.style.setProperty('--world-accent', T.palette.accent); de.style.setProperty('--world-bg', T.palette.bg || T.palette.void);
    de.style.setProperty('--world-text', T.palette.text); de.style.setProperty('--world-font-title', T.fonts.title); de.style.setProperty('--world-font-body', T.fonts.body);
    const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', T.palette.bg || T.palette.void);
  }
  sound.setSpec(T.soundSpec, T.id);
  listeners.forEach(fn => { try { fn(T); } catch { /* */ } });
  try { window.dispatchEvent(new CustomEvent('fortress-world-theme', { detail: { id: T.id, theme: T } })); } catch { /* */ }
  return T.id;
}

/** Draw the crossfade overlay on top of the finished frame (screen space). Call at the end of draw(). */
export function drawThemeFade(ctx, canvas, now) {
  if (!fade) return;
  const k = (performance.now() - fade.t0) / 600;
  if (k >= 1 || isReducedMotion()) { fade = null; return; }
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1 - k * k * (3 - 2 * k);
  ctx.imageSmoothingEnabled = true; ctx.drawImage(fade.snap, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

// ------------------------------------------------------------------ accessibility wiring
const CB = {   // Machado et al. 2009 dichromat simulation matrices (severity 1.0)
  protanopia:   [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881],
  tritanopia:   [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900],
};
const SHIFT = {  // push the information the viewer cannot see into channels they can
  protanopia:   [0, 0, 0, 0.7, 1, 0, 0.7, 0, 1],
  deuteranopia: [1, 0.7, 0, 0, 0, 0, 0, 0.7, 1],
  tritanopia:   [1, 0, 0.7, 0, 1, 0.7, 0, 0, 0],
};
const mul = (a, b) => { const o = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o.push(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]); return o; };
function correction(kind) {   // I + SHIFT * (I - SIM): daltonization
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1], sim = CB[kind], diff = I.map((v, i) => v - sim[i]), add = mul(SHIFT[kind], diff);
  return I.map((v, i) => v + add[i]);
}
function ensureFilters() {
  if (typeof document === 'undefined' || document.getElementById('fortress-cb-defs')) return;
  const rows = (m) => [0, 1, 2].map(i => `${m[i * 3].toFixed(4)} ${m[i * 3 + 1].toFixed(4)} ${m[i * 3 + 2].toFixed(4)} 0 0`).join(' ') + ' 0 0 0 1 0';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'fortress-cb-defs'; svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  svg.innerHTML = '<defs>' + Object.keys(CB).map(k => `<filter id="fortress-cb-${k}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${rows(correction(k))}"/></filter>`).join('') + '</defs>';
  (document.body || document.documentElement).appendChild(svg);
}

/** Apply a settings object { worldTheme, reduceMotion, colorblind, soundOn } (any subset). */
export function applySettings(s = {}) {
  if (typeof document === 'undefined') return;
  if ('reduceMotion' in s) {
    opts.reduceMotion = !!s.reduceMotion;
    document.documentElement.classList.toggle('reduce-motion', isReducedMotion());
    document.body?.classList.toggle('reduce-motion', isReducedMotion());
  }
  if ('colorblind' in s) {
    ensureFilters();
    const v = ['protanopia', 'deuteranopia', 'tritanopia'].includes(s.colorblind) ? s.colorblind : 'none';
    document.body.dataset.colorblind = v; document.documentElement.dataset.colorblind = v;
  }
  if ('soundOn' in s) sound.setEnabled(!!s.soundOn);
  if ('worldTheme' in s) applyWorldTheme(s.worldTheme);
}

export { sound };

if (typeof window !== 'undefined') {
  window.WORLD_THEMES = WORLD_THEMES;
  window.setWorldTheme = applyWorldTheme;
  window.applyWorldSettings = applySettings;
  window.addEventListener('fortress-settings', (e) => applySettings(e.detail?.settings || e.detail || {}));
  try {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    opts.osReduce = mq.matches;
    mq.addEventListener?.('change', (e) => { opts.osReduce = e.matches; document.documentElement.classList.toggle('reduce-motion', isReducedMotion()); });
    if (opts.osReduce) document.documentElement.classList.add('reduce-motion');
  } catch { /* no matchMedia */ }
  if (!document.body.dataset.colorblind) document.body.dataset.colorblind = 'none';
}
