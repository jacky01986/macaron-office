// salesmartly.js — SaleSmartly API client (compact version)
// env: SALESMARTLY_TOKEN, SALESMARTLY_PROJECT_ID, SALESMARTLY_BASE_URL (optional)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.SALESMARTLY_TOKEN || '';
const PROJECT_ID = process.env.SALESMARTLY_PROJECT_ID || '';
const BASE_URL = process.env.SALESMARTLY_BASE_URL || 'https://api.salesmartly.com';
const CACHE_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(CACHE_DIR, 'salesmartly_conversations.json');

function signParams(params = {}) {
  const keys = Object.keys(params).sort();
  const concat = keys.map(k => {
    const v = params[k];
    if (v == null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }).join('');
  return crypto.createHash('md5').update(concat + TOKEN, 'utf8').digest('hex');
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
  return json;
}

async function tryEndpoints(endpoints, params) {
  let lastErr;
  for (const ep of endpoints) {
    try { const r = await apiCall(ep, params, 'POST'); r._endpoint_used = ep; return r; }
    catch (e) { lastErr = e; }
  }
  throw new Error('All endpoints failed: ' + (lastErr && lastErr.message));
}

async function listRecentConversations({ days = 7, page = 1, page_size = 50 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return tryEndpoints(
    ['/v1/conversations', '/v1/conversation/list', '/openapi/conversation/list', '/api/conversations'],
    { page, page_size, start_time: now - days * 86400, end_time: now }
  );
}

async function listMessages(chat_user_id, { page = 1, page_size = 50 } = {}) {
  return tryEndpoints(
    ['/v1/messages', '/v1/message/list', '/openapi/message/list'],
    { chat_user_id, page, page_size }
  );
}

const BUCKETS = {
  'price': { rx: /價錢|學費|多少錢|費用|報價|價格/, label: '價格 / 學費' },
  'content': { rx: /課程|教什麼|內容|大綱|學什麼/, label: '課程內容' },
  'time': { rx: /時間|什麼時候|開課|何時/, label: '上課時間' },
  'pay': { rx: /怎麼報名|付款|匯款|刷卡|分期/, label: '報名 / 付款' },
  'cert': { rx: /證照|證書|執照|結業/, label: '證照 / 結業' },
  'refund': { rx: /退費|取消|退款/, label: '退費 / 取消' },
  'teacher': { rx: /老師|師資|誰教/, label: '師資 / 老師' },
  'place': { rx: /地點|教室|地址|哪裡/, label: '地點 / 教室' },
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
    const convs = cl.data || cl.list || cl.items || [];
    const allMsgs = [];
    for (const conv of convs.slice(0, 20)) {
      const uid = conv.chat_user_id || conv.user_id || conv.id;
      if (!uid) continue;
      try {
        const mr = await listMessages(uid, { page_size: 30 });
        const ms = mr.data || mr.list || mr.items || [];
        const inb = ms.filter(m => {
          const d = m.direction || m.from_type || m.sender_type;
          return d === 'in' || d === 'visitor' || d === 'customer' || d === 1;
        });
        allMsgs.push(...inb);
      } catch {}
    }
    const topics = extractTopQuestions(allMsgs);
    try {
      if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ updated_at: new Date().toISOString(), conversation_count: convs.length, message_count: allMsgs.length, topics }, null, 2));
    } catch {}
    return { ok: true, conversation_count: convs.length, message_count: allMsgs.length, topics, summary: formatBriefingSection(topics, convs.length, allMsgs.length, days) };
  } catch (err) {
    return { ok: false, reason: err.message, summary: null };
  }
}

function formatBriefingSection(topics, convCount, msgCount, days) {
  if (!topics || topics.length === 0) return '客服（過去 ' + days + ' 天）：無對話資料';
  const lines = ['客服洞察（過去 ' + days + ' 天，' + convCount + ' 場對話 / ' + msgCount + ' 則客人訊息）'];
  topics.slice(0, 5).forEach((t, i) => { lines.push((i+1) + '. ' + t.topic + '：' + t.count + ' 次'); });
  if (topics[0] && topics[0].count >= 5) {
    lines.push('');
    lines.push('建議：「' + topics[0].topic + '」這週被問 ' + topics[0].count + ' 次 → CAMILLE 寫一篇 FAQ');
  }
  return lines.join('
');
}

module.exports = { signParams, apiCall, listRecentConversations, listMessages, extractTopQuestions, getCustomerInsights, formatBriefingSection };
