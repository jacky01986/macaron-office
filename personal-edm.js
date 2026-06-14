// personal-edm.js — 個人化觸及系統(完整版 v2 — SaleSmartly 源)
// 從 SaleSmartly 對話(closer.js board)拉客戶,priority/status 分群,NOVA 寫個人化訊息,
// 透過 closer.js /send 真實寄回 FB/IG。
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
const SUPPRESS_DAYS = 14;
const MAX_TOUCHES_PER_90D = 3;

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

// =========== 拉 SaleSmartly 對話(從 closer.js board) ===========
async function fetchCloserBoard(origin) {
  const base = origin || ('http://localhost:' + (process.env.PORT || 3000));
  try {
    const r = await fetch(base + '/api/closer/board');
    if (!r.ok) return [];
    const d = await r.json();
    return d.conversations || [];
  } catch (e) {
    console.error('[personal-edm] closer board err:', e.message);
    return [];
  }
}

// 拉某客人完整對話歷史(給 NOVA 寫個人化用)
async function fetchConversationHistory(origin, chat_user_id) {
  const base = origin || ('http://localhost:' + (process.env.PORT || 3000));
  try {
    const r = await fetch(base + '/api/closer/draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_user_id })
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.html || d.context || null;
  } catch { return null; }
}

// =========== 分群(基於 SaleSmartly status / priority / recency) ===========
function recencyFromLastAt(last_at) {
  if (!last_at) return 9999;
  // last_at 是 Unix seconds
  return Math.floor((Date.now() / 1000 - Number(last_at)) / 86400);
}
function segment(c) {
  const recency = recencyFromLastAt(c.last_at);

  // 🌟 高優先 — hot(臨門一腳)
  if (c.status === 'hot') {
    return { tier: 'hot_lead', priority: 'high', reason: '🔥 ' + (c.reason || '臨門一腳').slice(0, 30) };
  }
  // 🌟 高優先 — objection(有疑慮,要解決)
  if (c.status === 'objection') {
    return { tier: 'objection', priority: 'high', reason: '💢 有疑慮要解決' };
  }
  // 💛 中優先 — stalled(卡關),最近 3-60 天
  if (c.status === 'stalled' && recency >= 3 && recency <= 60) {
    return { tier: 'stalled', priority: 'medium', reason: '🌀 卡關需主動' };
  }
  // 💛 中優先 — waiting 14+ 天(快流失)
  if (c.status === 'waiting' && recency >= 14 && recency <= 60) {
    return { tier: 'fading', priority: 'medium', reason: '⏳ 快流失,該追一句' };
  }
  // 🆕 低優先 — waiting 3-14 天(輕度追蹤)
  if (c.status === 'waiting' && recency >= 3 && recency <= 14) {
    return { tier: 'follow_up', priority: 'low', reason: '輕度追蹤' };
  }
  return null;
}

// =========== 壓制判斷 ===========
function customerKey(c) {
  return c.chat_user_id || c.id || ('unknown_' + (c.name || ''));
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

// =========== NOVA 草稿(用真實對話歷史) ===========
async function generateDraft(customer, seg, conversationHistory) {
  const sys = '你是溫點 WarmPlace 的品牌經理 NOVA。為下面這位客戶寫一段「個人化 SaleSmartly DM 訊息」。\n\n' +
'規則:\n' +
'1. 80-120 字\n' +
'2. 第一句必須提到他最近聊到的具體內容(看下面對話歷史 — 提產品名/疑問/口味)\n' +
'3. 溫暖但得體 — 像認真的烘焙師,不勾肩搭背\n' +
'4. 結尾留白(不硬塞「快來買!」)\n' +
'5. 禁用「敬愛」「貴賓」「殿堂級」「絕對」「精心打造」「必買」「限時搶購」「秒殺」「CP值」「親愛的」\n' +
'6. 可以承認限制(「這批比上次少」「巨蛋店還沒開」)— 真實感拉滿\n' +
'7. 用「您」(一對一),不用「你」\n' +
'8. 根據分群調整語氣:\n' +
'   - 🔥 hot/objection:直接、解答疑問\n' +
'   - 🌀 stalled/fading:輕推,給選項不施壓\n' +
'   - 新客:溫和歡迎,介紹一個小亮點\n\n' +
'只回訊息正文,不要前綴後綴、不要解釋。';

  const histPart = conversationHistory ? '\n\n=== 過去對話歷史 ===\n' + conversationHistory.slice(0, 2000) : '';

  const userMsg =
    '客人姓名:' + (customer.name || '(無)') + '\n' +
    'SaleSmartly status: ' + (customer.status || 'unknown') + '\n' +
    '最近互動: ' + (customer.last_at ? new Date(customer.last_at * 1000).toLocaleDateString('zh-TW') : '?') + ' (' + recencyFromLastAt(customer.last_at) + ' 天前)\n' +
    '上次說的:' + (customer.last_text || '(無)') + '\n' +
    '分群: ' + seg.tier + ' — ' + seg.reason + '\n' +
    (customer.tags && customer.tags.length ? '標籤: ' + customer.tags.join(', ') + '\n' : '') +
    histPart + '\n\n' +
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
  const conversations = await fetchCloserBoard(origin);
  if (!conversations.length) return { ok: false, error: 'no SaleSmartly conversations' };

  const allTouches = loadTouches();
  const suppress = loadSuppress();

  const eligible = [];
  for (const c of conversations) {
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
    // 同優先:依 SaleSmartly priority 升冪(1 > 2 > 3)
    return (a.customer.priority || 9) - (b.customer.priority || 9);
  });
  const top = eligible.slice(0, MAX_CANDIDATES_PER_DAY);

  const enriched = [];
  for (const cand of top) {
    // 拉對話歷史(可能耗時,失敗 fallback null)
    const history = await fetchConversationHistory(origin, cand.customer.chat_user_id);
    const draft = await generateDraft(cand.customer, cand.segment, history);
    const rec = {
      id: 'touch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      customer_id: customerKey(cand.customer),
      chat_user_id: cand.customer.chat_user_id,
      customer_name: cand.customer.name || '',
      channel: cand.customer.channel || 0,
      last_at: cand.customer.last_at || 0,
      last_text: (cand.customer.last_text || '').slice(0, 200),
      status: cand.customer.status || '',
      ltv: 0,  // SaleSmartly 沒 LTV — 留 0
      order_count: 0,
      recency_days: recencyFromLastAt(cand.customer.last_at),
      segment: cand.segment.tier,
      priority: cand.segment.priority,
      reason: cand.segment.reason,
      tags: cand.customer.tags || [],
      draft: draft || '(NOVA 草稿生成失敗,請手寫)',
      status_label: 'pending',
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

// =========== SaleSmartly 真實寄送(via closer.js) ===========
async function sendViaSaleSmartly(customer_id, text, contact, origin) {
  const base = origin || ('http://localhost:' + (process.env.PORT || 3000));
  try {
    const r = await fetch(base + '/api/closer/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_user_id: customer_id, text })
    });
    const d = await r.json();
    if (d.ok && d.sent) {
      return { ok: true, via: 'salesmartly', mode: d.mode, sales_response: d.sales_response };
    }
    return { ok: false, error: d.error || 'closer rejected', http_status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
  if (by.high.length) lines.push('🔥 高優先: ' + by.high.length + ' 位(hot/objection)');
  if (by.medium.length) lines.push('🌀 中優先: ' + by.medium.length + ' 位(stalled/fading)');
  if (by.low.length) lines.push('🆕 低優先: ' + by.low.length + ' 位(輕度追蹤)');
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
  app.get('/api/personal-edm/candidates', (req, res) => {
    try {
      if (!fs.existsSync(CACHE_FILE)) return res.json({ ok: true, count: 0, items: [], note: '尚未生成,先呼 POST /api/personal-edm/refresh' });
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      const all = loadTouches();
      const map = new Map(all.map(t => [t.id, t]));
      // 用 status_label (避免跟 SaleSmartly status 衝突)
      const items = (cache.items || []).map(c => map.get(c.id) || c).filter(t => t.status_label === 'pending' || t.status_label === 'edited' || t.status === 'pending' || t.status === 'edited');
      res.json({ ok: true, generated_at: cache.generated_at, count: items.length, items });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/personal-edm/queue', (req, res) => {
    try {
      const all = loadTouches();
      const recent = all.filter(t => (Date.now() - new Date(t.generated_at).getTime()) <= 7 * 86400000);
      res.json({ ok: true, count: recent.length, items: recent });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/personal-edm/refresh', async (req, res) => {
    try {
      const origin = 'http://localhost:' + (process.env.PORT || 3000);
      const r = await generateCandidates(origin);
      res.json(r);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.put('/api/personal-edm/draft/:id', (req, res) => {
    const draft = req.body && req.body.draft;
    if (!draft) return res.status(400).json({ ok: false, error: 'no draft body' });
    const r = updateTouch(req.params.id, { draft, status_label: 'edited' });
    res.json({ ok: !!r, item: r });
  });

  app.post('/api/personal-edm/send/:id', async (req, res) => {
    try {
      const all = loadTouches();
      const rec = all.find(t => t.id === req.params.id);
      if (!rec) return res.status(404).json({ ok: false, error: 'not found' });
      if (rec.sent_at) return res.json({ ok: false, error: 'already sent', at: rec.sent_at });
      const origin = 'http://localhost:' + (process.env.PORT || 3000);
      const sendResult = await sendViaSaleSmartly(rec.chat_user_id || rec.customer_id, rec.draft, null, origin);
      if (!sendResult.ok) return res.status(500).json({ ok: false, error: sendResult.error, http_status: sendResult.http_status });
      const updated = updateTouch(req.params.id, {
        sent_at: new Date().toISOString(),
        status_label: 'sent',
        send_result: sendResult
      });
      res.json({ ok: true, item: updated, send_result: sendResult });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/personal-edm/skip/:id', (req, res) => {
    const r = updateTouch(req.params.id, { skipped_at: new Date().toISOString(), status_label: 'skipped' });
    res.json({ ok: !!r, item: r });
  });

  app.post('/api/personal-edm/unsubscribe/:customer_id', (req, res) => {
    const s = loadSuppress();
    if (!s.permanent) s.permanent = [];
    if (!s.permanent.includes(req.params.customer_id)) {
      s.permanent.push(req.params.customer_id);
      saveSuppress(s);
    }
    res.json({ ok: true, suppressed: s.permanent.length });
  });

  app.post('/api/personal-edm/mark-result/:id', (req, res) => {
    const { replied, resulted_in_order, attributed_revenue } = req.body || {};
    const patch = {};
    if (replied) patch.replied_at = new Date().toISOString();
    if (resulted_in_order) patch.resulted_in_order = true;
    if (attributed_revenue) patch.attributed_revenue = Number(attributed_revenue);
    const r = updateTouch(req.params.id, patch);
    res.json({ ok: !!r, item: r });
  });

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

  console.log('[personal-edm v2] registered: SaleSmartly source + closer.js send + 7 endpoints + 2 cron');
}

module.exports = {
  register,
  generateCandidates,
  loadTouches,
  calculateStats,
  notifyTelegram,
  sendViaSaleSmartly
};
