// Local crypto: one master key on the phone (never in git, never sent anywhere), used for
// HMAC-signed bus messages, AES-256-GCM encryption of private memory/exports, and JWT signing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const KEY_FILE = path.join(DATA_DIR, '.master.key');
let master;
function key() {
  if (master) return master;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { master = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex'); } catch {}
  if (!master || master.length !== 32) {
    master = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, master.toString('hex'), { mode: 0o600 });
  }
  return master;
}
const sub = (label) => crypto.createHmac('sha256', key()).update(`fortress:${label}`).digest();

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (label, data) => crypto.createHmac('sha256', sub(label)).update(data).digest('hex');
export const timingEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). */
export function encrypt(plain, label = 'data') {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sub(`aes:${label}`), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
export function decrypt(blob, label = 'data') {
  const b = Buffer.from(String(blob), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', sub(`aes:${label}`), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

// ---- JWT (HS256), short-lived
const b64u = (b) => Buffer.from(b).toString('base64url');
export function signJwt(payload, ttlSec = 900) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ ...payload, iat: now, exp: now + ttlSec }));
  return `${h}.${p}.${crypto.createHmac('sha256', sub('jwt')).update(`${h}.${p}`).digest('base64url')}`;
}
export function verifyJwt(tok) {
  const [h, p, sig] = String(tok || '').split('.');
  if (!h || !p || !sig) return null;
  const want = crypto.createHmac('sha256', sub('jwt')).update(`${h}.${p}`).digest('base64url');
  if (!timingEqual(sig, want)) return null;
  try { const body = JSON.parse(Buffer.from(p, 'base64url').toString()); return body.exp > Date.now() / 1000 ? body : null; } catch { return null; }
}

// ---- password hashing
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
export function checkPassword(pw, stored) {
  const [, salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  return timingEqual(crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 32).toString('hex'), hash);
}

// ---- TOTP (RFC 6238) for optional MFA
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret() { return [...crypto.randomBytes(20)].map(b => B32[b % 32]).join(''); }
function totpAt(secret, t) {
  let bits = '';
  for (const ch of secret.toUpperCase()) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = Buffer.from(bits.match(/.{8}/g).map(x => parseInt(x, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(t / 30)));
  const h = crypto.createHmac('sha1', bytes).update(msg).digest();
  const o = h[19] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
export function verifyTotp(secret, code, now = Date.now() / 1000) {
  return [-30, 0, 30].some(d => timingEqual(totpAt(secret, now + d), String(code).trim()));
}
export const totpNow = totpAt;

// ---- redaction of secrets and PII for logs and audit
const PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, '[secret]'], [/\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/g, '[secret]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[secret]'], [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]'],
  [/(authorization|bearer|token|secret|password|passwd|api[_-]?key)(["'\s:=]+)([^\s"',;]{6,})/gi, '$1$2[redacted]'],
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]'], [/\b(?:\d[ -]?){13,19}\b/g, '[card]'], [/\b\d{3}-\d{2}-\d{4}\b/g, '[ssn]'],
  [/\+?\d{1,2}[\s.-]?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, '[phone]'],
];
export function redact(text) { let t = String(text ?? ''); for (const [re, to] of PATTERNS) t = t.replace(re, to); return t; }
