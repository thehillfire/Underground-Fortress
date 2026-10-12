// Art pipeline. Everything is forced into a strict low-res pixel style:
// key out the chroma background, downsample to a real pixel grid, posterize,
// hard alpha, 1px outline. The world draws it all with nearest-neighbour scaling.
//
// Characters come from sprite *sheets* (rows = animations, columns = frames).
// The slicer finds frames by looking for empty gaps, so slightly irregular
// AI-generated grids still work. Missing files fall back to a drawn pixel cast.

const ROOM_KEYS = ['command', 'workshop', 'library', 'server', 'lab'];
export const art = { rooms: {}, chars: {}, surface: null, dirt: null };

// Pixel grid sizes (in art pixels). The game draws these at 3x.
export const PX = { roomW: 240, roomH: 135, charH: 30, lidiaH: 32, zombieH: 30, surfaceW: 640, dirt: 64 };

// name -> sheet file, rows (animation names), target height
const CAST = {
  survivor: { file: 'survivor_sheet.png', anims: ['walk', 'work', 'panic'], h: PX.charH },
  lidia:    { file: 'lidia_sheet.png',    anims: ['walk', 'idle', 'command'], h: PX.lidiaH },
  zombie:   { file: 'zombie_sheet.png',   anims: ['walk', 'idle'], h: PX.zombieH },
};

function load(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

/** Posterize to a limited palette and snap alpha to 0/255. */
function pixelize(c, levels = 10, darken = 1) {
  const g = c.getContext('2d', { willReadFrequently: true });
  const d = g.getImageData(0, 0, c.width, c.height);
  const p = d.data, step = 255 / (levels - 1);
  for (let i = 0; i < p.length; i += 4) {
    for (let k = 0; k < 3; k++) p[i + k] = Math.round((p[i + k] * darken) / step) * step;
    p[i + 3] = p[i + 3] > 110 ? 255 : 0;
  }
  g.putImageData(d, 0, 0);
  return c;
}

/** Downsample in halving steps so detail averages instead of aliasing. */
function downsample(src, w, h) {
  let cur = src, cw = src.width || src.naturalWidth, ch = src.height || src.naturalHeight;
  while (cw / 2 > w * 1.5) {
    const n = canvas(Math.round(cw / 2), Math.round(ch / 2));
    const g = n.getContext('2d'); g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, n.width, n.height);
    cur = n; cw = n.width; ch = n.height;
  }
  const out = canvas(w, h);
  const g = out.getContext('2d'); g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, w, h);
  return out;
}

/** 1px dark outline around opaque pixels. */
function outline(src) {
  const c = canvas(src.width + 2, src.height + 2);
  const g = c.getContext('2d');
  const sil = canvas(src.width, src.height);
  const sg = sil.getContext('2d');
  sg.drawImage(src, 0, 0); sg.globalCompositeOperation = 'source-in'; sg.fillStyle = '#070506'; sg.fillRect(0, 0, sil.width, sil.height);
  for (const [dx, dy] of [[0, 1], [2, 1], [1, 0], [1, 2]]) g.drawImage(sil, dx, dy);
  g.drawImage(src, 1, 1);
  return c;
}

export function tinted(src, color) {
  const c = canvas(src.width, src.height);
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

// ------------------------------------------------------------ sprite sheets
function isKey(r, g, b) {
  // magenta screen (and green, for older single sprites)
  return (r > 140 && b > 140 && g < 120 && Math.abs(r - b) < 100) || (g > 80 && g - Math.max(r, b) > 50);
}

/** Split [0,n) into runs where occupied[i] is true, bridging gaps smaller than minGap. */
function runs(occupied, minGap) {
  const out = []; let start = -1, lastOn = -1;
  for (let i = 0; i < occupied.length; i++) {
    if (occupied[i]) { if (start < 0) start = i; lastOn = i; }
    else if (start >= 0 && i - lastOn >= minGap) { out.push([start, lastOn + 1]); start = -1; }
  }
  if (start >= 0) out.push([start, lastOn + 1]);
  return out;
}

function sliceSheet(img, rowNames, targetH) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = canvas(W, H);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, W, H), p = d.data;
  const solid = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < p.length; i += 4, j++) {
    const r = p[i], gr = p[i + 1], b = p[i + 2];
    if (isKey(r, gr, b)) { p[i + 3] = 0; continue; }
    // de-spill magenta fringes
    const m = Math.min(r, b) - gr;
    if (m > 25) { p[i] = p[i + 2] = gr + 20; }
    solid[j] = 1;
  }
  g.putImageData(d, 0, 0);

  const rowOcc = new Array(H).fill(false);
  for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x++) n += solid[y * W + x]; rowOcc[y] = n > 2; }
  let bands = runs(rowOcc, Math.max(4, H * 0.01)).filter(([a, b]) => b - a > H * 0.05);
  if (bands.length !== rowNames.length) {
    const bh = H / rowNames.length;
    bands = rowNames.map((_, i) => [Math.round(i * bh), Math.round((i + 1) * bh)]);
  }

  const raw = bands.map(([y0, y1]) => {
    const colOcc = new Array(W).fill(false);
    for (let x = 0; x < W; x++) { let n = 0; for (let y = y0; y < y1; y++) n += solid[y * W + x]; colOcc[x] = n > 1; }
    let segs = runs(colOcc, Math.max(3, W * 0.006));
    const widths = segs.map(([a, b]) => b - a).sort((a, b) => a - b);
    const med = widths[widths.length >> 1] || 1;
    segs = segs.filter(([a, b]) => b - a > med * 0.25); // drop specks
    return segs.map(([x0, x1]) => {
      let top = y1, bot = y0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (solid[y * W + x]) { if (y < top) top = y; if (y > bot) bot = y; }
      return { x0, x1, top, bot: bot + 1 };
    });
  });

  // One scale for the whole sheet so the character never changes size between frames.
  const heights = raw.flat().map(f => f.bot - f.top).sort((a, b) => a - b);
  const refH = heights[Math.floor(heights.length * 0.75)] || 1;
  const scale = targetH / refH;
  const maxW = Math.max(...raw.flat().map(f => f.x1 - f.x0));
  const cellW = Math.ceil(maxW * scale) + 2, cellH = Math.ceil(Math.max(...heights) * scale) + 2;

  const anims = {};
  raw.forEach((frames, ri) => {
    const baseline = Math.max(...frames.map(f => f.bot));
    anims[rowNames[ri]] = frames.map((f) => {
      const fw = f.x1 - f.x0, fh = baseline - f.top;
      const small = downsample(cropTo(c, f.x0, f.top, fw, fh), Math.max(1, Math.round(fw * scale)), Math.max(1, Math.round(fh * scale)));
      const cell = canvas(cellW, cellH);
      cell.getContext('2d').drawImage(small, Math.round((cellW - small.width) / 2), cellH - small.height);
      return outline(pixelize(cell, 9));
    });
  });
  return anims;
}

function cropTo(src, x, y, w, h) {
  const c = canvas(w, h);
  c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
  return c;
}

// ------------------------------------------------------------ drawn fallback cast
// Tiny pixel people (16x24) with real frame-by-frame animation.
const PAL = {
  survivor: { coat: '#cfcac0', coat2: '#8e8a82', pants: '#3b3a40', skin: '#d6b39a', hair: '#d8b31f', boot: '#151317', acc: '#e8e3a0' },
  lidia:    { coat: '#8a1a1c', coat2: '#4f0d10', pants: '#1c1a1f', skin: '#e0bfa8', hair: '#121014', boot: '#0c0a0d', acc: '#5ad1ff' },
  zombie:   { coat: '#4d5244', coat2: '#2f332a', pants: '#3a3030', skin: '#7f9a74', hair: '#2a2620', boot: '#1d1a1a', acc: '#e6f2c8', blood: '#6a0d0d' },
};

function person(kind, anim, i) {
  const c = canvas(16, 24), g = c.getContext('2d');
  const P = PAL[kind];
  const px = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  const zombie = kind === 'zombie';
  const ph = (i / 6) * Math.PI * 2;
  const step = anim === 'walk' ? Math.round(Math.sin(ph) * 2) : 0;
  const bob = anim === 'walk' ? (i % 3 === 0 ? 0 : 1) : (anim === 'idle' || anim === 'work') ? (i % 6 < 3 ? 0 : 1) : 0;
  const hunch = zombie ? 2 : 0;
  // legs
  px(6 - step, 17, 2, 6, P.pants); px(8 + step, 17, 2, 6, P.pants);
  px(5 - step, 22, 3, 2, P.boot); px(8 + step, 22, 3, 2, P.boot);
  if (zombie && anim === 'walk' && i % 2) px(10 + step, 22, 2, 1, P.boot); // dragging foot
  // torso / coat
  const ty = 9 + bob;
  px(5 + hunch, ty, 7, 9 - bob, P.coat); px(5 + hunch, ty + 6, 7, 1, P.coat2);
  if (kind === 'lidia') { px(4 + hunch, ty + 4, 1, 6, P.coat2); px(11, ty + 1, 1, 2, '#d4a83a'); }
  if (zombie) { px(7 + hunch, ty + 2, 2, 2, P.blood); px(9 + hunch, ty + 5, 1, 3, P.blood); }
  // head
  const hx = 6 + hunch + (zombie ? 1 : 0), hy = 3 + bob + (zombie ? 1 : 0);
  px(hx, hy, 5, 5, P.skin);
  px(hx + 3, hy + 2, 1, 1, zombie ? P.acc : '#111');
  if (kind === 'survivor') { px(hx - 1, hy - 1, 7, 2, P.hair); px(hx + 5, hy, 1, 1, P.acc); }
  else if (kind === 'lidia') { px(hx - 1, hy - 1, 6, 2, P.hair); px(hx - 1, hy + 1, 1, 3, P.hair); px(hx + 4, hy + 3, 2, 1, '#333'); }
  else { px(hx, hy - 1, 3, 1, P.hair); px(hx + 1, hy + 4, 3, 1, P.blood); }
  // arms
  const ax = 8 + hunch, ay = ty + 1;
  if (anim === 'panic') {
    const up = i % 2;
    px(ax - 3, ay - 5 - up, 2, 6, P.coat2); px(ax + 3, ay - 5 - (1 - up), 2, 6, P.coat2);
    px(ax - 3, ay - 6 - up, 2, 1, P.skin); px(ax + 3, ay - 6 - (1 - up), 2, 1, P.skin);
  } else if (anim === 'work') {
    const tap = i % 2;
    px(ax + 1, ay + 3, 5, 2, P.coat2); px(ax + 5, ay + 3 + tap, 2, 1, P.skin);
  } else if (anim === 'command') {
    px(ax + 1, ay + 1, 6, 2, P.coat2); px(ax + 7, ay + 1 - (i % 3 === 0 ? 1 : 0), 2, 1, P.skin);
  } else if (zombie) {
    px(ax + 2, ay + 1 + (i % 3 === 0 ? 1 : 0), 6, 2, P.coat2); px(ax + 8, ay + 1 + (i % 3 === 0 ? 1 : 0), 2, 2, P.skin);
  } else {
    const sw = anim === 'walk' ? Math.round(-Math.sin(ph) * 2) : 0;
    px(ax + sw, ay, 2, 7, P.coat2); px(ax + sw, ay + 7, 2, 1, P.skin);
    if (kind === 'lidia' && anim === 'idle') px(ax + 2, ay + 3, 3, 2, P.acc); // tablet glow
  }
  return outline(c);
}

function drawnCast(kind) {
  const names = CAST[kind].anims;
  const anims = {};
  for (const a of names) anims[a] = Array.from({ length: 6 }, (_, i) => person(kind, a, i));
  return anims;
}

function backdrop(img, w, levels = 12, darken = 0.92) {
  if (!img) return null;
  const h = Math.round(w * img.naturalHeight / img.naturalWidth);
  return pixelize(downsample(img, w, h), levels, darken);
}

export async function loadArt() {
  const [surface, dirt, ...rest] = await Promise.all([
    load('assets/surface.jpg'), load('assets/dirt.jpg'),
    ...ROOM_KEYS.map(k => load(`assets/room_${k}.jpg`)),
    ...Object.values(CAST).map(c => load(`assets/${c.file}`)),
  ]);
  const rooms = rest.slice(0, ROOM_KEYS.length), sheets = rest.slice(ROOM_KEYS.length);
  Object.keys(CAST).forEach((kind, i) => {
    let anims = null;
    if (sheets[i]) { try { anims = sliceSheet(sheets[i], CAST[kind].anims, CAST[kind].h); } catch (e) { console.warn('sheet', kind, e); } }
    if (!anims || Object.values(anims).some(f => !f.length)) anims = drawnCast(kind);
    art.chars[kind] = anims;
  });
  // A red-washed copy of the survivor for the "needs Jav" state.
  art.chars.survivorRed = Object.fromEntries(Object.entries(art.chars.survivor).map(([k, fr]) => [k, fr.map(f => tinted(f, 'rgba(230,10,10,0.55)'))]));
  art.surface = backdrop(surface, PX.surfaceW, 10, 0.85);
  art.dirt = backdrop(dirt, PX.dirt, 8, 0.45);
  ROOM_KEYS.forEach((k, i) => { art.rooms[k] = rooms[i] ? pixelize(downsample(rooms[i], PX.roomW, PX.roomH), 12, 0.95) : null; });
  return art;
}
