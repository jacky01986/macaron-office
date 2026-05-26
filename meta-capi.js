// meta-capi.js — Meta Conversions API client（Lead + Purchase）
// 溫點 WarmPlace · 把每個客戶詢問當作 Lead 事件回送 Meta
// FB 演算法會學「這種人會詢問」→ 自動找更多類似的人 → 廣告越投越精準
//
// 必要環境變數：
//   META_PIXEL_ID         — 你的 Pixel ID
//   META_CAPI_TOKEN       — 系統用戶 access token（可與 META_ACCESS_TOKEN 同一個）
//   META_TEST_EVENT_CODE  — 選填，測試事件代碼（測完要刪掉）
//
// 提供：
//   sendLead({ contact_id, name, email, phone, source_channel, message_preview })
//   sendPurchase({ contact_id, name, email, phone, value, currency, content_name, content_category, event_id })

const crypto = require('crypto');

const PIXEL_ID = process.env.META_PIXEL_ID;
const TOKEN = process.env.META_CAPI_TOKEN || process.env.META_ACCESS_TOKEN;
const TEST_CODE = process.env.META_TEST_EVENT_CODE || '';

const API_VERSION = 'v19.0';

function sha256(s) {
  if (!s) return undefined;
  return crypto.createHash('sha256').update(String(s).trim().toLowerCase(), 'utf8').digest('hex');
}

function normalizePhone(p) {
  if (!p) return undefined;
  return String(p).replace(/[^0-9]/g, '');
}

function buildUserData({ name, email, phone, contact_id }) {
  const ud = {};
  if (email) ud.em = [sha256(email)];
  if (phone) ud.ph = [sha256(normalizePhone(phone))];
  if (name) {
    const parts = String(name).trim().split(/\s+/);
    if (parts[0]) ud.fn = [sha256(parts[0])];
    if (parts.length > 1) ud.ln = [sha256(parts[parts.length - 1])];
  }
  if (contact_id) ud.external_id = [sha256(contact_id)];
  return ud;
}

async function postEvent(eventName, userData, customData = {}, eventId) {
  if (!PIXEL_ID || !TOKEN) {
    return { ok: false, reason: 'META_PIXEL_ID or META_CAPI_TOKEN not set' };
  }

  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    action_source: 'system_generated',
    user_data: userData,
    custom_data: customData,
  };
  if (eventId) event.event_id = eventId;

  const body = { data: [event] };
  if (TEST_CODE) body.test_event_code = TEST_CODE;

  const url = 'https://graph.facebook.com/' + API_VERSION + '/' + PIXEL_ID + '/events?access_token=' + encodeURIComponent(TOKEN);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (!res.ok || j.error) {
      console.error('[meta-capi] ' + eventName + ' failed:', j.error || res.status);
      return { ok: false, error: j.error?.message || res.status, raw: j };
    }
    console.log('[meta-capi] ' + eventName + ' sent: events_received=' + j.events_received);
    return { ok: true, response: j };
  } catch (e) {
    console.error('[meta-capi] network error:', e.message);
    return { ok: false, error: e.message };
  }
}

// === Lead 事件 — 任何客戶第一次詢問就送 ===
async function sendLead({ contact_id, name, email, phone, source_channel, message_preview }) {
  const userData = buildUserData({ name, email, phone, contact_id });
  const customData = {
    lead_event_source: source_channel || 'line',
  };
  if (message_preview) customData.content_name = String(message_preview).slice(0, 100);
  const eventId = 'Lead_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  return postEvent('Lead', userData, customData, eventId);
}

// === Purchase 事件 — 客戶成交時送（例：訂禮盒、客製訂購）===
async function sendPurchase({
  contact_id, name, email, phone,
  value, currency = 'TWD',
  content_name, content_category, event_id,
}) {
  const userData = buildUserData({ name, email, phone, contact_id });
  const customData = {
    value: Number(value) || 0,
    currency,
  };
  if (content_name) customData.content_name = String(content_name).slice(0, 100);
  if (content_category) customData.content_category = String(content_category).slice(0, 50);
  if (event_id) customData.content_ids = [event_id];
  const eid = event_id || ('Purchase_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
  return postEvent('Purchase', userData, customData, eid);
}

// === AddToCart / ViewContent 也可以送 ===
async function sendCustomEvent(eventName, { contact_id, name, email, phone, customData = {} }) {
  const userData = buildUserData({ name, email, phone, contact_id });
  const eventId = eventName + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  return postEvent(eventName, userData, customData, eventId);
}

module.exports = {
  sendLead,
  sendPurchase,
  sendCustomEvent,
};
