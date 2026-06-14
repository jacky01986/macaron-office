// personal-edm.js — 個人化觸及系統(完整版)
// 從 Shopline 拉客戶,RFM 分群,NOVA 寫個人化訊息,用戶在控制台審核 + 發送,追蹤 ROI
// 模式:跟 ai-team-upgrades.js 一樣 — module.exports.register(app, cron)

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/var/data') ? '/var/data' : '/tmp/data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const TOUCH_FILE = path.join(DATA_DIR, 'personal-edm.jsonl');
const SUPPRESS_FILE = path.join(DATA_DIR, 'personal-edm-suppress.json');
const CACHE_FILE = path.join(DATA_DIR, 'personal-edm-cache.json');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';

const MAX_CANDIDATES_PER_DAY = 25;
const SUPPRESS_DAYS = 14;       // 14 天內已寄過 → 短期壓制
const MAX_TOUCHES_PER_90D = 3;  // 90 天內最多 3 次

// =========== JSONL helpers ===========
function loadTouches() {
  try {
    if (!fs.existsSync(TOUCH_FILE)) return [];
    return fs.readFileSync(TOUCH_FILE, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function saveTouches(all) {
  try { fs.writeFileSync(TOUCH_FILE, all.map(t => JSON.stringify(t)).join('\n') + (all.length ? '\n' : '')); } catch {}
}
function appendTouch(rec) {
  try { fs.appendFileSync(TOUCH_FILE, JSON.stringify(rec) + '\n'); } catch {}
  return rec;
}
function updateTouch(id, patch) {
  const all = loadTouches();
  const idx = all.findIndex(t => t.id === id);
  if (idx < 0) return false;
  all[idx] = Object.assign({}, all[idx], patch, { ts_updated: new Date().toISOString() });
  saveTouches(all);
  return all[idx];
}
function loadSuppress() {
  try { return JSON.parse(fs.readFileSync(SUPPRESS_FILE, 'utf8')); } catch { return { permanent: [] }; }
}
function saveSuppress(s) { try { fs.writeFileSync(SUPPRESS_FILE, JSON.stringify(s, null, 2)); } catch {} }

// =========== 拉 Shopline 客戶 ===========
async function fetchShoplineCustomers(origin) {
  const base = origin || ('http://localhost:' + (process.env.PORT || 3000));
  const endpoints = [
    '/api/shopline/customers-ltv?limit=300',
    '/api/shopline/customers?limit=300',
  ];
  for (const ep of endpoints) {
    try {
      const r = await fetch(base + ep);
      if (!r.ok) continue;
      const d = await r.json();
      if (d.ok && Array.isArray(d.customers) && d.customers.length) return d.customers;
      if (Array.isArray(d.items) && d.items.length) return d.items;
    } catch {}
  }
  return [];
}

// =========== RFM 分群 ===========
function daysBetween(iso) {
  if (!iso) return 9999;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return 9999;
  return Math.floor((Date.now() - t) / 86400000);
}
function segment(c) {
  const ltv = Number(c.ltv_total || c.ltv || c.total_spent || 0);
  const recency = c.recency_days != null ? Number(c.recency_days) : daysBetween(c.last_order_at || c.last_order_date);
  const orderCount = Number(c.order_count || c.orders_count || 0);
  const firstOrderDays = c.first_order_at ? daysBetween(c.first_order_at) : null;

  // 🌟 VIP 接近回購週期(高優先)
  if (ltv >= 10000 && recency >= 25 && recency <= 35) return { tier: 'vip_due', priority: 'high', reason: 'VIP 接近回購週期' };
  // 🌟 VIP 該回頭(高優先,放寬)
  if (ltv >= 10000 && recency >= 25 && recency <= 50) return { tier: 'vip', priority: 'high', reason: 'VIP 該回頭' };
  // 💛 舊客快流失(中優先)
  if (ltv >= 3000 && recency >= 60 && recency <= 90) return { tier: 'old_fading', priority: 'medium', reason: '舊客快流失' };
  // 🆕 新客追蹤(低優先)
  if (orderCount === 1 && firstOrderDays != null && firstOrderDays <= 14 && firstOrderDays >= 3) return { tier: 'new_followup', priority: 'low', reason: '新客追蹤' };
  return null;
}

// =========== 壓制判斷 ===========
function customerKey(c) {
  return c.id || c.customer_id || c.email || c.phone || ('unknown_' + (c.name || ''));
}
function shouldSuppress(c, allTouches, suppress) {
  const cid = customerKey(c);
  if (suppress.permanent && suppress.permanent.includes(cid)) return 'permanent';
  const now = Date.now();
  const touches = allTouches.filter(t => t.customer_id === cid);
  const within14 = touches.filter(t => t.sent_at && (now - new Date(t.sent_at).getTime()) <= SUPPRESS_DAYS * 86400000);
  if (within14.length > 0) return 'recently_sent';
  const within90 = touches.filter(t => t.sent_at && (now - new Date(t.sent_at).getTime()) <= 90 * 86400000);
  if (within90.length >= MAX_TOUCHES_PER_90D) return 'too_many_recent';
  return null;
}

// =========== NOVA 草稿 ===========
async function generateDraft(customer, seg) {
  const sys = '你是溫點 WarmPlace 的品牌經理 NOVA。為下面這位客戶寫一段「個人化 SaleSmartly DM 訊息」。\n\n' +
'規則:\n' +
'1. 80-120 字\n' +
'2. 第一句必須提到「真實具體」的東西(他上次買的、喜歡的口味、過去聊過)\n' +
'3. 溫暖但得體 — 像認真的烘焙師,不勾肩搭背\n' +
'4. 結尾留白(不硬塞「快來買!」)\n' +
'5. 禁用「敬愛」「貴賓」「殿堂級」「絕對」「精心打造」「必買」「限時搶購」「秒殺」「CP值」「親愛的」\n' +
'6. 可以承認限制(「這批比上次少」「巨蛋店還沒開」)— 真實感拉滿\n' +
'7. 用「您」(一對一),不用「你」\n\n' +
'只回訊息正文,不要前綴後綴、不要解釋。';

  const userMsg =
    '客人姓名:' + (customer.name || '(無)') + '\n' +
    'LTV: NT$' + Number(customer.ltv_total || customer.ltv || 0).toLocaleString() + '\n' +
    '訂單數: ' + (customer.order_count || customer.orders_count || 0) + '\n' +
    '最近購買: ' + (customer.last_order_at || customer.last_order_date || '未知') + ' (' + (customer.recency_days || '?') + ' 天前)\n' +
    (customer.last_items ? '上次買: ' + customer.last_items + '\n' : '') +
    '分群: ' + seg.tier + ' — ' + seg.reason + '\n\n' +
    '請為他寫一段個人化訊息。';

  try {
    const r = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: sys,
      messages: [{ role: 'user', content: userMsg }]
    });
    return (r.content || []).map(c => c.text || '').join('').trim();
  } catch (e) {
    console.error('[personal-edm] NOVA err:', e.message);
    return null;
  }
}

// =========== 生成今日候選 ===========
async function generateCandidates(origin) {
  const customers = await fetchShoplineCustomers(origin);
  if (!customers.length) return { ok: false, error: 'no Shopline customers' };

  const allTouches = loadTouches();
  const suppress = loadSuppress();

  const eligible = [];
  for (const c of customers) {
    const seg = segment(c);
    if (!seg) continue;
    const sup = shouldSuppress(c, allTouches, suppress);
    if (sup) continue;
    eligible.push({ customer: c, segment: seg });
  }
  const priOrder = { high: 0, medium: 1, low: 2 };
  eligible.sort((a, b) => {
    const p = priOrder[a.segment.priority] - priOrder[b.segment.priority];
    if (p !== 0) return p;
    return (Number(b.customer.ltv_total || b.customer.ltv) || 0) - (Number(a.customer.ltv_total || a.customer.ltv) || 0);
  });
  const top = eligible.slice(0, MAX_CANDIDATES_PER_DAY);

  const enriched = [];
  for (const cand of top) {
    const draft = await generateDraft(cand.customer, cand.segment);
    const rec = {
      id: 'touch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      customer_id: customerKey(cand.customer),
      customer_name: cand.customer.name || '',
      customer_email: cand.customer.email || '',
      customer_phone: cand.customer.phone || '',
      ltv: Number(cand.customer.ltv_total || cand.customer.ltv || 0),
      order_count: Number(cand.customer.order_count || cand.customer.orders_count || 0),
      recency_days: Number(cand.customer.recency_days || daysBetween(cand.customer.last_order_at)),
      last_order_at: cand.customer.last_order_at || cand.customer.last_order_date || '',
      segment: cand.segment.tier,
      priority: cand.segment.priority,
      reason: cand.segment.reason,
      draft: draft || '(NOVA 草稿生成失敗,請手寫)',
      status: 'pending',
      generated_at: new Date().toISOString()
    };
    appendTouch(rec);
    enriched.push(rec);
  }

  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ generated_at: new Date().toISOString(), items: enriched }, null, 2)); } catch {}

  return {
    ok: true,
    count: enriched.length,
    by_priority: {
      high: enriched.filter(x => x.priority === 'high').length,
      medium: enriched.filter(x => x.priority === 'medium').length,
      low: enriched.filter(x => x.priority === 'low').length
    },
    items: enriched
  };
}

// =========== SaleSmartly 發送 ===========
async function sendViaSaleSmartly(customer_id, text, contact) {
  const token = process.env.SALESMARTLY_TOKEN || process.env.SALESMARTLY_API_KEY;
  if (!token) return { ok: false, error: 'no SaleSmartly token' };
  // 預留:實際 endpoint 由 closer.js / salesmartly.js 提供
  // 這裡先 dryrun,真正串接在 Phase B 加
  return { ok: true, dryrun: true, contact: contact || customer_id, sent_text: text.slice(0, 50) + '...' };
}

// =========== Telegram 推早報 ===========
async function notifyTelegram(items) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, reason: 'no telegram env' };
  const by = { high: [], medium: [], low: [] };
  items.forEach(i => by[i.priority].push(i));
  const lines = ['💌 今日個人化觸及 · ' + new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })];
  lines.push('──────────────');
  lines.push('總候選: ' + items.length + ' 位');
  if (by.high.length) lines.push('🌟 高優先: ' + by.high.length + ' 位 VIP');
  if (by.medium.length) lines.push('💛 中優先: ' + by.medium.length + ' 位舊客');
  if (by.low.length) lines.push('🆕 新客追蹤: ' + by.low.length + ' 位');
  lines.push('');
  lines.push('👉 https://macaron-office.onrender.com/personal-edm.html');
  try {
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: lines.join('\n') })
    });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// =========== ROI 統計 ===========
function calculateStats() {
  const touches = loadTouches();
  const day = 86400000;
  function range(days) {
    const cutoff = Date.now() - days * day;
    const items = touches.filter(t => t.sent_at && new Date(t.sent_at).getTime() >= cutoff);
    const sent = items.length;
    const replied = items.filter(t => t.replied_at).length;
    const ordered = items.filter(t => t.resulted_in_order).length;
    const revenue = items.reduce((s, t) => s + (Number(t.attributed_revenue) || 0), 0);
    return { sent, replied, ordered, revenue, conversion_pct: sent > 0 ? Math.round(ordered / sent * 1000) / 10 : 0 };
  }
  return { ok: true, last_7d: range(7), last_14d: range(14), last_30d: range(30) };
}

// =========== Express endpoints ===========
function register(app, cron) {
  // 今日候選(pending only,從 cache)
  app.get('/api/personal-edm/candidates', (req, res) => {
    try {
      if (!fs.existsSync(CACHE_FILE)) return res.json({ ok: true, count: 0, items: [], note: '尚未生成,先呼 POST /api/personal-edm/refresh' });
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      // 從 touches 拿最新 status
      const all = loadTouches();
      const map = new Map(all.map(t => [t.id, t]));
      const items = (cache.items || []).map(c => map.get(c.id) || c).filter(t => t.status === 'pending' || t.status === 'edited');
      res.json({ ok: true, generated_at: cache.generated_at, count: items.length, items });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 全部 queue(過去 7 天)
  app.get('/api/personal-edm/queue', (req, res) => {
    try {
      const all = loadTouches();
      const recent = all.filter(t => (Date.now() - new Date(t.generated_at).getTime()) <= 7 * 86400000);
      res.json({ ok: true, count: recent.length, items: recent });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 手動重新生成候選
  app.post('/api/personal-edm/refresh', async (req, res) => {
    try {
      const origin = 'http://localhost:' + (process.env.PORT || 3000);
      const r = await generateCandidates(origin);
      res.json(r);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 編輯草稿
  app.put('/api/personal-edm/draft/:id', (req, res) => {
    const draft = req.body && req.body.draft;
    if (!draft) return res.status(400).json({ ok: false, error: 'no draft body' });
    const r = updateTouch(req.params.id, { draft, status: 'edited' });
    res.json({ ok: !!r, item: r });
  });

  // 發送
  app.post('/api/personal-edm/send/:id', async (req, res) => {
    try {
      const all = loadTouches();
      const rec = all.find(t => t.id === req.params.id);
      if (!rec) return res.status(404).json({ ok: false, error: 'not found' });
      if (rec.status === 'sent') return res.json({ ok: false, error: 'already sent', at: rec.sent_at });
      const sendResult = await sendViaSaleSmartly(rec.customer_id, rec.draft, rec.customer_email || rec.customer_phone);
      if (!sendResult.ok) return res.status(500).json({ ok: false, error: sendResult.error });
      const updated = updateTouch(req.params.id, {
        sent_at: new Date().toISOString(),
        status: 'sent',
        send_result: sendResult
      });
      res.json({ ok: true, item: updated, send_result: sendResult });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 略過
  app.post('/api/personal-edm/skip/:id', (req, res) => {
    const r = updateTouch(req.params.id, { skipped_at: new Date().toISOString(), status: 'skipped' });
    res.json({ ok: !!r, item: r });
  });

  // 永久壓制(客人說不要再發)
  app.post('/api/personal-edm/unsubscribe/:customer_id', (req, res) => {
    const s = loadSuppress();
    if (!s.permanent) s.permanent = [];
    if (!s.permanent.includes(req.params.customer_id)) {
      s.permanent.push(req.params.customer_id);
      saveSuppress(s);
    }
    res.json({ ok: true, suppressed: s.permanent.length });
  });

  // 標記回流(client 端 webhook 或手動)
  app.post('/api/personal-edm/mark-result/:id', (req, res) => {
    const { replied, resulted_in_order, attributed_revenue } = req.body || {};
    const patch = {};
    if (replied) patch.replied_at = new Date().toISOString();
    if (resulted_in_order) patch.resulted_in_order = true;
    if (attributed_revenue) patch.attributed_revenue = Number(attributed_revenue);
    const r = updateTouch(req.params.id, patch);
    res.json({ ok: !!r, item: r });
  });

  // ROI 統計
  app.get('/api/personal-edm/stats', (req, res) => {
    try { res.json(calculateStats()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Cron — 早上 7:00 自動生成 + 推 Telegram
  if (cron && typeof cron.schedule === 'function') {
    const tz = process.env.TZ || 'Asia/Taipei';
    cron.schedule('0 7 * * *', async () => {
      try {
        const origin = 'http://localhost:' + (process.env.PORT || 3000);
        const r = await generateCandidates(origin);
        if (r.ok && r.items && r.items.length > 0) {
          await notifyTelegram(r.items);
          console.log('[personal-edm] daily 07:00 — generated', r.count, 'candidates, telegram sent');
        } else {
          console.log('[personal-edm] daily 07:00 —', r.error || 'no candidates');
        }
      } catch (e) { console.error('[personal-edm] cron err:', e.message); }
    }, { timezone: tz });
    // 週日 23:00 推上週 ROI
    cron.schedule('0 23 * * 0', async () => {
      try {
        const s = calculateStats();
        const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
        if (!token || !chat) return;
        const msg = '📊 個人化觸及 ROI(上週 7 天)\n──────────────\n' +
          '寄出: ' + s.last_7d.sent + ' 封\n' +
          '回訊: ' + s.last_7d.replied + ' 位\n' +
          '回流下單: ' + s.last_7d.ordered + ' 筆\n' +
          '營收: NT$' + s.last_7d.revenue.toLocaleString() + '\n' +
          '轉換率: ' + s.last_7d.conversion_pct + '%';
        await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chat, text: msg })
        });
      } catch (e) { console.error('[personal-edm] weekly stats err:', e.message); }
    }, { timezone: tz });
    console.log('[personal-edm] cron registered: 0 7 * * * (daily) + 0 23 * * 0 (weekly ROI)');
  }

  console.log('[personal-edm] registered: candidates/queue/refresh/draft/send/skip/unsubscribe/mark-result/stats');
}

module.exports = {
  register,
  generateCandidates,
  loadTouches,
  calculateStats,
  notifyTelegram,
  sendViaSaleSmartly
};
