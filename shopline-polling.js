// ============================================================
// shopline-polling.js — HANA 棄單 polling + extra endpoints
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const MERCHANT_ID  = process.env.SHOPLINE_MERCHANT_ID || '69f1698b1f3f880036d82ae3';
const OPEN_API_TOKEN = process.env.SHOPLINE_ACCESS_TOKEN || '';
const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const HANA_QUEUE = path.join(DATA_DIR, 'shopline-hana-queue.jsonl');
const OPEN_BASE = 'https://open.shopline.io';
const HANA_SEEN = new Set();

function ensureDir() { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {} }
function withMid(qs) { return qs + (qs.includes('?') ? '&' : '?') + 'merchant_id=' + MERCHANT_ID; }

async function callOpen(endpoint) {
  const r = await fetch(OPEN_BASE + endpoint, { headers: { 'Authorization': 'Bearer ' + OPEN_API_TOKEN, 'Accept': 'application/json' } });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 200) }; }
  if (!r.ok) throw new Error('Shopline ' + r.status);
  return data;
}

async function pollAbandonedOrders() {
  if (!OPEN_API_TOKEN) return { ok: false, skipped: true, reason: 'no token' };
  try {
    const since = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const r = await callOpen(withMid('/v1/orders?per_page=100&created_at_gte=' + since));
    const orders = r.items || r.data || (Array.isArray(r) ? r : []);
    const now = Date.now();
    const abandoned = [];
    for (const o of orders) {
      const status = o.status || '';
      if (!['pending', 'temp', 'unpaid'].includes(status)) continue;
      const createdAt = new Date(o.created_at || 0).getTime();
      if (!createdAt) continue;
      const minutesOld = (now - createdAt) / 60000;
      if (minutesOld < 30) continue;
      if (HANA_SEEN.has(o.id)) continue;
      HANA_SEEN.add(o.id);
      const customer = o.customer || {};
      const total = (o.total && typeof o.total === 'object') ? (o.total.dollars || 0) : (parseFloat(o.total) || 0);
      const rec = {
        ts: new Date().toISOString(),
        event: 'abandoned_order_polled',
        order_id: o.id,
        order_number: o.order_number || o.number,
        customer_name: customer.name || customer.first_name || '',
        customer_email: customer.email || o.customer_email || '',
        customer_phone: customer.phone || o.customer_phone || '',
        cart_total: total,
        minutes_old: Math.round(minutesOld),
        line_item_count: (o.subtotal_items || o.line_items || []).length
      };
      abandoned.push(rec);
      ensureDir();
      try { fs.appendFileSync(HANA_QUEUE, JSON.stringify(rec) + '\n'); } catch (e) {}
    }
    return { ok: true, total_checked: orders.length, new_abandoned: abandoned.length, abandoned };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

router.get('/poll-abandoned', async (req, res) => {
  try { res.json(await pollAbandonedOrders()); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/probe-paths', async (req, res) => {
  if (!OPEN_API_TOKEN) return res.json({ ok: false, error: 'no token' });
  const paths = (req.query.paths || '').split(',').filter(Boolean);
  if (!paths.length) return res.json({ ok: false, error: 'pass ?paths=p1,p2,p3' });
  const out = [];
  for (const raw of paths) {
    const p = raw.startsWith('/') ? raw : '/v1/' + raw;
    try {
      const url = OPEN_BASE + p + (p.includes('?') ? '&' : '?') + 'merchant_id=' + MERCHANT_ID;
      const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + OPEN_API_TOKEN, 'Accept': 'application/json' } });
      const text = await r.text();
      out.push({ path: p, status: r.status, isJson: text.trim().startsWith('{') || text.trim().startsWith('['), sample: text.slice(0, 120) });
    } catch (e) {
      out.push({ path: p, error: e.message.slice(0, 60) });
    }
  }
  res.json({ ok: true, results: out });
});

// Friendly GET wrappers for discovered endpoints
function wrapGet(p) {
  return async (req, res) => {
    if (!OPEN_API_TOKEN) return res.json({ ok: false, error: 'no token' });
    try {
      const url = OPEN_BASE + '/v1/' + p + '?merchant_id=' + MERCHANT_ID;
      const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + OPEN_API_TOKEN, 'Accept': 'application/json' } });
      res.json(await r.json());
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  };
}

router.get('/categories', wrapGet('categories'));
router.get('/promotions', wrapGet('promotions'));
router.get('/staffs', wrapGet('staffs'));
router.get('/warehouses', wrapGet('warehouses'));
router.get('/customer-groups', wrapGet('customer_groups'));
router.get('/payments', wrapGet('payments'));
router.get('/webhooks', wrapGet('webhooks'));

// Test register webhook via GET
router.get('/test-register-webhook', async (req, res) => {
  if (!OPEN_API_TOKEN) return res.json({ ok: false, error: 'no token' });
  const topic = req.query.topic || 'orders/create';
  const callback_url = req.query.callback_url || 'https://macaron-office.onrender.com/api/shopline/webhook';
  try {
    const url = OPEN_BASE + '/v1/webhooks?merchant_id=' + MERCHANT_ID;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + OPEN_API_TOKEN, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ webhook: { topic, callback_url, format: 'json' } })
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 500) }; }
    res.json({ ok: r.ok, status: r.status, topic, callback_url, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/team-brief', async (req, res) => {  if (!OPEN_API_TOKEN) return res.json({ ok: false, error: 'no token' });  try {    const dToday = new Date(Date.now() - 86400000).toISOString().slice(0,10);    const dWeek  = new Date(Date.now() - 7*86400000).toISOString().slice(0,10);    const safe = (p) => callOpen(p).catch(e => ({ error: e.message, items: [] }));    const [oT, oW, cs, ps, pms] = await Promise.all([      safe(withMid('/v1/orders?per_page=100&created_at_gte=' + dToday)),      safe(withMid('/v1/orders?per_page=200&created_at_gte=' + dWeek)),      safe(withMid('/v1/customers?per_page=100')),      safe(withMid('/v1/products?per_page=30')),      safe(withMid('/v1/promotions?per_page=20'))    ]);    const sumO = (arr) => { let rv=0,pd=0;const sk={};for(const o of (arr||[])){const t=(o.total&&typeof o.total==='object')?(o.total.dollars||0):(parseFloat(o.total)||0);rv+=t;if(['paid','confirmed','completed'].includes(o.status))pd++;for(const li of (o.subtotal_items||o.line_items||[])){const tt=(li.title_translations&&(li.title_translations['zh-hant']||li.title_translations['zh-Hant']))||li.title||'?';const q=(li.item_data&&li.item_data.quantity)||li.quantity||1;sk[tt]=(sk[tt]||0)+q;}}return{count:(arr||[]).length,revenue:Math.round(rv),paid:pd,top_skus:Object.entries(sk).sort((a,b)=>b[1]-a[1]).slice(0,5)};};    res.json({      ok: true,      generated_at: new Date().toISOString(),      today: sumO(oT.items || oT.data || []),      week: sumO(oW.items || oW.data || []),      customer_count: (cs.items || []).length,      vip_candidates: (cs.items || []).slice(0, 10).map(c => ({ name: c.name, email: c.email, phone: c.phone })),      top_products: (ps.items || []).slice(0, 10).map(p => ({ title: (p.title_translations && (p.title_translations['zh-hant'] || p.title_translations['zh-Hant'])) || p.title, price: p.price && p.price.dollars, stock: p.quantity, status: p.status })),      active_promotions: (pms.items || []).filter(p => p.status === 'active').slice(0, 10).map(p => ({ name: (p.title_translations && (p.title_translations['zh-hant'] || p.title_translations['zh-Hant'])) || p.title || p.name, discount: p.discount_percentage || p.discount_amount, code: p.code }))    });  } catch (e) {    res.status(500).json({ ok: false, error: e.message });  }});router.get('/team-brief-md', async (req, res) => {  try {    const port = process.env.PORT || 10000;    const r = await fetch('http://localhost:' + port + '/api/shopline-polling/team-brief');    const j = await r.json();    if (!j.ok) return res.type('text/plain').send('Error: ' + (j.error || 'unknown'));    const lines = [      '# 🛒 Shopline 商業 brief — ' + j.generated_at.slice(0, 10),      '',      '## 📊 過去 24 小時',      '- 訂單: ' + j.today.count + ' 筆 | 營收: NT$' + j.today.revenue + ' | 已付: ' + j.today.paid + ' 筆',      '- 熱賣: ' + j.today.top_skus.map(s => s[0] + ' x' + s[1]).join(' / '),      '',      '## 📈 過去 7 天',      '- 訂單: ' + j.week.count + ' 筆 | 營收: NT$' + j.week.revenue + ' | 已付: ' + j.week.paid + ' 筆',      '- 7日熱賣: ' + j.week.top_skus.map(s => s[0] + ' x' + s[1]).join(' / '),      '',      '## 🛍️ 商品 (' + j.top_products.length + ' 個)',      ...j.top_products.map(p => '- ' + p.title + ' | NT$' + (p.price || '?') + ' | 庫存 ' + (p.stock != null ? p.stock : '∞') + ' | ' + (p.status || '?')),      '',      '## 🎯 進行中促銷 (' + j.active_promotions.length + ' 個)',      ...j.active_promotions.map(p => '- ' + p.name + ' ' + (p.discount ? p.discount + '%' : '') + (p.code ? ' (code: ' + p.code + ')' : '')),      '',      '## 👥 客戶 (' + j.customer_count + ' 人)',      ...j.vip_candidates.slice(0, 5).map(c => '- ' + (c.name || '?') + ' | ' + (c.email || '') + ' | ' + (c.phone || ''))    ];    res.type('text/plain').send(lines.join('
'));  } catch (e) { res.status(500).type('text/plain').send('Error: ' + e.message); }});router.get('/token-info', async (req, res) => {
  if (!OPEN_API_TOKEN) return res.json({ ok: false, error: 'no token set' });
  try {
    const r = await fetch(OPEN_BASE + '/v1/token/info', { headers: { 'Authorization': 'Bearer ' + OPEN_API_TOKEN, 'Accept': 'application/json' } });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 500) }; }
    res.json({ ok: r.ok, status: r.status, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function registerCron(cron) {
  if (!cron || typeof cron.schedule !== 'function') return;
  const tz = process.env.TZ || 'Asia/Taipei';
  cron.schedule('*/15 * * * *', async () => {
    try {
      const r = await pollAbandonedOrders();
      if (r.new_abandoned) console.log('[shopline-polling] HANA polled,', r.new_abandoned, 'new');
    } catch (e) {
      console.error('[shopline-polling] failed:', e.message);
    }
  }, { timezone: tz });
  console.log('[shopline-polling] cron registered (every 15 min)');
}

module.exports = router;
module.exports.pollAbandonedOrders = pollAbandonedOrders;
module.exports.registerCron = registerCron;
