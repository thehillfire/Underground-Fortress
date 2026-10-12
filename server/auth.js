// Optional local login for the fortress: passphrase (scrypt) + optional TOTP second factor,
// 15-minute JWT access cookie + rotating refresh cookie (reuse of an old refresh token revokes the whole login).
// Off until Jav sets a passphrase, so the phone app keeps working; once on, every /api and /ws call needs it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './store.js';
import { hashPassword, checkPassword, signJwt, verifyJwt, sha256, newTotpSecret, verifyTotp } from './crypto.js';
import { allow } from './ratelimit.js';
import * as audit from './audit.js';

const FILE = path.join(DATA_DIR, 'auth.json');
const ACCESS_TTL = 15 * 60, REFRESH_TTL = 30 * 864e2 * 1;   // refresh: 30 days (in seconds below)
const REFRESH_SECONDS = 30 * 24 * 3600;

const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { refresh: [] }; } };
const write = (a) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(a), { mode: 0o600 }); };

export const enabled = () => !!read().pwHash;
export const mfaEnabled = () => !!read().totp;

export function parseCookies(h = '') {
  const out = {};
  for (const p of String(h).split(';')) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return out;
}
export const isAuthed = (headers) => !enabled() || !!verifyJwt(parseCookies(headers.cookie).fort_at);

function issue(res, family) {
  const a = read();
  const raw = crypto.randomBytes(32).toString('base64url');
  a.refresh = (a.refresh || []).filter(r => r.exp > Date.now()).slice(-20);
  a.refresh.push({ hash: sha256(raw), family, exp: Date.now() + REFRESH_SECONDS * 1000, used: false });
  write(a);
  const base = 'HttpOnly; SameSite=Strict; Path=/';
  res.append('Set-Cookie', `fort_at=${signJwt({ sub: 'jav', fam: family }, ACCESS_TTL)}; Max-Age=${ACCESS_TTL}; ${base}`);
  res.append('Set-Cookie', `fort_rt=${raw}; Max-Age=${REFRESH_SECONDS}; ${base}`);
}

export function setup(pw, wantMfa = false) {
  if (enabled()) throw new Error('A passphrase is already set. Log in to change it.');
  if (String(pw).length < 10) throw new Error('Use at least 10 characters.');
  const a = read();
  a.pwHash = hashPassword(String(pw));
  let secret = null;
  if (wantMfa) { secret = newTotpSecret(); a.totp = secret; }
  write(a);
  audit.record('jav', 'auth.setup', 'passphrase', wantMfa ? 'mfa enabled' : '');
  return { mfaSecret: secret };
}

export function login(res, ip, pw, code) {
  if (!allow(`login:${ip}`, 5, 1 / 30)) throw new Error('Too many attempts. Wait a minute.');
  const a = read();
  if (!a.pwHash || !checkPassword(pw, a.pwHash) || (a.totp && !verifyTotp(a.totp, code || ''))) {
    audit.record('system', 'auth.failed', ip);
    throw new Error('Wrong passphrase or code.');
  }
  issue(res, crypto.randomUUID());
  audit.record('jav', 'auth.login', ip);
}

export function refresh(req, res) {
  const raw = parseCookies(req.headers.cookie).fort_rt;
  const a = read();
  const rec = raw && (a.refresh || []).find(r => r.hash === sha256(raw));
  if (!rec || rec.exp < Date.now()) throw new Error('Session expired. Log in again.');
  if (rec.used) {                       // a stolen, already-rotated token: kill the whole login
    a.refresh = a.refresh.filter(r => r.family !== rec.family); write(a);
    audit.record('system', 'auth.refresh-reuse', rec.family, 'family revoked');
    throw new Error('Session revoked. Log in again.');
  }
  rec.used = true; write(a);
  issue(res, rec.family);
}

export function logout(req, res) {
  const raw = parseCookies(req.headers.cookie).fort_rt;
  const a = read();
  const rec = raw && (a.refresh || []).find(r => r.hash === sha256(raw));
  if (rec) { a.refresh = a.refresh.filter(r => r.family !== rec.family); write(a); }
  res.append('Set-Cookie', 'fort_at=; Max-Age=0; Path=/'); res.append('Set-Cookie', 'fort_rt=; Max-Age=0; Path=/');
}

/** Turn login off again (needs to be logged in). */
export function disable() { const a = read(); delete a.pwHash; delete a.totp; a.refresh = []; write(a); audit.record('jav', 'auth.disabled', ''); }

const PUBLIC = [/^\/api\/auth\//, /^\/api\/health$/];
export function middleware(req, res, next) {
  if (!enabled()) return next();
  const p = req.path;
  if (!p.startsWith('/api/') || PUBLIC.some(re => re.test(p))) return next();
  if (verifyJwt(parseCookies(req.headers.cookie).fort_at)) return next();
  res.status(401).json({ error: 'login required', login: true });
}
