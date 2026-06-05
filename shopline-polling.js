// ============================================================
// shopline-polling.js — HANA 棄單 polling (Open API 沒 webhook 改用 polling)
// ============================================================
// 每 15 分鐘抓 /v1/orders 找 status=pending 超過 30min 的未付款訂單
// 視為「棄單」→ 寫進 shopline-hana-queue.jsonl 給 HANA agent 跟客
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
const HANA_SEEN = new Set();  // 已處理過的 order_id (重啟清空,避免重發)

function ensureDir() { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }
function withMid(qs) { return qs + (qs.includes('?') ? '&' : '?') + 'merchant_id=' + MERCHANT_ID; }

async function callOpen(endpoint) {
  const r = await fetch(OPEN_BASE + endpoint, { headers: { 'Authorization': 'Bearer ' + OPEN_API_TOKEN, 'Accept': 'application/json' } });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
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
        line_item_count: (o.subtotal_items || o.line_items || []).length,
      };
      abandoned.push(rec);
      ensureDir();
      try { fs.appendFileSync(HANA_QUEUE, JSON.stringify(rec) + '\n'); } catch {}
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

router.get('/probe-paths', async (req, res) => {  if (!OPEN_API_TOKEN) return res.json({ ok: false, error: 'no token' });  const paths = (req.query.paths || '').split(',').filter(Boolean);  if (!paths.length) return res.json({ ok: false, error: 'pass ?paths=p1,p2,p3 (without leading /v1)' });  const out = [];  for (const raw of paths) {    const p = raw.startsWith('/') ? raw : '/v1/' + raw;    try {      const url = OPEN_BASE + p + (p.includes('?') ? '&' : '?') + 'merchant_id=' + MERCHANT_ID;      const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + OPEN_API_TOKEN, 'Accept': 'application/json' } });      const text = await r.text();      out.push({ path: p, status: r.status, isJson: text.trim().startsWith('{') || text.trim().startsWith('['), sample: text.slice(0, 120) });    } catch (e) { out.push({ path: p, error: e.message.slice(0, 60) }); }  }  res.json({ ok: true, results: out });});// Friendly wrappers for discovered Shopline endpointsrouter.get('/token-info', async (req, res) => {  if (!OPEN_API_TOKEN) return res.json({ ok: false, error: 'no token set' });  try {    const r = await fetch(OPEN_BASE + '/v1/token/info', { headers: { 'Authorization': 'Bearer ' + OPEN_API_TOKEN, 'Accept': 'application/json' } });    const text = await r.text();    let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }    res.json({ ok: r.ok, status: r.status, data });  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }});function registerCron(cron) {
  if (!cron || typeof cron.schedule !== 'function') return;
  const tz = process.env.TZ || 'Asia/Taipei';
  cron.schedule('*/15 * * * *', async () => {
    try { const r = await pollAbandonedOrders(); if (r.new_abandoned) console.log('[shopline-polling] HANA polled,', r.new_abandoned, '個新棄單'); }
    catch (e) { console.error('[shopline-polling] failed:', e.message); }
  }, { timezone: tz });
  console.log('[shopline-polling] cron registered (every 15 min)');
}

module.exports = router;
module.exports.pollAbandonedOrders = pollAbandonedOrders;
module.exports.registerCron = registerCron;
