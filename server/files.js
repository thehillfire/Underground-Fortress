// Attachments from Jav (camera photos, screenshots, any file). Saved where the
// agent can read them; images also go to Claude directly so it can see them.
import fs from 'node:fs';
import path from 'node:path';

const IMAGE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_FILE = 15 << 20, MAX_TOTAL = 40 << 20;
const TEXTISH = /^(text\/|application\/(json|xml|javascript|x-yaml|csv))/;

const safeName = (n) => (String(n || 'file').replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'file');

/** files: [{ name, type, data (base64) }] -> saved metadata (+ base64 kept for images/text). */
export function saveUploads(dir, files = []) {
  if (!files.length) return [];
  fs.mkdirSync(dir, { recursive: true });
  let total = 0;
  return files.map((f) => {
    const buf = Buffer.from(String(f.data || ''), 'base64');
    if (buf.length > MAX_FILE) throw new Error(`${f.name} is larger than 15 MB`);
    total += buf.length;
    if (total > MAX_TOTAL) throw new Error('Attachments are larger than 40 MB in total');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `${stamp}_${safeName(f.name)}`;
    fs.writeFileSync(path.join(dir, name), buf);
    const type = String(f.type || 'application/octet-stream');
    return { name, original: safeName(f.name), type, size: buf.length, path: path.join(dir, name),
      image: IMAGE.has(type) && buf.length <= 5 << 20, data: IMAGE.has(type) ? buf.toString('base64') : null,
      text: TEXTISH.test(type) && buf.length < 100_000 ? buf.toString('utf8') : null };
  });
}

/** Build the prompt: plain text, or text + image blocks when images are attached. */
export function promptWithFiles(text, saved, { inlineText = false } = {}) {
  if (!saved.length) return text;
  const list = saved.map(f => `- ${f.original} (${f.type}, ${Math.round(f.size / 1024)} KB) saved at ${f.path}`).join('\n');
  let body = `${text || 'Jav sent you these files.'}\n\nJav attached ${saved.length} file${saved.length > 1 ? 's' : ''}:\n${list}`;
  if (inlineText) for (const f of saved) if (f.text) body += `\n\n--- ${f.original} ---\n${f.text}`;
  const images = saved.filter(f => f.image);
  if (!images.length) return body;
  return [{ type: 'text', text: `${body}\n\nThe image${images.length > 1 ? 's are' : ' is'} included below.` },
    ...images.map(f => ({ type: 'image', source: { type: 'base64', media_type: f.type, data: f.data } }))];
}

/** What the chat log keeps (no file contents). */
export const fileMeta = (saved) => saved.map(f => ({ name: f.name, original: f.original, type: f.type, size: f.size }));

export function resolveUpload(dir, name) {
  const p = path.join(dir, path.basename(String(name)));
  return p.startsWith(dir + path.sep) && fs.existsSync(p) ? p : null;
}
