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
        const inb = ms.filter(m => {
          // SaleSmartly: is_reply=true means OUR reply, is_reply=false means CUSTOMER msg
          if (m.is_reply === false || m.is_reply === 0) return true;
          if (m.is_reply === true || m.is_reply === 1) return false;
          // fallback: sender_type
          const d = m.sender_type || m.direction || m.from_type;
          return d === 'visitor' || d === 'customer' || d === 'user' || d === 'in';
        });
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

// Normalize messages to consistent {from_customer, text, at}
async function listMessagesNormalized(chat_user_id, opts) {
  const r = await listMessages(chat_user_id, opts);
  const ms = (r.data && r.data.list) || r.list || [];
  return ms.map(m => ({
    from_customer: (m.is_reply === false || m.is_reply === 0),
    text: m.text || m.content || m.message || '',
    at: m.send_time || m.created_at || m.time,
    msg_type: m.msg_type,
    sender_type: m.sender_type,
  }));
}

module.exports = { signParams, apiCall, listRecentConversations, listMessages, listMessagesNormalized, extractTopQuestions, getCustomerInsights, formatBriefingSection, probeAll,   getCustomerProfiles,
};
