// Loads the OpenArt art and forces it into a strict low-res pixel style:
// key out the green screen, downsample to a real pixel grid, posterize, hard alpha.
// The world is then drawn with nearest-neighbour scaling, so every asset reads
// as chunky pixel art even when the generated image is soft.

const ROOM_KEYS = ['command', 'workshop', 'library', 'server', 'lab'];
export const art = { rooms: {}, lidia: null, worker: null, workerRed: null, surface: null, dirt: null };

// Pixel grid sizes (in art pixels). The game scales these up by whole-ish factors.
export const PX = { roomW: 240, roomH: 135, charH: 40, lidiaH: 44, surfaceW: 640, dirt: 64 };

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

/** Downsample in halving steps (box-filter-ish) so detail averages instead of aliasing. */
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

/** Remove the #00FF00 background, crop to content, pixelize to `targetH` art pixels. */
function sprite(img, targetH) {
  if (!img) return null;
  const c = canvas(img.naturalWidth, img.naturalHeight);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  const p = d.data;
  let minX = c.width, minY = c.height, maxX = 0, maxY = 0;
  for (let i = 0; i < p.length; i += 4) {
    const r = p[i], gr = p[i + 1], b = p[i + 2];
    const dom = gr - Math.max(r, b);
    if (gr > 80 && dom > 50) { p[i + 3] = 0; continue; }
    if (dom > 15) p[i + 1] = Math.max(r, b); // de-spill
    const px = (i / 4) % c.width, py = (i / 4 / c.width) | 0;
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  }
  g.putImageData(d, 0, 0);
  if (maxX <= minX) return null;
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const crop = canvas(w, h);
  crop.getContext('2d').drawImage(c, minX, minY, w, h, 0, 0, w, h);
  return outline(pixelize(downsample(crop, Math.max(1, Math.round(w * targetH / h)), targetH), 9));
}

/** 1px dark outline around opaque pixels: the classic sprite read against busy backgrounds. */
function outline(src) {
  const c = canvas(src.width + 2, src.height + 2);
  const g = c.getContext('2d');
  const sil = canvas(src.width, src.height);
  const sg = sil.getContext('2d');
  sg.drawImage(src, 0, 0); sg.globalCompositeOperation = 'source-in'; sg.fillStyle = '#0a0809'; sg.fillRect(0, 0, sil.width, sil.height);
  for (const [dx, dy] of [[0, 1], [2, 1], [1, 0], [1, 2]]) g.drawImage(sil, dx, dy);
  g.drawImage(src, 1, 1);
  return c;
}

function tinted(src, color) {
  if (!src) return null;
  const c = canvas(src.width, src.height);
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

function backdrop(img, w, levels = 12, darken = 0.92) {
  if (!img) return null;
  const h = Math.round(w * img.naturalHeight / img.naturalWidth);
  return pixelize(downsample(img, w, h), levels, darken);
}

export async function loadArt() {
  const [lidia, worker, surface, dirt, ...rooms] = await Promise.all([
    load('assets/lidia.jpg'), load('assets/worker.jpg'), load('assets/surface.jpg'), load('assets/dirt.jpg'),
    ...ROOM_KEYS.map(k => load(`assets/room_${k}.jpg`)),
  ]);
  art.lidia = sprite(lidia, PX.lidiaH);
  art.worker = sprite(worker, PX.charH);
  art.workerRed = tinted(art.worker, 'rgba(220,10,10,0.6)');
  art.surface = backdrop(surface, PX.surfaceW, 10, 0.85);
  art.dirt = backdrop(dirt, PX.dirt, 8, 0.45);
  ROOM_KEYS.forEach((k, i) => {
    art.rooms[k] = rooms[i] ? pixelize(downsample(rooms[i], PX.roomW, PX.roomH), 12, 0.95) : null;
  });
  return art;
}
