// Request hygiene: only talk to the local app (blocks DNS-rebinding and cross-site writes), plus security headers.
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const extra = () => new Set(String(process.env.FORTRESS_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean));
const hostOf = (h = '') => h.replace(/:\d+$/, '').toLowerCase();

export function hostAllowed(host) { const h = hostOf(host); return LOCAL.has(h) || extra().has(h); }

export function guard(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), geolocation=(), payment=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; media-src 'self' blob:; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  if (!hostAllowed(req.headers.host)) return res.status(403).json({ error: 'host not allowed' });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const o = req.headers.origin;
    if (o) { let oh; try { oh = new URL(o).host; } catch {} if (oh !== req.headers.host) return res.status(403).json({ error: 'cross-site request blocked' }); }
  }
  next();
}
