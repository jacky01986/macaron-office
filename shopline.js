// ============================================================
// shopline.js — Shopline 整合 (Storefront scraper + Open API 骨架)
// ============================================================
// Phase 1 (現在): Storefront 抓商品 (不用 token) → 提供給員工寫文案
// Phase 2 (拿到 token 後): /orders /customers /checkouts → DEX + HANA 棄單
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const STORE_DOMAIN = process.env.SHOPLINE_STORE || 'warmplacehere.shoplineapp.com';
const MERCHANT_ID  = process.env.SHOPLINE_MERCHANT_ID || '69f1698b1f3f880036d82ae3';
const OPEN_API_TOKEN = process.env.SHOPLINE_ACCESS_TOKEN || '';
const WEBHOOK_SECRET = process.env.SHOPLINE_WEBHOOK_SECRET || '';
const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'shopline-products.json');
const CACHE_TTL = 4 * 3600 * 1000;  // 4 小時

function ensureDir() { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }

// ─────────── Storefront 爬蟲 ───────────
function decodeHtml(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function parseProductsFromHTML(html) {
  const products = [];
  // 從 /products/{slug} 連結抽 URL — 比 div regex 穩
  const urlRE = /href="(\/products\/[^"#?]+)"/g;
  const seen = new Set();
  let m;
  while ((m = urlRE.exec(html)) !== null) {
    const href = m[1];
    if (seen.has(href)) continue; seen.add(href);
    const slug = decodeURIComponent(href.replace('/products/', '')).replace(/-/g, ' ');
    products.push({
      title: slug.trim(),
      price: '',  // 詳情頁再抓
      url: 'https://' + STORE_DOMAIN + href,
      image: '',
      slug: href.replace('/products/', ''),
    });
  }
  return products;
}

// 從單一商品詳情頁抓價格 + 圖
async function fetchProductDetail(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 macaron-office bot' } });
    if (!r.ok) return {};
    const html = await r.text();
    // og:title 比較準
    const titleM = html.match(/<meta property="og:title" content="([^"]+)"/);
    const priceM = html.match(/<meta property="product:price:amount" content="([^"]+)"/)
                || html.match(/"price"[^:]*:\s*"?(\d+\.?\d*)"?/);
    const imageM = html.match(/<meta property="og:image" content="([^"]+)"/);
    const currM = html.match(/<meta property="product:price:currency" content="([^"]+)"/);
    return {
      title: titleM ? decodeHtml(titleM[1]).trim() : '',
      price: priceM ? (currM ? currM[1] + ' ' : 'NT$') + priceM[1] : '',
      image: imageM ? imageM[1] : '',
    };
  } catch { return {}; }
}

async function fetchStorefront() {
  const url = 'https://' + STORE_DOMAIN + '/products';
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 macaron-office bot' } });
  if (!r.ok) throw new Error('Storefront HTTP ' + r.status);
  const html = await r.text();
  let products = parseProductsFromHTML(html);
  // 平行抓每個商品詳情頁 (拿真實 title/price/image)
  const details = await Promise.all(products.map(p => fetchProductDetail(p.url)));
  products = products.map((p, i) => ({
    title: details[i].title || p.title,  // og:title 優先,fallback URL slug
    price: details[i].price || p.price,
    image: details[i].image || p.image,
    url: p.url,
    slug: p.slug,
  }));
  return { products, html_size: html.length };
}

async function syncProducts() {
  try {
    const { products } = await fetchStorefront();
    ensureDir();
    const rec = { synced_at: Date.now(), count: products.length, products };
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(rec, null, 2)); } catch {}
    return rec;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return null; }
}

async function getProducts({ refresh = false } = {}) {
  let c = loadCache();
  const stale = !c || !c.synced_at || (Date.now() - c.synced_at) > CACHE_TTL;
  if (refresh || stale) {
    const r = await syncProducts();
    if (r.products) c = r;
    else if (!c) c = { synced_at: Date.now(), count: 0, products: [] };
  }
  return c;
}

// 給其他員工模組 (CAMILLE/RINA/NOVA) 注入用
async function getProductContext() {
  const c = await getProducts();
  if (!c.products || !c.products.length) return '';
  const lines = c.products.slice(0, 30).map(p => `- ${p.title} (${p.price})${p.url ? ' — ' + p.url : ''}`).join('\n');
  return '\n\n=== Shopline 目前在售商品 (寫文案請優先使用真實品名/價格) ===\n' + lines + '\n=== 商品列表結束 ===\n';
}

// ─────────── Open API (等 token) ───────────
const OPEN_BASE = 'https://open.shoplineapp.com';

async function openApiCall(endpoint, opts = {}) {
  if (!OPEN_API_TOKEN) throw new Error('SHOPLINE_ACCESS_TOKEN 未設定 — 還在等客服開通');
  const url = OPEN_BASE + endpoint;
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + OPEN_API_TOKEN,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  if (!r.ok) throw new Error('Shopline API ' + r.status + ': ' + (data.message || text.slice(0, 200)));
  return data;
}

async function getOrders({ from, to, limit = 50 } = {}) {
  return openApiCall(`/api/v1/orders?per_page=${limit}${from ? '&created_at_gte=' + encodeURIComponent(from) : ''}${to ? '&created_at_lte=' + encodeURIComponent(to) : ''}`);
}
async function getCustomers({ limit = 50 } = {}) { return openApiCall('/api/v1/customers?per_page=' + limit); }
async function getCheckouts({ limit = 50 } = {}) { return openApiCall('/api/v1/checkouts?per_page=' + limit); }

// ─────────── Webhook 接收 (給 HANA 棄單) ───────────
function verifyWebhook(req) {
  if (!WEBHOOK_SECRET) return true;  // 還沒設就先放行
  const sig = req.get('x-shopline-hmac-sha256') || req.get('X-Shopline-Signature');
  if (!sig) return false;
  try {
    const crypto = require('crypto');
    const computed = crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.rawBody || JSON.stringify(req.body)).digest('base64');
    return computed === sig;
  } catch { return false; }
}

const WEBHOOK_LOG = path.join(DATA_DIR, 'shopline-webhook.jsonl');
function logWebhook(event, body) {
  ensureDir();
  try {
    const rec = { ts: new Date().toISOString(), event, body };
    fs.appendFileSync(WEBHOOK_LOG, JSON.stringify(rec) + '\n');
  } catch {}
}

// ─────────── Routes ───────────
router.get('/_status', async (req, res) => {
  const cache = loadCache();
  res.json({
    ok: true,
    storefront: { domain: STORE_DOMAIN, merchant_id: MERCHANT_ID, cached_products: cache ? cache.count : 0, cache_age_min: cache ? Math.floor((Date.now() - cache.synced_at) / 60000) : null },
    open_api: { token_set: !!OPEN_API_TOKEN, webhook_secret_set: !!WEBHOOK_SECRET },
  });
});

router.get('/products', async (req, res) => {
  try {
    const refresh = String(req.query.refresh || '') === '1';
    const c = await getProducts({ refresh });
    res.json({ ok: true, ...c });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/sync', async (req, res) => {
  try { res.json({ ok: true, ...(await syncProducts()) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 等 token 後可用
router.get('/orders', async (req, res) => {
  try { res.json({ ok: true, ...(await getOrders(req.query)) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/customers', async (req, res) => {
  try { res.json({ ok: true, ...(await getCustomers(req.query)) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Webhook — 棄單事件給 HANA
router.post('/webhook', express.json({ verify: (req, _res, buf) => { req.rawBody = buf } }), (req, res) => {
  if (!verifyWebhook(req)) return res.status(401).json({ ok: false, error: 'invalid signature' });
  const event = req.get('x-shopline-event') || (req.body && req.body.event) || 'unknown';
  logWebhook(event, req.body);
  // TODO: if event === 'abandoned_checkout' → trigger HANA DM draft
  res.json({ ok: true, received: event });
});

// ─────────── Cron ───────────
function registerCron(cron) {
  if (!cron || typeof cron.schedule !== 'function') return;
  const tz = process.env.TZ || 'Asia/Taipei';
  // 每天 06:00 抓最新商品 (在 VICTOR 09:00 早報之前 warm 好快取)
  cron.schedule('0 6 * * *', async () => {
    try { const r = await syncProducts(); console.log('[shopline] daily product sync:', r.count, 'items'); }
    catch (e) { console.error('[shopline] sync failed:', e.message); }
  }, { timezone: tz });
  // 啟動時也跑一次 (確保 deploy 後立刻有資料)
  setTimeout(async () => { try { const r = await syncProducts(); console.log('[shopline] startup sync:', r.count, 'items'); } catch (e) { console.error('[shopline] startup sync:', e.message); } }, 8000);
  console.log('[shopline] cron registered (daily 06:00 + startup sync)');
}

module.exports = router;
module.exports.getProducts = getProducts;
module.exports.getProductContext = getProductContext;
module.exports.syncProducts = syncProducts;
module.exports.getOrders = getOrders;
module.exports.getCustomers = getCustomers;
module.exports.getCheckouts = getCheckouts;
module.exports.registerCron = registerCron;
