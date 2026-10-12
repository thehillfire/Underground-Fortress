// Attach photos, screenshots and files to a message. Camera photos and big
// images are shrunk on the phone first (max 1600px JPEG) so they send fast.
import { esc } from './rich.js';

const MAX_SIDE = 1600;

function readAsBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && file.size < 1.5e6) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; } finally { URL.revokeObjectURL(url); }
}

/**
 * Wire attach buttons + a preview tray to a composer.
 * Returns { take(): Promise<[{name,type,data}]>, count() }.
 */
export function makeAttach({ tray, cameraBtn, filesBtn, onChange }) {
  let files = [];
  const input = (accept, capture) => {
    const el = document.createElement('input');
    el.type = 'file'; el.accept = accept; el.multiple = !capture;
    if (capture) el.setAttribute('capture', 'environment');
    el.onchange = () => { add([...el.files]); el.remove(); };
    el.style.display = 'none';
    document.body.appendChild(el);
    el.click();
  };
  cameraBtn.onclick = () => input('image/*', true);
  filesBtn.onclick = () => input('*/*', false);

  function add(list) { files.push(...list.slice(0, 10 - files.length)); render(); }
  function render() {
    tray.hidden = !files.length;
    tray.innerHTML = files.map((f, i) => f.type.startsWith('image/')
      ? `<div class="att"><img src="${URL.createObjectURL(f)}" alt=""><button type="button" data-rm="${i}">X</button></div>`
      : `<div class="att file"><span>${esc(f.name)}</span><button type="button" data-rm="${i}">X</button></div>`).join('');
    tray.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { files.splice(+b.dataset.rm, 1); render(); });
    onChange?.(files.length);
  }
  return {
    count: () => files.length,
    async take() {
      const out = [];
      for (const f of files) {
        const g = await shrinkImage(f);
        out.push({ name: g.name || 'file', type: g.type || 'application/octet-stream', data: await readAsBase64(g) });
      }
      files = []; render();
      return out;
    },
  };
}

/** Thumbnails/chips for files already sent, shown in the chat. */
export function fileChips(owner, files) {
  if (!files?.length) return '';
  return `<div class="att-row">${files.map(f => {
    const url = `/api/files/${encodeURIComponent(owner)}/${encodeURIComponent(f.name)}`;
    return f.type?.startsWith('image/')
      ? `<a href="${url}" target="_blank" rel="noopener" class="att-img"><img src="${url}" alt="${esc(f.original)}" loading="lazy"></a>`
      : `<a href="${url}" target="_blank" rel="noopener" class="att-file">${esc(f.original)}</a>`;
  }).join('')}</div>`;
}
