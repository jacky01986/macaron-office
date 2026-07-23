// ============================================================
// auth.js - Admin authentication (HMAC-signed cookie)
// ============================================================
// Triggers if process.env.ADMIN_PASS is set AND AUTH_ENABLED!="false".
// Whitelist paths (webhooks + static assets + login flow) bypass auth.
// All other UI/API paths require valid cookie -> redirect /login.html.
// ============================================================

const crypto = require('crypto');

module.exports = function attachAuth(app) {
  const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
  const ADMIN_USER = process.env.ADMIN_USER || 'admin';
  const ADMIN_PASS = process.env.ADMIN_PASS || '';
  const AUTH_ENABLED = process.env.AUTH_ENABLED !== 'false' && !!ADMIN_PASS;
  const COOKIE_NAME = '_mo_auth';
  const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

  if (!AUTH_ENABLED) {
    console.warn('[auth] DISABLED - set ADMIN_PASS env var to enable');
    // Still register login endpoints so client can detect status
    app.get('/api/auth/status', (req, res) => res.json({ enabled: false, user: null }));
    return;
  }
  console.log('[auth] ENABLED, admin user:', ADMIN_USER);

  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
    return body + '.' + sig;
  }

  function verify(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    try {
      const expected = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
      const sigBuf = Buffer.from(sig);
      const expBuf = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length) return null;
      if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (payload.exp && payload.exp < Date.now()) return null;
      return payload;
    } catch (e) { return null; }
  }

  function parseCookies(req) {
    const c = {};
    (req.headers.cookie || '').split(';').forEach(s => {
      const i = s.indexOf('=');
      if (i < 0) return;
      const k = s.slice(0, i).trim();
      const v = s.slice(i + 1).trim();
      if (k) {
        try { c[k] = decodeURIComponent(v); } catch { c[k] = v; }
      }
    });
    return c;
  }

  function constantTimeStringCompare(a, b) {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  }

  // Login endpoint - accepts JSON {username, password}
  app.post('/api/login', (req, res) => {
    const username = (req.body && req.body.username) || '';
    const password = (req.body && req.body.password) || '';
    const okUser = constantTimeStringCompare(username, ADMIN_USER);
    const okPass = constantTimeStringCompare(password, ADMIN_PASS);
    if (!okUser || !okPass) {
      return res.status(401).json({ error: '帳號或密碼錯誤' });
    }
    const token = sign({ u: username, exp: Date.now() + COOKIE_MAX_AGE });
    res.setHeader('Set-Cookie',
      COOKIE_NAME + '=' + token +
      '; HttpOnly; Path=/; Max-Age=' + Math.floor(COOKIE_MAX_AGE / 1000) +
      '; SameSite=Lax; Secure'
    );
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', COOKIE_NAME + '=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure');
    res.json({ ok: true });
  });

  app.get('/api/auth/status', (req, res) => {
    const cookies = parseCookies(req);
    const payload = verify(cookies[COOKIE_NAME]);
    res.json({ enabled: true, user: payload ? payload.u : null });
  });

  // Whitelist (paths that DO NOT require auth)
  const WHITELIST = [
    /^\/login\.html$/,
    /^\/api\/login$/,
    /^\/api\/logout$/,
    /^\/api\/auth\/status$/,
    /^\/api\/telegram\/webhook$/,
    /^\/api\/salesmartly\/webhook$/,
    /^\/api\/line\/webhook$/,
    /^\/api\/health$/,
    /^\/favicon/,
    // Static assets
    /\.(css|js|png|jpg|jpeg|gif|svg|webp|woff2?|ttf|ico|map|webmanifest)$/i,
    /^\/manifest\.webmanifest$/,
    /^\/sw\.js$/,
  ];

  // Auth gate middleware - everything else requires cookie
  app.use((req, res, next) => {
    const p = req.path || '/';
    if (WHITELIST.some(re => re.test(p))) return next();

    const cookies = parseCookies(req);
    const payload = verify(cookies[COOKIE_NAME]);
    if (payload) {
      req.user = payload;
      return next();
    }

    const accepts = (req.headers.accept || '').toLowerCase();
    // For HTML page requests: redirect to login
    if (accepts.includes('text/html') || p.endsWith('.html') || p === '/') {
      return res.redirect('/login.html');
    }
    // For API: 401 JSON
    res.status(401).json({ error: 'unauthorized', login: '/login.html' });
  });
};
