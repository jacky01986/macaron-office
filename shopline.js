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
  const seen = new Set();
  // 從 a.product-item 連結抽 URL — Shopline 用 .product-item class 包整個卡片
  // 同時容忍 href 是單引號 / 雙引號 / 完整 URL
  const allHref = /href=["']([^"']+\/products\/[^"'#?]+)["']/g;
  let m;
  while ((m = allHref.exec(html)) !== null) {
    let href = m[1];
    if (href.includes('{') || href.includes('}') || href.includes('$')) continue;
    // 去掉 hostname 留 path
    href = href.replace(/^https?:\/\/[^\/]+/, '');
    if (seen.has(href)) continue;
    seen.add(href);
    let slug;
    try { slug = decodeURIComponent(href.replace('/products/', '')).replace(/-/g, ' '); } catch { slug = href.replace('/products/', ''); }
    products.push({
      title: slug.trim(),
      price: '',
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

async function getProductsFromAPI({ limit = 100 } = {}) {
  if (!OPEN_API_TOKEN) return null;
  try {
    const r = await openApiCall(withMid('/v1/products?per_page=' + limit));
    const items = r.items || r.data || (Array.isArray(r) ? r : []);
    return items.map(p => ({
      title: (p.title_translations && (p.title_translations['zh-hant'] || p.title_translations.en)) || p.title || '(no title)',
      price: p.price && p.price.dollars ? 'NT$' + p.price.dollars : '',
      stock: p.quantity || (p.unlimited_quantity ? 'unlimited' : 0),
      sku: p.sku || '',
      url: 'https://' + STORE_DOMAIN + '/products/' + (p.handle || p.id),
      image: (p.media && p.media[0] && p.media[0].images && p.media[0].images.original && p.media[0].images.original.url) || '',
      id: p.id,
      status: p.status || '',
    }));
  } catch { return null; }
}

async function getProducts({ refresh = false } = {}) {
  // 有 token 優先用 Open API (含庫存)
  if (OPEN_API_TOKEN) {
    const apiList = await getProductsFromAPI({ limit: 50 });
    if (apiList && apiList.length) {
      return { source: 'open_api', synced_at: Date.now(), count: apiList.length, products: apiList };
    }
  }
  // fallback: storefront scraper
  let c = loadCache();
  const stale = !c || !c.synced_at || (Date.now() - c.synced_at) > CACHE_TTL;
  if (refresh || stale) {
    const r = await syncProducts();
    if (r.products) c = r;
    else if (!c) c = { synced_at: Date.now(), count: 0, products: [] };
  }
  return { source: 'storefront', ...c };
}

// 給其他員工模組 (CAMILLE/RINA/NOVA) 注入用
async function getProductContext() {
  const c = await getProducts();
  if (!c.products || !c.products.length) return '';
  const lines = c.products.slice(0, 30).map(p => `- ${p.title} (${p.price})${p.url ? ' — ' + p.url : ''}`).join('\n');
  return '\n\n=== Shopline 目前在售商品 (寫文案請優先使用真實品名/價格) ===\n' + lines + '\n=== 商品列表結束 ===\n';
}

// ─────────── Open API (等 token) ───────────
const OPEN_BASE = 'https://open.shopline.io';

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

function withMid(qs) { return qs + (qs.includes('?') ? '&' : '?') + 'merchant_id=' + MERCHANT_ID; }
async function getOrders({ from, to, limit = 50 } = {}) {
  return openApiCall(withMid(`/v1/orders?per_page=${limit}${from ? '&created_at_gte=' + encodeURIComponent(from) : ''}${to ? '&created_at_lte=' + encodeURIComponent(to) : ''}`));
}
async function getCustomers({ limit = 50 } = {}) { return openApiCall(withMid('/v1/customers?per_page=' + limit)); }
async function getCheckouts({ limit = 50 } = {}) { return openApiCall(withMid('/v1/checkouts?per_page=' + limit)); }

// 拉客人 + 累積訂單金額 (給客人畫像做真實 RFM)
async function getCustomersWithLTV({ limit = 100 } = {}) {
  if (!OPEN_API_TOKEN) return { ok: false, skipped: true, reason: 'no token' };
  try {
    const cr = await openApiCall(withMid('/v1/customers?per_page=' + limit));
    const customers = cr.items || cr.data || [];
    // 一次拉所有訂單,按 customer_id 匯總
    const or = await openApiCall(withMid('/v1/orders?per_page=200'));
    const orders = or.items || or.data || [];
    const ltv = {};
    for (const o of orders) {
      const cid = o.customer_id; if (!cid) continue;
      const total = (o.total && typeof o.total === 'object') ? (o.total.dollars || 0) : (parseFloat(o.total) || 0);
      if (!ltv[cid]) ltv[cid] = { total: 0, count: 0, last_order: null };
      ltv[cid].total += total;
      ltv[cid].count++;
      const at = o.confirmed_at || o.created_at;
      if (at && (!ltv[cid].last_order || at > ltv[cid].last_order)) ltv[cid].last_order = at;
    }
    const result = customers.map(c => {
      const l = ltv[c.id] || { total: 0, count: 0, last_order: null };
      const lastMs = l.last_order ? new Date(l.last_order).getTime() : 0;
      const recencyDays = lastMs ? Math.floor((Date.now() - lastMs) / 86400000) : 9999;
      let segment = 'unknown';
      if (l.total >= 10000 || l.count >= 2) segment = 'vip';
      else if (l.count >= 1 && recencyDays <= 30) segment = 'active';
      else if (l.count === 0 && c.created_at && (Date.now() - new Date(c.created_at).getTime()) / 86400000 <= 30) segment = 'new';
      else if (l.count >= 1 && recencyDays > 90) segment = 'atrisk';
      else if (l.count === 0) segment = 'new';
      else segment = 'active';
      return {
        id: c.id,
        name: c.name || c.first_name || '(no name)',
        email: c.email || '',
        phone: c.phone || '',
        ltv_total: l.total,
        order_count: l.count,
        last_order_at: l.last_order,
        recency_days: recencyDays,
        segment,
      };
    });
    return { ok: true, count: result.length, customers: result };
  } catch (e) { return { ok: false, error: e.message }; }
}


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


// ─────────── 部落格 (Blog Posts) ───────────
async function publishBlogPost({ title, content_html, tags = [], cover_image_url = '', category_id = null, status = 'published' } = {}) {
  if (!OPEN_API_TOKEN) return { ok: false, skipped: true, reason: 'no token yet' };
  const body = {
    title, content: content_html,
    status,
    tags: Array.isArray(tags) ? tags : [],
    ...(cover_image_url ? { cover_image_url } : {}),
    ...(category_id ? { category_id } : {}),
  };
  try {
    const r = await openApiCall(withMid('/v1/blogs/posts'), { method: 'POST', body });
    return { ok: true, post_id: r.id || r.data?.id, response: r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function listBlogPosts({ limit = 20 } = {}) {
  if (!OPEN_API_TOKEN) return { ok: false, skipped: true, reason: 'no token yet' };
  try {
    const r = await openApiCall(withMid('/v1/blogs/posts?per_page=' + limit));
    return { ok: true, posts: r.items || r.data || r, count: (r.items || r.data || r || []).length };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function getBlogPost(postId) {
  if (!OPEN_API_TOKEN) return { ok: false, skipped: true, reason: 'no token yet' };
  if (!postId) return { ok: false, error: 'postId required' };
  try {
    const r = await openApiCall(withMid('/v1/blogs/posts/' + encodeURIComponent(postId)));
    return { ok: true, post: r };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function updateBlogPost(postId, fields = {}) {
  if (!OPEN_API_TOKEN) return { ok: false, skipped: true, reason: 'no token yet' };
  if (!postId) return { ok: false, error: 'postId required' };
  const allowed = ['title', 'content', 'status', 'tags', 'cover_image_url', 'category_id'];
  const body = {};
  for (const k of allowed) if (fields[k] !== undefined) body[k] = fields[k];
  if (Object.keys(body).length === 0) return { ok: false, error: 'no updatable fields provided' };
  try {
    const r = await openApiCall(withMid('/v1/blogs/posts/' + encodeURIComponent(postId)), { method: 'PATCH', body });
    return { ok: true, post: r };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function deleteBlogPost(postId, { confirmed = false } = {}) {
  if (!OPEN_API_TOKEN) return { ok: false, skipped: true, reason: 'no token yet' };
  if (!postId) return { ok: false, error: 'postId required' };
  if (!confirmed) return { ok: false, error: 'confirmed:true required to delete' };
  try {
    const r = await openApiCall(withMid('/v1/blogs/posts/' + encodeURIComponent(postId)), { method: 'DELETE' });
    return { ok: true, deleted: postId, response: r };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ─────────── DEX 訂單分析輔助 (拿到 token 後 plug-and-play) ───────────
async function getOrdersSummary({ days = 1 } = {}) {
  if (!OPEN_API_TOKEN) return { ok: false, skipped: true, reason: 'no token yet' };
  try {
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const r = await openApiCall(withMid('/v1/orders?per_page=200&created_at_gte=' + from));
    const orders = r.items || r.data || (Array.isArray(r) ? r : []);
    let revenue = 0, count = orders.length, qty = 0;
    let paidCount = 0, paidRevenue = 0;
    const skuQty = {};
    const byStatus = {};
    for (const o of orders) {
      const total = (o.total && typeof o.total === 'object') ? (o.total.dollars || (o.total.cents / 100) || 0) : (parseFloat(o.total) || 0);
      revenue += total;
      const status = o.status || 'unknown';
      byStatus[status] = (byStatus[status] || 0) + 1;
      if (['paid','confirmed','completed'].includes(status)) { paidCount++; paidRevenue += total; }
      for (const li of (o.subtotal_items || o.line_items || o.items || [])) {
        const itemData = li.item_data || {};
        const title = (li.title_translations && (li.title_translations['zh-hant'] || li.title_translations['zh-Hant'] || li.title_translations.en)) || itemData.title || li.title || li.item_id || 'unknown';
        const q = itemData.quantity || li.quantity || 1;
        skuQty[title] = (skuQty[title] || 0) + q;
        qty += q;
      }
    }
    const top = Object.entries(skuQty).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([sku, q]) => ({ sku, q }));
    return { ok: true, days, count, status_breakdown: byStatus, total_revenue: Math.round(revenue), paid_count: paidCount, paid_revenue: Math.round(paidRevenue), aov_all: count ? Math.round(revenue / count) : 0, aov_paid: paidCount ? Math.round(paidRevenue / paidCount) : 0, total_qty: qty, top_skus: top };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ─────────── 棄單事件處理 (給 HANA) ───────────
async function handleAbandonedCheckout(payload) {
  ensureDir();
  const rec = {
    ts: new Date().toISOString(),
    event: 'abandoned_checkout',
    customer_email: (payload && (payload.customer_email || payload.email)) || '',
    customer_phone: (payload && (payload.customer_phone || payload.phone)) || '',
    cart_total: (payload && payload.total) || '',
    line_items: (payload && (payload.line_items || payload.items)) || [],
    payload_keys: payload ? Object.keys(payload) : [],
  };
  // 暫存到 disk,HANA 之後讀
  const HANA_QUEUE = path.join(DATA_DIR, 'shopline-hana-queue.jsonl');
  try { fs.appendFileSync(HANA_QUEUE, JSON.stringify(rec) + '\n'); } catch {}
  // TODO: 之後加: 比對 SaleSmartly chat_user_id (用 email/phone) → 推 HANA 寫 DM 草稿
  return { ok: true, queued: true };
}

// ─────────── Routes ───────────
router.get('/_debug_html', async (req, res) => {
  try {
    const r = await fetch('https://' + STORE_DOMAIN + '/products', { headers: { 'User-Agent': 'Mozilla/5.0 macaron-office bot' } });
    const html = await r.text();
    // Return only product-related snippets (find lines containing /products/)
    const lines = html.split('\n').filter(l => l.includes('/products/') && !l.includes('chunk') && !l.includes('manifest')).slice(0, 20);
    res.json({ ok: true, status: r.status, html_size: html.length, product_lines: lines.map(l => l.replace(/[\r\t]/g, ' ').slice(0, 200)) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/_debug_probe', async (req, res) => {
  if (!OPEN_API_TOKEN) return res.json({ ok: false, error: 'no token set' });
  // v5 — base URL 確定 https://open.shopline.io/v1/, 用 merchant_id query
  const base = 'https://open.shopline.io';
  const mq = '?merchant_id=' + MERCHANT_ID;
  const paths = [
    '/v1/orders?per_page=1' + '&merchant_id=' + MERCHANT_ID,
    '/v1/products?per_page=1' + '&merchant_id=' + MERCHANT_ID,
    '/v1/customers?per_page=1' + '&merchant_id=' + MERCHANT_ID,
    '/v1/checkouts?per_page=1' + '&merchant_id=' + MERCHANT_ID,
    '/v1/blog/posts?per_page=1' + '&merchant_id=' + MERCHANT_ID,
    '/v1/blogs/posts?per_page=1' + '&merchant_id=' + MERCHANT_ID,
    '/v1/blogs?per_page=1' + '&merchant_id=' + MERCHANT_ID,
    '/v1/blog_posts?per_page=1' + '&merchant_id=' + MERCHANT_ID,
    '/v1/posts?per_page=1' + '&merchant_id=' + MERCHANT_ID,
    '/v1/blog_categories' + mq,
    '/v1/articles?per_page=1' + '&merchant_id=' + MERCHANT_ID,
    '/v1/news?per_page=1' + '&merchant_id=' + MERCHANT_ID,
    '/v1/cart?per_page=1' + '&merchant_id=' + MERCHANT_ID,
    '/v1/carts?per_page=1' + '&merchant_id=' + MERCHANT_ID,
    '/v1/abandoned_checkouts' + mq,
  ];
  const out = [];
  for (const path of paths) {
    try {
      const r = await fetch(base + path, { headers: { 'Authorization': 'Bearer ' + OPEN_API_TOKEN, 'Accept': 'application/json' } });
      const text = await r.text();
      const isJson = text.trim().startsWith('{') || text.trim().startsWith('[');
      out.push({ path, status: r.status, isJson, sample_len: text.length });
    } catch (e) { out.push({ path, error: e.message.slice(0, 60) }); }
  }
  res.json({ ok: true, base, results: out });
});

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
// 部落格
router.post('/blog/posts', express.json(), async (req, res) => {
  try { res.json(await publishBlogPost(req.body || {})); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/blog/posts', async (req, res) => {
  try { res.json(await listBlogPosts({ limit: parseInt(req.query.limit) || 20 })); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/blog/posts/:id', async (req, res) => {
  try { res.json(await getBlogPost(req.params.id)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.patch('/blog/posts/:id', express.json(), async (req, res) => {
  try { res.json(await updateBlogPost(req.params.id, req.body || {})); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.delete('/blog/posts/:id', express.json(), async (req, res) => {
  try { res.json(await deleteBlogPost(req.params.id, { confirmed: req.body && req.body.confirmed === true })); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DEX 訂單摘要
router.get('/orders-summary', async (req, res) => {
  try { res.json(await getOrdersSummary({ days: parseInt(req.query.days) || 1 })); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// HANA 棄單佇列檢查
router.get('/customers-ltv', async (req, res) => {
  try { res.json(await getCustomersWithLTV({ limit: parseInt(req.query.limit) || 100 })); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/send-digest', async (req, res) => {
  try { res.json(await sendShoplineDigestToTelegram()); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/hana-queue', (req, res) => {
  try {
    const HANA_QUEUE = path.join(DATA_DIR, 'shopline-hana-queue.jsonl');
    if (!fs.existsSync(HANA_QUEUE)) return res.json({ ok: true, count: 0, items: [] });
    const items = fs.readFileSync(HANA_QUEUE, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    res.json({ ok: true, count: items.length, items: items.slice(-50) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
  // 棄單事件 → 進 HANA 佇列
  if (/abandoned[_-]?checkout|abandoned[_-]?cart/i.test(event)) {
    handleAbandonedCheckout(req.body).catch(e => console.error('[shopline] HANA queue:', e.message));
  }
  res.json({ ok: true, received: event });
});

// ─────────── Cron ───────────
async function sendShoplineDigestToTelegram() {
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  if (!tgToken || !tgChat) return { ok: false, reason: 'no telegram' };
  if (!OPEN_API_TOKEN) return { ok: false, reason: 'no shopline token' };
  try {
    const s = await getOrdersSummary({ days: 1 });
    const w = await getOrdersSummary({ days: 7 });
    const text = '🛒 Shopline 早報 (昨日)\n'
      + '────────────────\n'
      + '訂單: ' + (s.count || 0) + ' 筆 | 營收 NT$' + (s.total_revenue || 0) + ' | AOV NT$' + (s.aov_all || 0) + '\n'
      + '已付: ' + (s.paid_count || 0) + ' 筆 NT$' + (s.paid_revenue || 0) + '\n'
      + '熱賣: ' + (s.top_skus || []).slice(0, 3).map(t => t.sku + '×' + t.q).join(' / ') + '\n\n'
      + '📊 過去 7 天\n'
      + '訂單 ' + (w.count || 0) + ' 筆 | 營收 NT$' + (w.total_revenue || 0) + ' | AOV NT$' + (w.aov_all || 0);
    const r = await fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChat, text })
    });
    return { ok: r.ok };
  } catch (e) { return { ok: false, error: e.message }; }
}

function registerCron(cron) {
  if (!cron || typeof cron.schedule !== 'function') return;
  const tz = process.env.TZ || 'Asia/Taipei';
  // 每天 06:00 抓最新商品 (在 VICTOR 09:00 早報之前 warm 好快取)
  cron.schedule('0 6 * * *', async () => {
    try { const r = await syncProducts(); console.log('[shopline] daily product sync:', r.count, 'items'); }
    catch (e) { console.error('[shopline] sync failed:', e.message); }
  }, { timezone: tz });
  // 每天 09:00 推 Shopline 早報到 Telegram (有 token 才推)
  cron.schedule('0 9 * * *', async () => {
    try { const r = await sendShoplineDigestToTelegram(); console.log('[shopline] morning digest:', r.ok ? 'sent' : r.reason || r.error); }
    catch (e) { console.error('[shopline] digest failed:', e.message); }
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
module.exports.getOrdersSummary = getOrdersSummary;
module.exports.publishBlogPost = publishBlogPost;
module.exports.listBlogPosts = listBlogPosts;
module.exports.getBlogPost = getBlogPost;
module.exports.updateBlogPost = updateBlogPost;
module.exports.deleteBlogPost = deleteBlogPost;
module.exports.getCustomersWithLTV = getCustomersWithLTV;
module.exports.sendShoplineDigestToTelegram = sendShoplineDigestToTelegram;
module.exports.getProductsFromAPI = getProductsFromAPI;
module.exports.handleAbandonedCheckout = handleAbandonedCheckout;
module.exports.getCustomers = getCustomers;
module.exports.getCheckouts = getCheckouts;
module.exports.registerCron = registerCron;
