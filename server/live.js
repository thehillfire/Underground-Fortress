// Live activity: what an agent is doing right now (answered instantly, from the real log, not by asking
// the model), and getting screenshots and images from tools into the chat.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_IMG = 8 << 20;
export const isImagePath = (p) => /\.(png|jpe?g|webp|gif)$/i.test(String(p));

const STATUS_Q = /\b(what('?s|\s+is|\s+are|\s+r)?\s*(you|u|ya)\s*(doing|working( on)?|up to|on)|what('?s|\s+is)\s+(the\s+)?(status|progress|going on|happening|the update)|(status|progress)\s*(update|report)?\??$|how('?s|\s+is)\s+(it|everything|that|this)\s+going|where\s+(are|r)\s+(you|we|u)|(any|got\s+an?)\s+(update|progress)|update\s+me|what\s+have\s+you\s+(done|got|made)|(are\s+you|r\s+u)\s+(done|stuck|working|alive|still)|you\s+(there|alive|working)\??|show\s+me\s+(what|your|the)|what\s+did\s+you\s+(do|make))\b/i;

/** Is this text a "what are you doing?" kind of question? Short messages only. */
export function isStatusQuestion(text) {
  const t = String(text || '').trim();
  return t.length > 0 && t.length <= 140 && STATUS_Q.test(t);
}

const ago = (ms) => { const s = Math.max(1, Math.round(ms / 1000)); return s < 90 ? `${s}s` : `${Math.round(s / 60)} min`; };

/** A first-person, factual status built from the agent's live state and log. */
export function statusText(s, now = Date.now()) {
  const lines = [];
  const turnStart = s.turnStart || (s.log.findLast?.(e => e.role === 'jav' || e.role === 'lidia')?.ts) || now;
  const cur = s.curTool ? `${s.curTool.name}: ${s.curTool.text}` : '';
  lines.push(`Right now I'm ${s.activity || 'working'}${cur ? ` (${cur.slice(0, 120)})` : ''}. I've been at this ${ago(now - turnStart)}${s.steps ? ` and have taken ${s.steps} step${s.steps === 1 ? '' : 's'}` : ''}.`);
  if (s.todos?.length) {
    const mark = { completed: '✓', in_progress: '▶', pending: '○' };
    lines.push(`My plan: ${s.todos.map(t => `${mark[t.status] || '○'} ${t.text}`).join(' · ')}`);
  }
  const since = s.log.map(e => e.role).lastIndexOf('jav');
  const tools = s.log.slice(Math.max(0, since)).filter(e => e.role === 'tool').slice(-6);
  if (tools.length) lines.push(`Just did: ${tools.map(t => `${t.tool} ${String(t.text).replace(/\s+/g, ' ').slice(0, 60)}`).join('; ')}.`);
  const said = [...s.log].reverse().find(e => e.role === 'claude' && !e.status && e.text?.trim());
  if (said) lines.push(`Last thing I told you: "${said.text.replace(/\s+/g, ' ').slice(0, 160)}"`);
  if (s.lastShot) lines.push(`Latest screenshot is below (${ago(now - s.lastShot.ts)} old).`);
  return lines.join('\n');
}

/** Copy an image file into the chat's upload folder; returns the chat file record. */
export function copyIn(dir, src) {
  const p = path.resolve(String(src));
  const st = fs.statSync(p);
  if (!st.isFile()) throw new Error('not a file');
  if (!isImagePath(p)) throw new Error('only png, jpg, webp or gif images can be shared');
  if (st.size > MAX_IMG) throw new Error('image is larger than 8 MB');
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(p).slice(1).toLowerCase();
  const name = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${crypto.randomBytes(2).toString('hex')}_${path.basename(p).replace(/[^\w.\-]+/g, '_').slice(0, 60)}`;
  fs.copyFileSync(p, path.join(dir, name));
  return { name, original: path.basename(p), type: MIME[ext] || 'image/png', size: st.size, ts: Date.now() };
}

/** Save base64 image data (from a screenshot tool's result) into the chat's upload folder. */
export function saveData(dir, b64, mime = 'image/png', label = 'screenshot') {
  const buf = Buffer.from(String(b64), 'base64');
  if (buf.length < 500 || buf.length > MAX_IMG) throw new Error('image too small or too large');
  fs.mkdirSync(dir, { recursive: true });
  const ext = EXT[mime] || 'png';
  const name = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${crypto.randomBytes(2).toString('hex')}_${label.replace(/[^\w]+/g, '-').slice(0, 30)}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return { name, original: `${label}.${ext}`, type: EXT[mime] ? mime : 'image/png', size: buf.length, ts: Date.now(), sha: crypto.createHash('sha1').update(buf).digest('hex') };
}

/** Pull images out of a tool result, whatever shape it has (Claude content blocks or MCP content). */
export function extractImages(resp, out = [], depth = 0) {
  if (!resp || depth > 6) return out;
  if (Array.isArray(resp)) { for (const x of resp) extractImages(x, out, depth + 1); return out; }
  if (typeof resp !== 'object') return out;
  if (resp.type === 'image') {
    const data = resp.source?.data ?? resp.data;
    const mime = resp.source?.media_type ?? resp.mimeType ?? resp.mime_type ?? 'image/png';
    if (typeof data === 'string' && data.length > 600) out.push({ data, mime });
    return out;
  }
  for (const k of ['content', 'output', 'result', 'results', 'tool_response', 'message']) if (resp[k]) extractImages(resp[k], out, depth + 1);
  return out;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'uploads', '.cache']);
/** Image files a shell command just made in the workspace (e.g. a headless browser screenshot). */
export function newImages(root, sinceTs, max = 2) {
  const found = [];
  const walk = (d, depth) => {
    if (depth > 2 || found.length >= 12) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(f, depth + 1); }
      else if (isImagePath(e.name)) { try { const st = fs.statSync(f); if (st.mtimeMs >= sinceTs - 500 && st.size > 2048 && st.size <= MAX_IMG) found.push({ f, m: st.mtimeMs }); } catch {} }
    }
  };
  walk(root, 0);
  return found.sort((a, b) => b.m - a.m).slice(0, max).map(x => x.f);
}
