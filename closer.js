// ============================================================
// closer.js — HANA 私訊成交客服顧問
// 讀 SaleSmartly 全對話 → 分級 → 寫「成交回覆草稿」(學用戶風格)
// 每天 08:00 自我優化：回顧對話、更新成交 playbook (存 persistent disk)
// 回覆模式：draft(現階段) / semi(按確認才發) / full(全自動) — 可切換
// 掛載：app.use('/api/closer', require('./closer'));  cron：require('./closer').registerCron(cron)
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch {}
const sm = (() => { try { return require('./salesmartly'); } catch { return null; } })();
const _scout = (() => { try { return require('./scout'); } catch { return null; } })();
function scoutTail() {
  try {
    const i = _scout && _scout.getMarketIntelligence && _scout.getMarketIntelligence();
    if (!i) return '';
    const wf = typeof i.weekly_focus === 'string' ? i.weekly_focus : JSON.stringify(i.weekly_focus || '');
    const acts = (i.action_items || []).slice(0, 5).map((a, n) => (n + 1) + '. ' + (a.title || a)).join('\n');
    return '\n\n=== SCOUT 全球市場調查 + 行動建議 (所有內容請優先參考這裡的市場洞察) ===\n本週重點：' + String(wf).slice(0, 320) + '\n行動建議：\n' + acts + '\n=== SCOUT 結束 ===';
  } catch { return ''; }
}


const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'closer-settings.json');
const PLAYBOOK_FILE = path.join(DATA_DIR, 'closer-playbook.json');
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

let client = null;
function getClient() {
  if (client) return client;
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try { client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); } catch { client = null; }
  return client;
}

function ensureDir() { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }
function loadJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function saveJSON(file, obj) { ensureDir(); try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); return true; } catch { return false; } }

// ── 回覆模式設定 (draft / semi / full) ──
function getSettings() { return loadJSON(SETTINGS_FILE, { mode: 'draft', updated_at: null }); }
function setSettings(s) { s.updated_at = new Date().toISOString(); saveJSON(SETTINGS_FILE, s); return s; }

// ── 成交 playbook (學來的風格 + 有效成交策略) ──
function getPlaybook() {
  return loadJSON(PLAYBOOK_FILE, {
    style_notes: '(尚未學習。預設：韓系精品、溫柔有禮、不逼迫、不報 CP 值。)',
    winning_tactics: [],
    common_objections: [],
    learned_at: null,
    based_on_msgs: 0,
  });
}

// ── 關鍵字分級 ──
const SIGNAL = {
  buy:      /價錢|多少錢|價格|報價|怎麼訂|怎麼買|可以買|要訂|下單|匯款|轉帳|付款|現貨|有貨|數量|幾盒/,
  pickup:   /取貨|自取|宅配|寄送|配送|運費|門市|到貨|什麼時候/,
  objection:/太貴|好貴|有點貴|便宜|折扣|優惠|比較|考慮|過敏|麩質|蛋奶|保存|期限|放多久|可以放/,
  wedding:  /喜餅|婚禮|新人|結婚|小物|迎賓/,
  corp:     /企業|公司|採購|大量|批發|團購|發票|統編/,
};

// ── 只看溫點 macaron 的頻道：FB 溫點(page id) + IG @warmplace.here ──
const MACARON_FB_PAGE_ID = '903707566167263';
function isMacaronChannel(s) {
  const ch = Number(s.channel);
  const cid = String(s.channel_id);
  if (ch === 1 && cid === MACARON_FB_PAGE_ID) return true; // FB 溫點
  if (ch === 6) return true;  // Instagram (溫點 IG @warmplace.here)
  return false;
}

// 分類一通對話 → status + reason
function classify(messages) {
  const msgs = (messages || []).filter(m => m.text);
  if (!msgs.length) return null;
  const last = msgs[msgs.length - 1];
  const lastFromCustomer = !!last.from_customer;
  // 取近期客人訊息文字
  const custText = msgs.filter(m => m.from_customer).slice(-6).map(m => m.text).join(' ');
  const hasBuy = SIGNAL.buy.test(custText) || SIGNAL.pickup.test(custText);
  const hasObj = SIGNAL.objection.test(custText);
  const isWedding = SIGNAL.wedding.test(custText);
  const isCorp = SIGNAL.corp.test(custText);

  let status, reason, priority;
  if (lastFromCustomer && hasBuy) {
    status = 'hot'; reason = '客人問了價格/訂購/取貨 — 臨門一腳就能成交'; priority = 1;
  } else if (lastFromCustomer && hasObj) {
    status = 'objection'; reason = '客人有疑慮(嫌貴/比較/過敏/保存) — 需要對症破解'; priority = 2;
  } else if (lastFromCustomer) {
    status = 'stalled'; reason = '客人最後發言、我們還沒回 — 別讓詢問冷掉'; priority = 2;
  } else {
    status = 'waiting'; reason = '我們已回、等客人回應 — 可主動追一句'; priority = 3;
  }
  const tags = [];
  if (isWedding) tags.push('婚禮喜餅');
  if (isCorp) tags.push('企業/團購');
  if (hasBuy) tags.push('購買訊號');
  if (hasObj) tags.push('有疑慮');
  return { status, reason, priority, lastFromCustomer, tags, msg_count: msgs.length };
}

const STATUS_LABEL = { hot: '🔥 快成交', objection: '💔 有疑慮', stalled: '⏳ 晾著沒回', waiting: '🕗 等客人' };

// ── 讀對話清單 + 分級 (看板用，快速，不呼叫 Claude) ──
async function buildBoard({ days = 14, limit = 30 } = {}) {
  if (!sm || !sm.listRecentConversations) throw new Error('salesmartly 未載入');
  const conv = await sm.listRecentConversations({ days, page_size: 200 });
  const list = (conv && (conv.list || (conv.data && conv.data.list))) || [];
  const macaronList = list.filter(isMacaronChannel);
  const sliced = macaronList.slice(0, limit);
  const out = [];
  for (const s of sliced) {
    const uid = s.chat_user_id || s.contact_id || s.user_id || s.session_id || s.id;
    if (!uid) continue;
    let messages = [];
    try { messages = await sm.listMessagesNormalized(uid, { page_size: 30 }); } catch {}
    const cls = classify(messages);
    if (!cls) continue;
    // 真名優先用 session.title (SaleSmartly 把 FB/IG/LINE 顯示名放這欄位)
    // 4 個 get-visitor-info 端點實測全 404,已停用 fallback
    // 只放需要處理的 (hot/objection/stalled)；waiting 收進但排後面
    out.push({
      chat_user_id: uid,
      name: s.title || s.nickname || s.name || s.contact_name || s.user_name || s.visitor_name || s.customer_nickname || ('客人 ' + String(uid).slice(0, 6)),
      channel: s.channel || s.source || s.platform || '',
      last_at: s.last_message_time || s.start_time || null,
      status: cls.status,
      status_label: STATUS_LABEL[cls.status] || cls.status,
      reason: cls.reason,
      priority: cls.priority,
      tags: cls.tags,
      last_text: (messages[messages.length - 1] || {}).text ? (messages[messages.length - 1].text.slice(0, 60)) : '',
    });
  }
  out.sort((a, b) => a.priority - b.priority);
  const counts = { hot: 0, objection: 0, stalled: 0, waiting: 0 };
  out.forEach(o => { counts[o.status] = (counts[o.status] || 0) + 1; });
  return { ok: true, total: out.length, counts, conversations: out };
}

// ── HANA 人設 prompt ──
function hanaPrompt(playbook) {
  return `你是 HANA — 溫點 WarmPlace 的 AI 私訊成交客服顧問。
你不是「客服機器人」，你是把「冷掉的詢問」變成「結單」的成交高手，同時保有韓系精品品牌的溫柔得體。
品牌：精品馬卡龍 + 費南雪韓系禮贈。禮盒 NT$480–2,280，主力 6 入 NT$880 / 12 入 NT$1,580。
四家門店：台南本店、新光西門 B2、新光中港 B2、新光南西 B2。

【你的成交信念】
1. 每一通的目標是「推進到下一步」：問價→給價並引導下單；猶豫→消除疑慮給台階；已熱→直接給訂購方式臨門一腳。
2. 不逼迫、不轟炸、不報「CP值/限時搶購/秒殺」。用從容、有溫度、給選擇的語氣。
3. 報價要明確、附上「怎麼下一步」(下單連結/到店/私訊確認)，不要只回價格就句點。
4. 疑慮要對症：嫌貴→講價值與場景不講折扣；過敏/保存→給專業具體答案；比較→講溫點獨有的雙主力與韓系定位。

【你學到的「老闆風格 + 有效成交策略」(請務必模仿這個語氣)】
${JSON.stringify(playbook, null, 1).slice(0, 2500)}

【輸出格式 (HTML 片段)】
<div><strong>🎯 成交判斷：</strong>[這通現在卡在哪、下一步要把他推到哪]</div>
<div><strong>💬 建議回覆草稿：</strong></div>
<blockquote>[可直接複製貼上給客人的話，繁體中文，韓系溫柔語氣，明確且有下一步]</blockquote>
<div><strong>🧠 為什麼這樣回：</strong>[一句話策略說明 + 若客人接著問什麼可以怎麼接]</div>

【禁止】罐頭語氣、報 CP 值/限時搶購、只回價格不給下一步、過度熱情驚嘆號。`;
}

// ── 為單一對話寫成交草稿 ──
async function draftFor(chat_user_id) {
  const c = getClient();
  if (!c) throw new Error('ANTHROPIC_API_KEY 未設');
  if (!sm) throw new Error('salesmartly 未載入');
  const messages = await sm.listMessagesNormalized(chat_user_id, { page_size: 40 });
  if (!messages || !messages.length) throw new Error('這通對話沒有訊息');
  const playbook = getPlaybook();
  const convoText = messages.slice(-20).map(m => (m.from_customer ? '客人' : '我們') + '：' + m.text).join('\n');
  const r = await c.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: hanaPrompt(playbook),
    messages: [{ role: 'user', content: '以下是一通真實客人對話，請你以成交為目標，寫一則「我們」該回的成交草稿：\n\n' + convoText + scoutTail() }],
  });
  const html = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  try { const H = require('./history'); H.record({ fn:'HANA', title: '私訊草稿 · ' + chat_user_id.slice(-8), html: '<pre style="white-space:pre-wrap">'+String(html).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))+'</pre>', text: String(html).slice(0,2000), meta:{ chat_user_id } }); } catch(e) { console.error('[history hana]', e.message); }
  return { ok: true, chat_user_id, html, mode: getSettings().mode };
}

// ── 每天 08:00 自我優化：學自家風格 + 全網成交策略 + 融合產 playbook ──
async function webSearchClosingTactics(c) {
  // 用 Anthropic 原生 web_search 抓全網私訊漏斗/DM 成交最佳實踐
  try {
    const r = await c.messages.create({
      model: MODEL, max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
      messages: [{
        role: 'user',
        content: '請用 web_search 調查【精品禮贈品牌的 IG/FB DM 私訊漏斗成交策略】, 主要研究：\n'
          + '1. 精品甜點/烘焙/禮盒類品牌 (尤其韓系/法式) 的 DM 成交常見話術\n'
          + '2. 高轉換的 DM 開場句、嫌貴破解、企業送禮接單模板\n'
          + '3. 2026 年最新 IG/Meta DM 成交漏斗最佳實踐\n'
          + '4. 台灣消費者偏好的私訊溝通風格 (PingFang 客服風)\n\n'
          + '用繁體中文回 JSON (只回 JSON, 不要 markdown):\n'
          + '{\n  "industry_best_practices": ["全網觀察到的 5-8 條私訊成交黃金法則"],\n'
          + '  "winning_opening_lines": ["3-5 個高轉換 DM 開場句範例 (中文)"],\n'
          + '  "objection_breakers": ["3-5 個嫌貴/猶豫破解話術"],\n'
          + '  "brand_fit_advice": "針對精品馬卡龍+費南雪品牌, 該選哪種風格 (溫度 vs 專業 vs 顧問式)"\n}'
      }]
    });
    let text = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
    try { return JSON.parse(text); } catch { return { industry_best_practices: [text.slice(0, 500)], winning_opening_lines: [], objection_breakers: [], brand_fit_advice: '' }; }
  } catch (e) { console.warn('[closer] web search insights failed:', e.message); return null; }
}

async function selfOptimize({ days = 3, sample = 25 } = {}) {
  const c = getClient();
  if (!c) return { ok: false, error: 'no api key' };
  if (!sm || !sm.listRecentConversations) return { ok: false, error: 'salesmartly missing' };
  const conv = await sm.listRecentConversations({ days, page_size: 200 });
  const list = (conv && (conv.list || (conv.data && conv.data.list))) || [];
  const ourMsgs = []; const custMsgs = [];
  for (const s of list.filter(isMacaronChannel).slice(0, sample)) {
    const uid = s.chat_user_id || s.contact_id || s.user_id || s.session_id || s.id;
    if (!uid) continue;
    let msgs = [];
    try { msgs = await sm.listMessagesNormalized(uid, { page_size: 30 }); } catch {}
    msgs.forEach(m => { if (!m.text) return; (m.from_customer ? custMsgs : ourMsgs).push(m.text.slice(0, 200)); });
  }
  // 即使沒對話也跑全網調查 (給品牌風格建議)
  console.log('[closer] step 1/2: webSearchClosingTactics...');
  const webInsights = await webSearchClosingTactics(c);
  console.log('[closer] step 2/2: combine + playbook...');

  // 融合 prompt: 自家對話 + 全網調查 → 量身訂做的 playbook
  let prompt = '你是 HANA 的自我優化引擎。融合 [自家對話樣本] + [全網成交策略] 產出最適合溫點 WarmPlace (精品馬卡龍+費南雪) 的成交 playbook。\n\n'
    + '請用 JSON 回覆 (只回 JSON, 不要 markdown):\n'
    + '{\n'
    + '  "style_notes": "綜合風格描述 — 結合自家既有口吻 + 全網最佳實踐, 寫出 HANA 該如何回客戶 (具體可模仿)",\n'
    + '  "winning_tactics": ["最適合溫點品牌的成交技巧 5-7 條 (融合自家 + 全網)"],\n'
    + '  "common_objections": ["客人常見疑慮 + 破解方向 4-6 條"],\n'
    + '  "opening_templates": ["3-5 個主動 DM 開場句模板 (用溫點品牌語氣)"],\n'
    + '  "industry_summary": "全網調查到的精品禮贈 DM 成交趨勢一句話"\n'
    + '}\n\n';
  if (ourMsgs.length || custMsgs.length) {
    prompt += '=== 自家對話 — 我們(店家)的回覆樣本 ===\n' + ourMsgs.slice(0, 60).join('\n')
      + '\n\n=== 自家對話 — 客人訊息樣本 ===\n' + custMsgs.slice(0, 60).join('\n');
  } else {
    prompt += '=== 自家對話 ===\n(過去 ' + days + ' 天無對話樣本, 請主要依全網調查推薦最佳風格)';
  }
  if (webInsights) {
    prompt += '\n\n=== 全網調查 — 私訊漏斗最佳實踐 ===\n' + JSON.stringify(webInsights, null, 2);
  }

  const r = await c.messages.create({ model: MODEL, max_tokens: 2500, messages: [{ role: 'user', content: prompt }] });
  let text = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { style_notes: text.slice(0, 1500), winning_tactics: [], common_objections: [], opening_templates: [], industry_summary: '' }; }
  parsed.learned_at = new Date().toISOString();
  parsed.based_on_msgs = ourMsgs.length + custMsgs.length;
  parsed.industry_insights = webInsights;  // 保留全網調查原始結果
  saveJSON(PLAYBOOK_FILE, parsed);
  return { ok: true, learned_at: parsed.learned_at, based_on_msgs: parsed.based_on_msgs, web_search_used: !!webInsights };
}

// ───────────────────────── Routes ─────────────────────────
router.get('/board', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 14, 1), 90);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 5), 60);
    res.json(await buildBoard({ days, limit }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/draft', express.json(), async (req, res) => {
  try {
    const id = req.body && req.body.chat_user_id;
    if (!id) return res.status(400).json({ ok: false, error: 'chat_user_id required' });
    res.json(await draftFor(id));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/settings', (req, res) => res.json({ ok: true, ...getSettings() }));
router.post('/settings', express.json(), (req, res) => {
  const mode = req.body && req.body.mode;
  if (!['draft', 'semi', 'full'].includes(mode)) return res.status(400).json({ ok: false, error: 'mode 必須是 draft/semi/full' });
  // 安全：semi/full 的「實際送出」功能尚未啟用，僅保存偏好設定
  res.json({ ok: true, ...setSettings({ mode }), note: mode === 'draft' ? '草稿模式' : (mode + ' 模式已記錄，但實際自動發送功能尚未啟用(需後續開通)') });
});

// 發送：把訊息送回給客人 (透過 SaleSmartly → 落回 FB/IG 對話)
async function sendMessage(chat_user_id, text) {
  if (!sm || !sm.apiCall) throw new Error('salesmartly apiCall 不可用');
  const params = { chat_user_id, message_type: 'text', msg_type: 'text', content: text, text: text };
  return sm.apiCall('/api/v2/send-message', params, 'POST');
}
const SENTLOG_FILE = path.join(DATA_DIR, 'closer-sent.json');
function logSent(rec) {
  const log = loadJSON(SENTLOG_FILE, { sent: [] });
  log.sent.unshift({ ...rec, at: new Date().toISOString() });
  if (log.sent.length > 500) log.sent = log.sent.slice(0, 500);
  saveJSON(SENTLOG_FILE, log);
}
router.post('/send', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const chat_user_id = body.chat_user_id, text = body.text;
    if (!chat_user_id || !text || !String(text).trim()) return res.status(400).json({ ok: false, error: 'chat_user_id 與 text 必填' });
    const mode = getSettings().mode;
    if (mode === 'draft') return res.status(403).json({ ok: false, error: '目前是草稿模式未開放發送。請先切到半自動再按確認發送。' });
    const r = await sendMessage(chat_user_id, String(text).trim());
    logSent({ chat_user_id, text: String(text).trim().slice(0, 300), mode, ok: true });
    res.json({ ok: true, sent: true, mode, sales_response: r });
  } catch (e) {
    try { logSent({ chat_user_id: (req.body || {}).chat_user_id, ok: false, error: e.message }); } catch (e2) {}
    res.status(500).json({ ok: false, error: e.message });
  }
});
router.get('/send-probe', async (req, res) => {
  const candidates = [
    '/api/v2/send-message', '/api/v2/send-text-message', '/api/v2/send-text',
    '/api/v2/message-send', '/api/v2/send-msg', '/api/v2/send', '/api/v2/reply',
    '/api/v2/create-message', '/api/v2/send-customer-message', '/api/v2/messages/send',
    '/api/v2/send-conversation-message', '/api/v2/conversation/send'
  ];
  const results = [];
  for (const ep of candidates) {
    try {
      await sm.apiCall(ep, { chat_user_id: '__probe_invalid__', message_type: 'text', content: '', text: '' }, 'POST');
      results.push({ ep, status: 'NO_ERROR(端點存在)' });
    } catch (e) {
      const msg = e.message || '';
      const is404 = /404|not found/i.test(msg);
      results.push({ ep, status: is404 ? '404(不存在)' : 'EXISTS?(' + msg.slice(0, 80) + ')' });
    }
  }
  res.json({ ok: true, note: '非404者代表端點存在', results });
});
router.get('/sent', (req, res) => res.json({ ok: true, ...loadJSON(SENTLOG_FILE, { sent: [] }) }));
router.get('/channels', async (req, res) => {
  try {
    if (!sm || !sm.listRecentConversations) throw new Error('salesmartly 未載入');
    const conv = await sm.listRecentConversations({ days: 60, page_size: 200 });
    const list = (conv && (conv.list || (conv.data && conv.data.list))) || [];
    const combo = {};
    list.forEach(s => {
      const k = 'channel' + s.channel + '_id' + s.channel_id;
      if (!combo[k]) combo[k] = { channel: s.channel, channel_id: s.channel_id, count: 0, sample_title: s.title, is_macaron: isMacaronChannel(s) };
      combo[k].count++;
    });
    res.json({ ok: true, total_sessions: list.length, channels: Object.values(combo) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/playbook', (req, res) => res.json({ ok: true, ...getPlaybook() }));
router.post('/optimize', async (req, res) => {
  try { res.json(await selfOptimize({ days: 3 })); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Debug：查 SaleSmartly raw response 看名字到底在哪 ──
router.get('/_debug_visitor', async (req, res) => {
  try {
    if (!sm || !sm.apiCall) throw new Error('salesmartly 未載入');
    const PROJECT_ID = process.env.SALESMARTLY_PROJECT_ID || '';
    let uid = req.query.uid || '';
    // 若沒指定 uid，從 board 抓第一個
    let sessionRaw = null;
    if (!uid) {
      const conv = await sm.listRecentConversations({ days: 14, page_size: 100 });
      const list = (conv && (conv.list || (conv.data && conv.data.list))) || [];
      const macaron = list.filter(isMacaronChannel);
      sessionRaw = macaron[0] || null;
      uid = sessionRaw && (sessionRaw.chat_user_id || sessionRaw.contact_id || sessionRaw.user_id || sessionRaw.session_id);
    } else {
      // 找對應 session
      try {
        const conv = await sm.listRecentConversations({ days: 30, page_size: 200 });
        const list = (conv && (conv.list || (conv.data && conv.data.list))) || [];
        sessionRaw = list.find(s => (s.chat_user_id || s.contact_id || s.user_id || s.session_id) === uid) || null;
      } catch {}
    }
    if (!uid) return res.status(400).json({ ok: false, error: '無 uid 可用' });

    // 1. session 原始所有欄位
    const session_all_keys = sessionRaw ? Object.keys(sessionRaw) : [];
    const session_name_like_fields = {};
    if (sessionRaw) {
      Object.keys(sessionRaw).forEach(k => {
        if (/name|nick|user|contact|visitor|customer|title/i.test(k)) {
          session_name_like_fields[k] = sessionRaw[k];
        }
      });
    }

    // 2. listMessages 原始 raw（前 3 則）
    let messages_raw = null;
    let messages_msg_keys = [];
    let messages_sender_fields = [];
    try {
      const r = await sm.listMessages(uid, { page_size: 30 });
      const ms = (r.data && r.data.list) || r.list || [];
      messages_raw = ms.slice(0, 3);
      if (ms[0]) messages_msg_keys = Object.keys(ms[0]);
      ms.forEach(m => {
        Object.keys(m).forEach(k => {
          if (/name|nick|sender|from|user/i.test(k) && m[k] && !messages_sender_fields.find(f => f.field === k)) {
            messages_sender_fields.push({ field: k, sample_value: String(m[k]).slice(0, 80) });
          }
        });
      });
    } catch (e) { messages_raw = { error: e.message }; }

    // 3. 4 個 visitor-info 端點各自結果
    const visitor_endpoints = [
      '/api/v2/get-visitor-info',
      '/api/v2/get-contact-info',
      '/api/v2/get-user-info',
      '/api/v2/get-chat-user-info',
    ];
    const visitor_probe = [];
    for (const ep of visitor_endpoints) {
      const row = { endpoint: ep };
      try {
        const r = await sm.apiCall(ep, { chat_user_id: uid, project_id: PROJECT_ID }, 'POST');
        row.ok = true;
        row.code = r && r.code;
        row.has_data = !!(r && r.data);
        row.data = r && r.data;
        row.raw_keys = r ? Object.keys(r) : [];
      } catch (e) {
        row.ok = false;
        row.error = String(e.message || e).slice(0, 200);
      }
      visitor_probe.push(row);
    }

    // 4. cache 內容
    let cache_entry = null;
    try {
      if (sm.getVisitorInfo) {
        cache_entry = await sm.getVisitorInfo(uid);
      }
    } catch (e) { cache_entry = { error: e.message }; }

    res.json({
      ok: true,
      uid,
      project_id_set: !!PROJECT_ID,
      session: { all_keys: session_all_keys, name_like_fields: session_name_like_fields, raw_full: sessionRaw },
      messages: { sample_first_3_raw: messages_raw, all_message_keys: messages_msg_keys, found_name_like_fields_with_values: messages_sender_fields },
      visitor_info_endpoints: visitor_probe,
      cache_entry,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function registerCron(cron) {
  if (!cron || typeof cron.schedule !== 'function') return;
  const tz = process.env.TZ || 'Asia/Taipei';
  // 每天 08:00 自我優化
  cron.schedule('0 8 * * *', async () => {
    console.log('[closer] HANA 08:00 self-optimize starting...');
    try { const r = await selfOptimize({ days: 3 }); console.log('[closer] self-optimize:', JSON.stringify(r)); }
    catch (e) { console.error('[closer] self-optimize failed:', e.message); }
  }, { timezone: tz });
  console.log('[closer] HANA cron registered (daily 08:00 self-optimize)');
}

module.exports = router;
module.exports.registerCron = registerCron;
module.exports.selfOptimize = selfOptimize;
module.exports.buildBoard = buildBoard;
