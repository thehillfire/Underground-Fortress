// Art pipeline. Everything is forced into a strict low-res pixel style:
// key out the chroma background, downsample to a real pixel grid, posterize,
// hard alpha, 1px outline. The world draws it all with nearest-neighbour scaling.
//
// Characters come from sprite *sheets* (rows = animations, columns = frames).
// The slicer finds frames by looking for empty gaps, so slightly irregular
// AI-generated grids still work. Missing files fall back to a drawn pixel cast.

const ROOM_FILES = {
  command: 'room_command.jpg', workshop: 'room_workshop.jpg', library: 'room_library.jpg', server: 'room_server.jpg',
  lab: 'room_lab.jpg', hall: 'room_hall.png', garage: 'room_garage.png', vault: 'room_vault.png',
};
const ROOM_KEYS = Object.keys(ROOM_FILES);
export const art = { rooms: {}, chars: {}, cast: [], surface: null, dirt: null, wall: null };

// Pixel grid sizes (in art pixels). The game draws these at 3x.
export const PX = { roomW: 240, charH: 30, lidiaH: 26, zombieH: 30, surfaceW: 640, dirt: 64 };

// name -> sheet file, rows (animation names), target height, and a palette for the drawn stand-in
const CAST = {
  survivor: { file: 'survivor_sheet.png', anims: ['walk', 'work', 'panic'], h: PX.charH },
  lidia:    { file: 'lidia_sheet.png',    anims: ['walk', 'idle', 'command'], h: PX.lidiaH },
  zombie:   { file: 'zombie_sheet.png',   anims: ['walk', 'idle'], h: PX.zombieH },
  scout:    { file: 'npc_scout_sheet.png',  anims: ['walk', 'work', 'panic'], h: PX.charH, pal: 'scout' },
  smith:    { file: 'npc_smith_sheet.png',  anims: ['walk', 'work', 'panic'], h: PX.charH, pal: 'smith' },
  hacker:   { file: 'npc_hacker_sheet.png', anims: ['walk', 'work', 'panic'], h: PX.charH, pal: 'hacker' },
  defender: { file: 'defender_sheet.png',   anims: ['shoot', 'push'], h: PX.charH, pal: 'defender' },
  zombie2:  { file: 'zombie2_sheet.png',    anims: ['walk', 'attack', 'hit'], h: PX.zombieH, pal: 'zombie2' },
};
// Agents are drawn as one of these characters (picked per agent).
const AGENT_CAST = ['survivor', 'scout', 'smith', 'hacker'];

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

  // A generated sheet that didn't come out as a clean grid is rejected (the drawn stand-in is used).
  if (raw.some(frames => frames.length < 3 || frames.length > 12)) throw new Error(`bad grid: ${raw.map(f => f.length).join('/')} frames per row`);
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
  scout:    { coat: '#4f5a35', coat2: '#343d22', pants: '#2b2a2e', skin: '#e2bea6', hair: '#b8401c', boot: '#151317', acc: '#7a6a4a' },
  smith:    { coat: '#6a4a2c', coat2: '#4a3220', pants: '#3a3a40', skin: '#c99a7a', hair: '#3a2a20', boot: '#151317', acc: '#9ad0e0' },
  hacker:   { coat: '#18181e', coat2: '#0e0e12', pants: '#2c3446', skin: '#6b4a34', hair: '#1a1410', boot: '#d8d8d8', acc: '#3aff7a' },
  defender: { coat: '#2f3330', coat2: '#1d201e', pants: '#2a2c2a', skin: '#c9a48a', hair: '#4a4d48', boot: '#0f0f10', acc: '#8a8f86' },
  zombie2:  { coat: '#8a8f86', coat2: '#5d625a', pants: '#5d625a', skin: '#93a38a', hair: '#1c1a16', boot: '#3a3632', acc: '#f2f6d8', blood: '#7a0d0d' },
};

function person(kind, anim, i) {
  const c = canvas(16, 24), g = c.getContext('2d');
  const P = PAL[kind];
  const px = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  const zombie = kind === 'zombie' || kind === 'zombie2';
  if (anim === 'attack') anim = 'idle';
  if (anim === 'shoot' || anim === 'push') return gunner(P, anim, i);
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
  if (!zombie && kind !== 'lidia') { px(hx - 1, hy - 1, 7, 2, P.hair); px(hx + 5, hy, 1, 1, P.acc); }
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

/** Wall defender with a rifle: firing (muzzle flash on beats) or shoving with the stock. 22x24. */
function gunner(P, anim, i) {
  const c = canvas(22, 24), g = c.getContext('2d');
  const px = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  const kick = anim === 'shoot' && i % 3 === 1 ? 1 : 0;              // recoil
  const lunge = anim === 'push' ? [0, 1, 3, 3, 1, 0][i % 6] : 0;
  const x0 = 4 - kick + lunge;
  px(x0 + 1, 17, 2, 6, P.pants); px(x0 + 4, 17, 2, 6, P.pants);     // braced legs
  px(x0, 22, 3, 2, P.boot); px(x0 + 4, 22, 3, 2, P.boot);
  px(x0, 9, 7, 9, P.coat); px(x0, 12, 7, 2, P.coat2);                // vest
  px(x0 + 1, 3, 5, 6, P.skin); px(x0 + 4, 5, 1, 1, '#111');          // head
  px(x0, 2, 7, 2, '#3c4238'); px(x0 + 1, 1, 5, 1, '#3c4238');        // helmet
  px(x0 + 1, 7, 5, 2, '#5a1a1a');                                     // bandana
  if (anim === 'shoot') {
    px(x0 + 4, 11, 11, 2, '#141416'); px(x0 + 3, 12, 3, 3, '#3a2a1c'); // rifle + stock
    px(x0 + 6, 13, 2, 2, P.skin);
    if (i % 3 === 1) { px(x0 + 15, 10, 3, 4, '#ffd04a'); px(x0 + 17, 11, 2, 2, '#fff2b0'); }
  } else {
    px(x0 + 5, 9, 2, 8, '#141416'); px(x0 + 6, 8 + (lunge > 1 ? 0 : 1), 4, 3, '#3a2a1c'); // rifle held up, stock forward
    px(x0 + 7, 11, 2, 2, P.skin);
  }
  return outline(c);
}

/** Lidia: petite captain, long black ponytail, black uniform with crimson jacket. 16x24, shorter than survivors. */
function lidiaSprite(anim, i) {
  const c = canvas(16, 24), g = c.getContext('2d');
  const px = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  const ph = (i / 6) * Math.PI * 2;
  const step = anim === 'walk' ? Math.round(Math.sin(ph) * 1.5) : 0;
  const bob = anim === 'walk' ? (i % 3 === 0 ? 0 : 1) : (i % 6 < 3 ? 0 : 1);
  const top = 5; // shorter than the survivors
  const skin = '#f0d2bb', hair = '#0d0b10', hairHi = '#2b2638', suit = '#141218', jacket = '#9a1420', jacketDk = '#5e0b14', boot = '#07060a';
  // boots + legs (slim)
  px(7 - step, top + 13, 2, 6, suit); px(9 + step, top + 13, 2, 6, suit);
  px(7 - step, top + 16, 2, 3, boot); px(9 + step, top + 16, 2, 3, boot);
  px(6 - step, top + 18, 3, 1, boot); px(9 + step, top + 18, 3, 1, boot);
  // fitted suit with cropped crimson jacket
  const ty = top + 6 + bob;
  px(7, ty, 5, 8 - bob, suit);
  px(7, ty, 5, 4, jacket); px(7, ty + 4, 5, 1, jacketDk); px(9, ty, 1, 4, jacketDk);
  px(11, ty + 1, 1, 1, '#d4a83a'); // insignia
  // ponytail swings behind the head
  const sway = anim === 'walk' ? Math.round(Math.sin(ph + 1) * 1) : (i % 6 < 3 ? 0 : 1);
  const hy = top + bob;
  px(5 - sway, hy + 1, 2, 2, hair); px(4 - sway, hy + 3, 2, 4, hair); px(4 - sway, hy + 7, 1, 2, hair);
  // head + hair
  px(8, hy + 1, 4, 5, skin);
  px(7, hy, 5, 2, hair); px(7, hy + 2, 1, 3, hair); px(8, hy, 2, 1, hairHi);
  px(11, hy + 3, 1, 1, '#1a1012'); px(11, hy + 5, 1, 1, '#c45a62'); // eye, lips
  px(12, hy + 3, 1, 2, '#3a3a44'); // headset mic
  // arms
  const ax = 10, ay = ty + 1;
  if (anim === 'command') {
    const up = i % 3 === 0 ? 1 : 0;
    px(ax, ay, 5, 1, jacket); px(ax + 5, ay - up, 1, 1, skin); px(6, ay + 2, 1, 3, jacket); // point + hand on hip
  } else if (anim === 'idle') {
    px(ax, ay + 1, 3, 2, jacket); px(ax + 2, ay + 2, 3, 2, '#5ad1ff'); // tablet glow
  } else {
    const sw = anim === 'walk' ? Math.round(-Math.sin(ph) * 1.5) : 0;
    px(ax - 1 + sw, ay, 1, 5, jacket); px(ax - 1 + sw, ay + 5, 1, 1, skin);
  }
  return outline(c);
}

function drawnCast(kind) {
  if (kind === 'lidia') {
    const anims = {};
    for (const a of CAST.lidia.anims) anims[a] = Array.from({ length: 6 }, (_, i) => lidiaSprite(a, i));
    return anims;
  }
  const names = CAST[kind].anims;
  const anims = {};
  for (const a of names) anims[a] = Array.from({ length: 6 }, (_, i) => person(CAST[kind].pal || kind, a, i));
  return anims;
}

/** Key a single figure (magenta or green screen), crop it, and pixelize to `targetH` art pixels. */
function portrait(img, targetH) {
  if (!img) return null;
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = canvas(W, H);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, W, H), p = d.data;
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let i = 0, j = 0; i < p.length; i += 4, j++) {
    if (isKey(p[i], p[i + 1], p[i + 2])) { p[i + 3] = 0; continue; }
    const x = j % W, y = (j / W) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  g.putImageData(d, 0, 0);
  if (x1 <= x0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  return outline(pixelize(downsample(cropTo(c, x0, y0, w, h), Math.round(w * targetH / h), targetH), 14));
}

/** Drawn stand-in for the dialogue portrait: waist-up Lidia, 44x56 art pixels. */
function drawnPortrait() {
  const c = canvas(44, 56), g = c.getContext('2d');
  const px = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  const skin = '#f0d2bb', skinSh = '#d9b29a', hair = '#0d0b10', hairHi = '#2e2840', jacket = '#9a1420', jacketDk = '#5e0b14', suit = '#141218';
  // ponytail (behind)
  px(30, 6, 6, 4, hair); px(33, 10, 5, 12, hair); px(34, 22, 4, 10, hair); px(35, 32, 2, 6, hair);
  // shoulders / jacket
  px(8, 38, 30, 18, jacket); px(6, 42, 34, 14, jacket); px(19, 38, 8, 18, suit); px(20, 38, 6, 3, skin);
  px(8, 44, 4, 12, jacketDk); px(34, 44, 4, 12, jacketDk); px(12, 40, 4, 2, '#d4a83a'); // insignia
  // neck + face
  px(19, 32, 7, 7, skinSh);
  px(14, 12, 17, 21, skin); px(15, 31, 15, 3, skin); px(14, 26, 2, 5, skinSh);
  // hair: sleek, centre part, framing strands
  px(13, 6, 20, 7, hair); px(12, 9, 4, 18, hair); px(29, 9, 4, 10, hair); px(16, 6, 6, 2, hairHi); px(25, 7, 4, 1, hairHi);
  px(16, 12, 3, 9, hair);
  // eyes with winged liner, brows, lips
  px(18, 17, 5, 1, hair); px(25, 17, 4, 1, hair);
  px(18, 20, 4, 2, '#1a1012'); px(22, 19, 1, 1, '#1a1012'); px(25, 20, 3, 2, '#1a1012'); px(28, 19, 1, 1, '#1a1012');
  px(19, 20, 1, 1, '#e8f4ff'); px(26, 20, 1, 1, '#e8f4ff');
  px(22, 23, 2, 3, skinSh); px(21, 28, 5, 1, '#b8404c'); px(22, 29, 3, 1, '#d06070');
  // headset
  px(30, 18, 2, 6, '#3a3a44'); px(27, 24, 4, 1, '#3a3a44'); px(26, 24, 1, 2, '#5ad1ff');
  // tablet glow in hand
  px(2, 48, 10, 8, '#0b2a33'); px(3, 49, 8, 6, '#5ad1ff'); px(10, 47, 4, 4, '#1a1a1f');
  return outline(c);
}

function backdrop(img, w, levels = 12, darken = 0.92) {
  if (!img) return null;
  const h = Math.round(w * img.naturalHeight / img.naturalWidth);
  return pixelize(downsample(img, w, h), levels, darken);
}

const redWash = (anims) => Object.fromEntries(Object.entries(anims).map(([k, fr]) => [k, fr.map(f => tinted(f, 'rgba(230,10,10,0.55)'))]));

export async function loadArt() {
  const [surface, dirt, portraitImg, wallImg, ...rest] = await Promise.all([
    load('assets/surface.jpg'), load('assets/dirt.jpg'), load('assets/lidia_portrait.png'), load('assets/wall.png'),
    ...ROOM_KEYS.map(k => load(`assets/${ROOM_FILES[k]}`)),
    ...Object.values(CAST).map(c => load(`assets/${c.file}`)),
  ]);
  const rooms = rest.slice(0, ROOM_KEYS.length), sheets = rest.slice(ROOM_KEYS.length);
  Object.keys(CAST).forEach((kind, i) => {
    let anims = null;
    if (sheets[i]) { try { anims = sliceSheet(sheets[i], CAST[kind].anims, CAST[kind].h); } catch (e) { console.warn('sheet', kind, e.message); } }
    if (!anims || Object.values(anims).some(f => !f.length)) anims = drawnCast(kind);
    art.chars[kind] = anims;
  });
  // Every agent is one of these characters; each has a red-washed copy for the "needs Jav" state.
  art.cast = AGENT_CAST.map(k => ({ kind: k, anims: art.chars[k], red: redWash(art.chars[k]) }));
  art.chars.survivorRed = art.cast[0].red;
  art.portrait = portrait(portraitImg, 120) || drawnPortrait();
  art.wall = portrait(wallImg, 60);
  art.surface = backdrop(surface, PX.surfaceW, 10, 0.85);
  art.dirt = backdrop(dirt, PX.dirt, 8, 0.45);
  ROOM_KEYS.forEach((k, i) => {
    const img = rooms[i];
    art.rooms[k] = img ? pixelize(downsample(img, PX.roomW, Math.round(PX.roomW * img.naturalHeight / img.naturalWidth)), 12, 0.95) : null;
  });
  return art;
}
