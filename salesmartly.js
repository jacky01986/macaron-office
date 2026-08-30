// salesmartly.js — SaleSmartly API client + customer insight extractor
// env: SALESMARTLY_TOKEN, SALESMARTLY_PROJECT_ID, SALESMARTLY_BASE_URL (optional)
// V2 endpoints based on apifox doc category structure

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.SALESMARTLY_TOKEN || '';
const PROJECT_ID = process.env.SALESMARTLY_PROJECT_ID || '';
const BASE_URL = process.env.SALESMARTLY_BASE_URL || 'https://developer.salesmartly.com';
const CACHE_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(CACHE_DIR, 'salesmartly_conversations.json');

function signParams(params = {}) {
  // SaleSmartly signature: Token + '&' + sorted "key=value" pairs joined with '&', then MD5 (32 lowercase hex)
  // project_id MUST be included in signing params
  const allParams = Object.assign({}, params, { project_id: PROJECT_ID });
  const keys = Object.keys(allParams).sort();
  const pairs = keys.map(k => {
    const v = allParams[k];
    if (v === null || v === undefined) return k + '=';
    if (typeof v === 'object') return k + '=' + JSON.stringify(v);
    return k + '=' + String(v);
  });
  const concat = TOKEN + '&' + pairs.join('&');
  return crypto.createHash('md5').update(concat, 'utf8').digest('hex');
}

async function apiCall(endpoint, params = {}, method = 'POST') {
  if (!TOKEN || !PROJECT_ID) throw new Error('SALESMARTLY env not set');
  const sign = signParams(params);
  const headers = { 'Token': TOKEN, 'project_id': PROJECT_ID, 'external-sign': sign, 'Content-Type': 'application/json' };
  let url = BASE_URL + endpoint, body = null;
  if (method === 'GET') {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += '?' + qs;
  } else { body = JSON.stringify(params); }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error('SS ' + endpoint + ' ' + res.status + ' ' + text.slice(0,200));
  if (json && json.code !== undefined && json.code !== 0) {
    throw new Error('SS ' + endpoint + ' code=' + json.code + ' ' + (json.msg || json.message || ''));
  }
  return json;
}

const CONV_ENDPOINTS = ['/api/v2/get-session-list'];
const MSG_ENDPOINTS = ['/api/v2/get-message-list'];

async function tryEndpoints(endpoints, params, methods = ['GET', 'POST']) {
  const attempts = [];
  for (const ep of endpoints) {
    for (const method of methods) {
      try {
        const r = await apiCall(ep, params, method);
        r._endpoint_used = ep; r._method_used = method;
        return { ok: true, result: r, attempts };
      } catch (e) {
        attempts.push({ endpoint: ep, method, error: e.message.slice(0, 200) });
      }
    }
  }
  return { ok: false, attempts };
}

async function listRecentConversations({ days = 7, page = 1, page_size = 50 } = {}) {
  // SaleSmartly v2 /api/v2/get-session-list:
  // - default returns sessions assigned to the API token user (我的)
  // - to also include 待分配 (unassigned), make a second call with assign_status filter
  const merged = new Map();
  const attempts = [];
  
  // Call 1: default (assigned to token owner)
  try {
    const out = await tryEndpoints(CONV_ENDPOINTS, { page, page_size, project_id: PROJECT_ID });
    if (out.ok && out.result) {
      const list = (out.result.data && out.result.data.list) || out.result.list || [];
      attempts.push({ variant: 'default', count: list.length });
      for (const s of list) {
        const k = s.session_id || s.id;
        if (k && !merged.has(k)) merged.set(k, s);
      }
    }
  } catch (e) { attempts.push({ variant: 'default', error: e.message }); }
  
  // Call 2: include unassigned (assign_status: 0 = 未分配)
  try {
    const out = await tryEndpoints(CONV_ENDPOINTS, { page, page_size, project_id: PROJECT_ID, assign_status: 0 });
    if (out.ok && out.result) {
      const list = (out.result.data && out.result.data.list) || out.result.list || [];
      attempts.push({ variant: 'unassigned', count: list.length });
      for (const s of list) {
        const k = s.session_id || s.id;
        if (k && !merged.has(k)) merged.set(k, s);
      }
    }
  } catch (e) { attempts.push({ variant: 'unassigned', error: e.message }); }
  
  // Call 3: include all-status (status: 1 = 待分配/waiting in some SaleSmartly schemas)
  try {
    const out = await tryEndpoints(CONV_ENDPOINTS, { page, page_size, project_id: PROJECT_ID, status: 1 });
    if (out.ok && out.result) {
      const list = (out.result.data && out.result.data.list) || out.result.list || [];
      attempts.push({ variant: 'status_1', count: list.length });
      for (const s of list) {
        const k = s.session_id || s.id;
        if (k && !merged.has(k)) merged.set(k, s);
      }
    }
  } catch (e) { attempts.push({ variant: 'status_1', error: e.message }); }
  
  if (merged.size === 0) {
    const err = new Error('All conversation endpoints failed');
    err.attempts = attempts; throw err;
  }
  
  let allSessions = Array.from(merged.values());
  // Filter by date — keep only sessions with activity within `days` window
  if (days && days > 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoffSec = nowSec - (days * 86400);
    allSessions = allSessions.filter(s => {
      const t = parseInt(s.last_message_time) || parseInt(s.assign_time) || parseInt(s.start_time) || parseInt(s.end_time) || 0;
      // SaleSmartly times can be in seconds or milliseconds; normalize
      const tSec = t > 1e12 ? Math.floor(t / 1000) : t;
      return tSec >= cutoffSec;
    });
  }
  allSessions.sort((a, b) => parseInt(b.last_message_time || b.start_time || 0) - parseInt(a.last_message_time || a.start_time || 0));
  
  return {
    code: 0, msg: 'success',
    data: { list: allSessions, total: allSessions.length, page, page_size },
    list: allSessions, total: allSessions.length,
    _merged_attempts: attempts
  };
}

async function listMessages(chat_user_id, { page = 1, page_size = 50 } = {}) {
  const params = { chat_user_id, page, page_size, project_id: PROJECT_ID };
  const out = await tryEndpoints(MSG_ENDPOINTS, params);
  if (!out.ok) {
    const err = new Error('All message endpoints failed');
    err.attempts = out.attempts; throw err;
  }
  return out.result;
}

const BUCKETS = {
  'price': { rx: /價錢|多少錢|費用|報價|價格|多錢/, label: '價格' },
  'content': { rx: /禮盒|口味|內容|介紹|限定/, label: '禮盒 / 口味' },
  'order': { rx: /訂購|怎麼買|可以買|想要|要訂/, label: '訂購方式' },
  'pickup': { rx: /取貨|自取|宅配|寄送|配送|門市/, label: '取貨 / 配送' },
  'custom': { rx: /客製|客制|專屬|專門|刻字|印字/, label: '客製化' },
  'wedding': { rx: /喜餅|婚禮|新人|結婚|小物/, label: '婚禮 / 喜餅' },
  'corp': { rx: /企業|公司|送禮|採購|大量|批發|團購/, label: '企業 / 大量' },
  'allergy': { rx: /過敏|麩質|蛋|奶|素食|無糖/, label: '過敏原 / 素食' },
  'expire': { rx: /保存|期限|保鮮|可以放|放多久/, label: '保存期限' },
  'store': { rx: /店面|分店|地點|地址|哪裡|台南|台北|台中/, label: '店面位置' },
};

function extractTopQuestions(messages) {
  const counts = {}, examples = {};
  for (const m of messages) {
    const text = (m.content || m.text || m.message || '').toString();
    if (!text) continue;
    for (const [k, b] of Object.entries(BUCKETS)) {
      if (b.rx.test(text)) {
        counts[k] = (counts[k] || 0) + 1;
        examples[k] = examples[k] || [];
        if (examples[k].length < 3) examples[k].push(text.slice(0, 80));
        break;
      }
    }
  }
  return Object.entries(counts).sort((a,b) => b[1]-a[1]).map(([k,c]) => ({
    topic: BUCKETS[k].label, count: c, samples: examples[k] || []
  }));
}

async function getCustomerInsights({ days = 7 } = {}) {
  if (!TOKEN || !PROJECT_ID) return { ok: false, reason: 'env not set', summary: null };
  try {
    const cl = await listRecentConversations({ days, page_size: 100 });
    const convs = (cl.data && cl.data.list) || cl.data || cl.list || cl.items || [];
    const allMsgs = [];
    for (const conv of convs.slice(0, 20)) {
      const uid = conv.chat_user_id || conv.user_id || conv.contact_id || conv.id;
      if (!uid) continue;
      try {
        const mr = await listMessages(uid, { page_size: 30 });
        const ms = (mr.data && mr.data.list) || mr.data || mr.list || mr.items || [];
        const inb = ms.filter(m => m.sender_type === 1);
        allMsgs.push(...inb);
      } catch {}
    }
    const topics = extractTopQuestions(allMsgs);
    try {
      if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ updated_at: new Date().toISOString(), conversation_count: convs.length, message_count: allMsgs.length, topics, endpoint_used: cl._endpoint_used }, null, 2));
    } catch {}
    return { ok: true, conversation_count: convs.length, message_count: allMsgs.length, topics, summary: formatBriefingSection(topics, convs.length, allMsgs.length, days), endpoint_used: cl._endpoint_used };
  } catch (err) {
    return { ok: false, reason: err.message, attempts: err.attempts || null, summary: null };
  }
}

function formatBriefingSection(topics, convCount, msgCount, days) {
  if (!topics || topics.length === 0) return '客服（過去 ' + days + ' 天）：無對話資料';
  const lines = ['📞 本週客服洞察（過去 ' + days + ' 天，' + convCount + ' 場對話 / ' + msgCount + ' 則客人訊息）'];
  topics.slice(0, 5).forEach((t, i) => { lines.push((i+1) + '. ' + t.topic + '：' + t.count + ' 次'); });
  if (topics[0] && topics[0].count >= 5) {
    lines.push('');
    lines.push('💡 建議：「' + topics[0].topic + '」這週被問 ' + topics[0].count + ' 次 → CAMILLE 寫一篇 FAQ');
  }
  return lines.join('\n');
}

// Debug: probe all endpoint variants
async function probeAll() {
  const probe_params = { page: 1, page_size: 5, project_id: PROJECT_ID };
  const conv = await tryEndpoints(CONV_ENDPOINTS, probe_params);
  let insights = null;
  try {
    insights = await getCustomerInsights({ days: 7 });
  } catch (e) {
    insights = { ok: false, threw: e.message };
  }
  return {
    token_set: !!TOKEN, project_id: PROJECT_ID, base_url: BASE_URL,
    conv_probe: conv,
    insights_result: insights,
  };
}

// 從 SaleSmartly 拉客戶詢問清單，依詢問次數做客畫像
async function getCustomerProfiles({ days = 90, page_size = 200 } = {}) {
  let   sessions = await listRecentConversations({ days, page_size });
  if (sessions && sessions.data && sessions.data.list) sessions = sessions.data;
  if (!sessions || !sessions.list) return { ok: false, reason: 'no sessions' };

  const byUser = {};
  const list = Array.isArray(sessions.list) ? sessions.list : [];
  for (const s of list) {
    const uid = s.chat_user_id || s.contact_id || s.user_id || s.userId || 'unknown_' + (s.id || Math.random());
    const name = s.user_name || s.contact_name || s.name || s.nickname || '';
    const channel = s.channel || s.source || s.platform || '';
    const ts = s.last_message_time || s.update_time || s.create_time || s.timestamp || 0;
    const tsMs = typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : new Date(ts).getTime();

    if (!byUser[uid]) {
      byUser[uid] = {
        user_id: uid, user_name: name, channel,
        inquiry_count: 0, first_at_ms: tsMs, last_at_ms: tsMs,
        sessions: [],
      };
    }
    const c = byUser[uid];
    c.inquiry_count += 1;
    if (tsMs < c.first_at_ms) c.first_at_ms = tsMs;
    if (tsMs > c.last_at_ms) c.last_at_ms = tsMs;
    if (!c.user_name && name) c.user_name = name;
    if (!c.channel && channel) c.channel = channel;
    c.sessions.push({ id: s.id, at_ms: tsMs });
  }

  const now = Date.now();
  let   customers = Object.values(byUser).map(c => {
    const recencyDays = Math.floor((now - c.last_at_ms) / (24 * 3600 * 1000));
    let segment = 'cold';
    if (c.inquiry_count >= 5 && recencyDays <= 14) segment = 'vip';
    else if (c.inquiry_count >= 3 && recencyDays <= 30) segment = 'active_responder';
    else if (recencyDays <= 14) segment = 'active';
    else if (recencyDays <= 30) segment = 'warm';
    else if (recencyDays > 60) segment = 'lost';
    return {
      user_id: c.user_id, user_name: c.user_name, channel: c.channel,
      inquiry_count: c.inquiry_count, recency_days: recencyDays, segment,
      first_at: new Date(c.first_at_ms).toISOString(),
      last_at: new Date(c.last_at_ms).toISOString(),
    };
  }).sort((a, b) => b.inquiry_count - a.inquiry_count);
  // Filter to only customers within `days` recency window
  customers = customers.filter(c => c.recency_days <= days);

  const segments = {
    vip: { label: '🔥 VIP（高頻+近期）', desc: '5+ 詢問 + 14 天內', count: 0 },
    active_responder: { label: '💬 主動回覆（最有溫度）', desc: '3+ 詢問 + 30 天內', count: 0 },
    active: { label: '💚 活躍', desc: '14 天內有詢問', count: 0 },
    warm: { label: '🌤️ 溫客', desc: '14-30 天前有詢問', count: 0 },
    cold: { label: '❄️ 冷客', desc: '30-60 天前有詢問', count: 0 },
    lost: { label: '😢 流失', desc: '60+ 天沒詢問', count: 0 },
  };
  customers.forEach(c => { if (segments[c.segment]) segments[c.segment].count += 1; });

  return {
    ok: true, total: customers.length, days_range: days,
    segments, customers: customers.slice(0, 100),
  };
}


// ── 取單一 chat_user 真實名字 (FB display_name / IG handle / LINE displayName) + cache ──
const VISITOR_CACHE_FILE = path.join(CACHE_DIR, 'salesmartly-visitors.json');
function _loadVisitorCache() {
  try { return JSON.parse(fs.readFileSync(VISITOR_CACHE_FILE, 'utf8')); } catch { return {}; }
}
function _saveVisitorCache(o) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
  try { fs.writeFileSync(VISITOR_CACHE_FILE, JSON.stringify(o, null, 2)); } catch {}
}
const VISITOR_ENDPOINTS = [
  '/api/v2/get-visitor-info',
  '/api/v2/get-contact-info',
  '/api/v2/get-user-info',
  '/api/v2/get-chat-user-info',
];
async function getVisitorInfo(chat_user_id, { force = false } = {}) {
  if (!chat_user_id) return null;
  const cache = _loadVisitorCache();
  if (!force && cache[chat_user_id] && cache[chat_user_id]._at && (Date.now() - cache[chat_user_id]._at) < 24*3600*1000) {
    return cache[chat_user_id];
  }
  const params = { chat_user_id, project_id: PROJECT_ID };
  for (const ep of VISITOR_ENDPOINTS) {
    try {
      const r = await apiCall(ep, params, 'POST');
      if (r && r.code === 200 && r.data) {
        const d = r.data;
        const info = {
          chat_user_id,
          nickname: d.nickname || d.display_name || d.name || d.user_name || d.contact_name || '',
          real_name: d.real_name || d.full_name || '',
          channel: d.channel || d.source || '',
          avatar: d.avatar || d.profile_pic || '',
          tags: d.tags || [],
          _at: Date.now(),
          _ep: ep,
        };
        cache[chat_user_id] = info;
        _saveVisitorCache(cache);
        return info;
      }
    } catch {}
  }
  // 全部失敗就只 cache 空殼避免重複嘗試 (TTL 1hr)
  cache[chat_user_id] = { chat_user_id, nickname: '', _at: Date.now() - 23*3600*1000, _ep: 'none' };
  _saveVisitorCache(cache);
  return cache[chat_user_id];
}

// Normalize messages to consistent {from_customer, text, at}
async function listMessagesNormalized(chat_user_id, opts) {
  const r = await listMessages(chat_user_id, opts);
  const ms = (r.data && r.data.list) || r.list || [];
  // SaleSmartly empirical: sender_type 1 = visitor/customer, sender_type 2 = agent/system reply
  return ms.map(m => ({
    from_customer: m.sender_type === 1,
    text: (m.text || m.content || m.message || '').toString(),
    at: m.send_time || m.created_at || m.time,
    msg_type: m.msg_type,
    sender_type: m.sender_type,
    sender_name: m.sender_name || m.from_name || m.nickname || m.user_name || m.contact_name || '',
    sender_avatar: m.sender_avatar || m.avatar || '',
  })).filter(m => m.text && m.text.length > 0 && !m.text.startsWith('{"channel_info"'));
}


async function buildDailyInboxAnalysis({ anthropic, hours = 24 } = {}) {
  const fs = require('fs'), path = require('path');
  const D = process.env.RENDER_DISK_MOUNT_PATH || '/var/data';
  const f = path.join(D, 'salesmartly-inbox.jsonl');
  let raw = '';
  try { raw = fs.readFileSync(f, 'utf8'); } catch (e) {
    return '📥 溫點 SS 每日對話彙整：目前尚無資料（webhook 尚未收到訊息或未設定）。';
  }
  const brandRe = new RegExp(process.env.SS_BRAND_MATCH || '溫點|warmplace|胖卡龍', 'i');
  const since = Date.now() - hours * 3600 * 1000;
  const events = [];
  for (const ln of raw.split('\n')) {
    if (!ln) continue;
    try { const o = JSON.parse(ln); if ((o.t || 0) >= since) events.push(o); } catch (e) {}
  }
  if (!events.length) return '📥 溫點 SS 每日對話彙整：過去 ' + hours + ' 小時無新訊息。';
  const msgs = [];
  let skipped = 0;
  for (const e of events) {
    const b = (e && e.body) || {};
    let data = b.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (x) { data = {}; } }
    data = data || {};
    const cname = String(data.channel_name || data.channel || '未知');
    if (!brandRe.test(cname)) { skipped++; continue; }
    let content = data.msg || data.content || data.message || data.text || '';
    if (content && typeof content === 'object') content = content.text || content.content || JSON.stringify(content);
    const st = String(data.sender_type || data.senderType || '');
    const fromCustomer = st === '2' ? false : true;
    const txt = String(content).replace(/\s+/g, ' ').trim().slice(0, 300);
    if (txt) msgs.push({ channel: cname, txt, fromCustomer });
  }
  const chCount = {};
  msgs.forEach(m => { chCount[m.channel] = (chCount[m.channel] || 0) + 1; });
  const chLine = Object.entries(chCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ':' + v).join('  ') || '無';
  if (!msgs.length) return '📥 溫點 SS 每日對話彙整：過去 ' + hours + ' 小時無溫點／胖卡龍訊息（已略過其他品牌 ' + skipped + ' 則）。';
  if (!anthropic) {
    return '📥 溫點 SS 每日對話彙整（' + msgs.length + ' 則，已排除他牌 ' + skipped + ' 則）\n渠道量：' + chLine;
  }
  const sample = msgs.slice(0, 150).map(m => (m.fromCustomer ? '客' : '客服') + '[' + m.channel + ']: ' + m.txt).join('\n');
  const prompt = '以下是溫點 WarmPlace（台南手工胖卡龍）過去一天客服對話（每行一則，客＝客人、客服＝我方）。請用繁體中文做「每日客服彙整」，純文字不要 markdown 不要星號或井字號，分六段：\n1) 常見問題 TOP3\n2) 成交機會：列出想買或詢價的客人（用渠道＋片語代稱）並標熱／溫／冷\n3) 漏回提醒：有問但看起來沒被回的\n4) 情緒／滿意度：點出不滿或抱怨\n5) 渠道量：' + chLine + '\n6) 今日核心問題與行動：挑最多3個當日最關鍵的問題，每個一行寫「問題→根因→今日建議動作」\n\n對話：\n' + sample;
  const model = process.env.SS_DIGEST_MODEL || process.env.CLAUDE_MODEL || 'claude-opus-4-8';
  let out = '';
  try {
    const resp = await anthropic.messages.create({ model: model, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] });
    out = (resp && resp.content && resp.content[0] && resp.content[0].text) || '';
  } catch (e) {
    return '📥 溫點 SS 每日彙整（' + msgs.length + ' 則，分析暫時失敗）\n渠道量：' + chLine + '\n' + String(e.message).slice(0, 100);
  }
  return '📥 溫點 SS 每日對話彙整（' + msgs.length + ' 則）\n\n' + out.trim();
}

async function buildWeeklyDeepAnalysis({ anthropic, days = 7 } = {}) {
  const fs = require('fs'), path = require('path');
  const D = process.env.RENDER_DISK_MOUNT_PATH || '/var/data';
  const f = path.join(D, 'salesmartly-inbox.jsonl');
  let raw = '';
  try { raw = fs.readFileSync(f, 'utf8'); } catch (e) {
    return '📊 溫點 SS 每週深度診斷：目前尚無資料。';
  }
  const brandRe = new RegExp(process.env.SS_BRAND_MATCH || '溫點|warmplace|胖卡龍', 'i');
  const since = Date.now() - days * 24 * 3600 * 1000;
  const msgs = [];
  const chCount = {};
  for (const ln of raw.split('\n')) {
    if (!ln) continue;
    let o; try { o = JSON.parse(ln); } catch (e) { continue; }
    if ((o.t || 0) < since) continue;
    let data = (o.body || {}).data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (x) { data = {}; } }
    data = data || {};
    const cname = String(data.channel_name || data.channel || '未知');
    if (!brandRe.test(cname)) continue;
    let content = data.msg || data.content || data.message || data.text || '';
    if (content && typeof content === 'object') content = content.text || content.content || JSON.stringify(content);
    const st = String(data.sender_type || data.senderType || '');
    const fromCustomer = st === '2' ? false : true;
    const txt = String(content).replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!txt) continue;
    chCount[cname] = (chCount[cname] || 0) + 1;
    msgs.push({ channel: cname, txt, fromCustomer });
  }
  if (!msgs.length) return '📊 溫點 SS 每週深度診斷：過去 ' + days + ' 天無溫點／胖卡龍訊息。';
  const chLine = Object.entries(chCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ':' + v).join('  ');
  if (!anthropic) return '📊 溫點 SS 每週概況（' + msgs.length + ' 則）\n渠道量：' + chLine;
  const step = Math.max(1, Math.floor(msgs.length / 250));
  const picked = msgs.filter((_, i) => i % step === 0).slice(0, 250);
  const sample = picked.map(m => (m.fromCustomer ? '客' : '客服') + '[' + m.channel + ']: ' + m.txt).join('\n');
  const prompt = '你是溫點 WarmPlace（台南手工胖卡龍）的行銷與客服顧問。以下是過去 ' + days + ' 天的客服對話抽樣（客＝客人、客服＝我方）。請用繁體中文做「每週深度診斷」，純文字不要 markdown 不要星號或井字號，900 字內，分四大段：\n一、一週概況：訊息量、主要渠道、看得出的成交機會數與漏回情形\n二、核心問題（3至5個，依重要性排序）：每個寫【問題】與【根因】\n三、解決方案：對應每一個核心問題，給【建議話術或SOP】與【流程／定價／跟進機制建議】\n四、本週優先行動（3至5條，可執行、排序）\n\n本週訊息量：' + msgs.length + '　渠道量：' + chLine + '\n\n對話抽樣：\n' + sample;
  const model = process.env.SS_DIGEST_MODEL || process.env.CLAUDE_MODEL || 'claude-opus-4-8';
  let out = '';
  try {
    const resp = await anthropic.messages.create({ model: model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] });
    out = (resp && resp.content && resp.content[0] && resp.content[0].text) || '';
  } catch (e) {
    return '📊 溫點 SS 每週深度診斷（' + msgs.length + ' 則，分析暫時失敗）\n渠道量：' + chLine + '\n' + String(e.message).slice(0, 100);
  }
  return '📊 溫點 SS 每週深度診斷（近 ' + days + ' 天 ' + msgs.length + ' 則）\n\n' + out.trim();
}


async function uploadPdfToDrive(name, buffer, folderId) {
  const dp = require('./daily-progress');
  const token = await dp.getAccessToken();
  const boundary = '----macaronPdf' + Math.random().toString(36).slice(2);
  const meta = { name: name, parents: [folderId], mimeType: 'application/pdf' };
  const pre = Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + boundary + '\r\nContent-Type: application/pdf\r\n\r\n', 'utf8');
  const post = Buffer.from('\r\n--' + boundary + '--', 'utf8');
  const body = Buffer.concat([pre, buffer, post]);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary },
    body: body
  });
  const d = await r.json();
  if (!d.id) throw new Error('drive upload fail: ' + JSON.stringify(d).slice(0, 200));
  return d.id;
}

async function buildMonthlyReportSections({ anthropic } = {}) {
  const d = new Date();
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const ym = prev.getFullYear() + '-' + String(prev.getMonth() + 1).padStart(2, '0');
  let shopBody = '（無法取得銷售資料）';
  try {
    const sl = require('./shopline');
    const r = await sl.getOrdersSummary({ days: 31 });
    if (r && r.ok !== false) {
      shopBody = '近 31 天已付營收：NT$' + Number(r.total_revenue || 0).toLocaleString() +
        '\n訂單數：' + (r.count || 0) + '（已付 ' + (r.paid_count || 0) + '）' +
        '\n客單價 AOV：NT$' + Number(r.aov_paid || 0).toLocaleString() +
        '\n售出件數：' + (r.total_qty || 0);
      if (r.top_skus && r.top_skus.length) {
        shopBody += '\n\n熱銷 TOP5：\n' + r.top_skus.slice(0, 5).map((s, i) => (i + 1) + '. ' + (s.sku || s.name || '?') + ' × ' + (s.q || s.qty || 0)).join('\n');
      }
    }
  } catch (e) { shopBody = '銷售資料讀取失敗：' + e.message; }
  let ssBody = '（無客服資料）';
  try { ssBody = await buildWeeklyDeepAnalysis({ anthropic: anthropic, days: 31 }); } catch (e) { ssBody = '客服分析失敗：' + e.message; }
  ssBody = String(ssBody).replace(/^📊[^\n]*\n+/, '');
  return {
    title: '溫點 WarmPlace 月報（' + ym + '）',
    sections: [
      { heading: '一、銷售概況（Shopline・近 31 天）', body: shopBody },
      { heading: '二、客服對話深度診斷（SaleSmartly・僅溫點）', body: ssBody },
      { heading: '三、備註', body: '本報告由系統每月 1 日自動產生，涵蓋上月概況並上傳雲端。外部競品市場分析需另行手動更新。' }
    ]
  };
}

async function runMonthlyReportToDrive({ anthropic } = {}) {
  const fs = require('fs'), path = require('path');
  const built = await buildMonthlyReportSections({ anthropic: anthropic });
  const files = require('./files');
  const pdf = await files.generatePdf({ title: built.title, sections: built.sections });
  if (!pdf || !pdf.ok) throw new Error('pdf fail: ' + JSON.stringify(pdf).slice(0, 150));
  const D = process.env.RENDER_DISK_MOUNT_PATH || '/var/data';
  const buf = fs.readFileSync(path.join(D, 'exports', pdf.filename));
  const folderId = process.env.GDRIVE_REPORT_FOLDER_ID || process.env.GDRIVE_FOLDER_ID;
  let driveId = null, driveErr = null;
  try {
    if (!folderId) throw new Error('未設定 GDRIVE_FOLDER_ID');
    driveId = await uploadPdfToDrive(pdf.filename, buf, folderId);
  } catch (e) { driveErr = e.message; }
  const base = process.env.PUBLIC_BASE_URL || 'https://macaron-office.onrender.com';
  let text = '📄 溫點月報已產生：' + built.title + '\n檔案：' + pdf.filename + '（' + pdf.bytes + ' bytes）';
  if (driveId) text += '\n☁️ 已上傳 Google Drive（file id: ' + driveId + '）';
  else text += '\n⚠️ 雲端上傳失敗：' + driveErr;
  text += '\n🔗 下載：' + (String(pdf.url).startsWith('http') ? pdf.url : base + pdf.url);
  return { ok: true, text: text, filename: pdf.filename, driveId: driveId };
}

async function getNewAnomaliesText() {
  const fs = require('fs'), path = require('path');
  const D = process.env.RENDER_DISK_MOUNT_PATH || '/var/data';
  const f = path.join(D, 'anomalies.jsonl');
  const stateF = path.join(D, '.anom-last-push');
  let raw = '';
  try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { return null; }
  let last = 0;
  try { last = parseInt(fs.readFileSync(stateF, 'utf8'), 10) || 0; } catch (e) {}
  const findings = [];
  let maxT = last;
  for (const ln of raw.split('\n')) {
    if (!ln) continue;
    let o; try { o = JSON.parse(ln); } catch (e) { continue; }
    const t = Date.parse(o.t) || 0;
    if (t <= last) continue;
    if (t > maxT) maxT = t;
    (o.findings || []).forEach(fd => { if (fd && fd.message) findings.push((fd.severity === 'high' ? '🔴' : '🟡') + ' ' + fd.message); });
  }
  try { fs.writeFileSync(stateF, String(maxT)); } catch (e) {}
  if (!findings.length) return null;
  const shown = findings.slice(-40);
  return '⚠️ 溫點系統異樣通報（' + findings.length + ' 則' + (findings.length > 40 ? '，顯示最新 40' : '') + '）\n\n' + shown.join('\n');
}

module.exports = {
  runMonthlyReportToDrive,
  getNewAnomaliesText,
  buildMonthlyReportSections,
  buildWeeklyDeepAnalysis,
  buildDailyInboxAnalysis, signParams, apiCall, listRecentConversations, listMessages, listMessagesNormalized, extractTopQuestions, getCustomerInsights, formatBriefingSection, probeAll, getVisitorInfo, getCustomerProfiles,
};
