// ============================================================
// customers.js — 客人畫像 + RFM 分群 (溫點 WarmPlace)
// 改用 SaleSmartly 全管道 (FB DM + IG DM + LINE) — session.title 抓 FB/IG 真實顯示名
// 保留舊 API (loadMessages / aggregateCustomers / groupBySegment) 讓 server.js 既有 routes 持續運作
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const sm = (() => { try { return require('./salesmartly'); } catch { return null; } })();

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'salesmartly-customers-cache.json');
const PROFILES_FILE = path.join(DATA_DIR, 'customer-profiles.json');
const CACHE_TTL = 5 * 60 * 1000; // 5 分鐘

// 只看溫點 macaron 的頻道：FB 溫點 + IG @warmplace.here + (LINE)
const MACARON_FB_PAGE_ID = '903707566167263';
function isMacaronChannel(s) {
  const ch = Number(s.channel);
  const cid = String(s.channel_id);
  if (ch === 1 && cid === MACARON_FB_PAGE_ID) return true;
  if (ch === 6) return true;
  if (ch === 2) return true;
  return false;
}
function channelName(ch) {
  ch = Number(ch);
  if (ch === 1) return 'FB';
  if (ch === 6) return 'IG';
  if (ch === 2) return 'LINE';
  return 'CH' + ch;
}
function tsToMs(t) { if (!t) return 0; const n = parseInt(t); if (!n) return 0; return n > 1e12 ? n : n * 1000; }

const SEGMENTS = {
  vip:    { label: '🔥 VIP',      color: '#B08D57', desc: '高頻 (≥5) + 近 14 天活躍' },
  active: { label: '💚 活躍客',   color: '#3ddc84', desc: '14 天內有對話' },
  new:    { label: '🆕 新客',     color: '#4285F4', desc: '首次聯絡 ≤ 14 天' },
  atrisk: { label: '😴 潛在流失', color: '#ff6b6b', desc: '超過 30 天沒聯絡' },
};

function ensureDir() { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }

function loadCustomerProfiles(dataDir = DATA_DIR) {
  const f = path.join(dataDir, 'customer-profiles.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch { return {}; }
}
function saveCustomerProfiles(dataDir, profiles) {
  ensureDir();
  const f = path.join(dataDir || DATA_DIR, 'customer-profiles.json');
  try { fs.writeFileSync(f, JSON.stringify(profiles, null, 2)); return true; } catch { return false; }
}

// === SaleSmartly → cache ===
let _syncInflight = null;
async function syncFromSaleSmartly({ days = 60 } = {}) {
  if (!sm || !sm.listRecentConversations) return { ok: false, error: 'salesmartly 未載入' };
  if (_syncInflight) return _syncInflight;
  _syncInflight = (async () => {
    try {
      const conv = await sm.listRecentConversations({ days, page_size: 200 });
      const list = (conv && (conv.list || (conv.data && conv.data.list))) || [];
      const macaron = list.filter(isMacaronChannel);
      // 把 SaleSmartly session 轉成 message-like 物件，相容 aggregateCustomers
      const messages = [];
      for (const s of macaron) {
        const uid = s.chat_user_id || s.contact_id || s.user_id || s.session_id || s.id;
        if (!uid) continue;
        const firstMs = tsToMs(s.start_time) || tsToMs(s.last_message_time) || Date.now();
        const lastMs = tsToMs(s.last_message_time) || tsToMs(s.end_time) || firstMs;
        const custCount = parseInt(s.customer_msg_count) || 0;
        const ourCount  = parseInt(s.user_msg_count) || 0;
        const tags = Array.isArray(s.tags) ? s.tags : [];
        // 每通對話展開成 N 個假訊息 (客人) + M 個假回覆 (我們)
        for (let i = 0; i < Math.max(1, custCount); i++) {
          messages.push({
            id: uid + '_c' + i,
            userId: uid,
            userName: s.title || ('客人 ' + String(uid).slice(0, 6)),
            text: '', // 不下載完整訊息內文 — 只算 frequency/recency
            intent: tags.includes('購買訊號') ? 'price' : 'other',
            timestamp: firstMs + i * 60000, // 模擬時序
            replied: i < ourCount,
            channel: channelName(s.channel),
          });
        }
        // 補一筆 last_message 確保 lastMessageAt 抓到對的時間
        messages.push({
          id: uid + '_last',
          userId: uid,
          userName: s.title || ('客人 ' + String(uid).slice(0, 6)),
          text: '',
          intent: 'other',
          timestamp: lastMs,
          replied: ourCount > 0,
          channel: channelName(s.channel),
        });
      }
      ensureDir();
      const cache = { synced_at: Date.now(), days, total_macaron_sessions: macaron.length, messages };
      try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); } catch {}
      return { ok: true, sessions: macaron.length, messages: messages.length };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally { _syncInflight = null; }
  })();
  return _syncInflight;
}

function _loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return null; }
}

// === server.js 透過 require('./customers').loadMessages(DATA_DIR) 取訊息 ===
function loadMessages(dataDir) {
  const c = _loadCache();
  if (!c) {
    // 第一次呼叫沒 cache — 觸發背景 sync (下次就有了)
    syncFromSaleSmartly().catch(() => {});
    return [];
  }
  // 若 cache 過期，背景刷新但仍回舊資料
  if (Date.now() - (c.synced_at || 0) > CACHE_TTL) {
    syncFromSaleSmartly().catch(() => {});
  }
  return c.messages || [];
}

function aggregateCustomers(messages, profiles = {}) {
  const byUser = {};
  const now = Date.now();
  for (const m of messages) {
    if (!m.userId) continue;
    if (!byUser[m.userId]) {
      byUser[m.userId] = {
        userId: m.userId,
        userName: m.userName || ('客人 ' + String(m.userId).slice(0, 6)),
        channel: m.channel || 'FB',
        firstMessageAt: m.timestamp,
        lastMessageAt: m.timestamp,
        messageCount: 0,
        replyCount: 0,
        intents: {},
      };
    }
    const c = byUser[m.userId];
    c.messageCount++;
    if (m.replied) c.replyCount++;
    if (m.timestamp < c.firstMessageAt) c.firstMessageAt = m.timestamp;
    if (m.timestamp > c.lastMessageAt) c.lastMessageAt = m.timestamp;
    const intent = m.intent || 'other';
    c.intents[intent] = (c.intents[intent] || 0) + 1;
    if (m.userName && !m.userName.startsWith('客人 ')) c.userName = m.userName;
  }
  const customers = Object.values(byUser).map(c => {
    const recencyDays = Math.floor((now - c.lastMessageAt) / 86400000);
    const ageDays = Math.floor((now - c.firstMessageAt) / 86400000);
    const frequency = c.messageCount;
    let segment;
    if (ageDays <= 14 && frequency <= 3) segment = 'new';
    else if (recencyDays > 30) segment = 'atrisk';
    else if (frequency >= 5 && recencyDays <= 14) segment = 'vip';
    else if (recencyDays <= 14) segment = 'active';
    else segment = 'atrisk';
    const profile = profiles[c.userId] || {};
    return {
      ...c,
      recencyDays, ageDays, frequency,
      segment,
      hasReplied: c.replyCount > 0,
      lastMessageAtIso: new Date(c.lastMessageAt).toISOString(),
      firstMessageAtIso: new Date(c.firstMessageAt).toISOString(),
      aiProfile: profile.aiProfile || null,
      tags: profile.tags || [],
      profileUpdatedAt: profile.updatedAt || null,
    };
  });
  const order = { vip: 0, active: 1, new: 2, atrisk: 3 };
  customers.sort((a, b) => {
    if (order[a.segment] !== order[b.segment]) return order[a.segment] - order[b.segment];
    return b.lastMessageAt - a.lastMessageAt;
  });
  return customers;
}

function groupBySegment(customers) {
  const groups = { vip: [], active: [], new: [], atrisk: [] };
  for (const c of customers) if (groups[c.segment]) groups[c.segment].push(c);
  return groups;
}

// === Routes (router 也掛在 /api/customers，跟 server.js 既有 inline routes 共存) ===
router.get('/sync', async (req, res) => {
  try { const r = await syncFromSaleSmartly({ days: 60 }); res.json(r); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/cache-status', (req, res) => {
  const c = _loadCache();
  res.json({ ok: true, has_cache: !!c, synced_at: c && c.synced_at, age_minutes: c ? Math.floor((Date.now() - (c.synced_at || 0)) / 60000) : null, message_count: c ? (c.messages || []).length : 0, sessions: c ? c.total_macaron_sessions : 0 });
});

module.exports = router;
module.exports.SEGMENTS = SEGMENTS;
module.exports.loadMessages = loadMessages;
module.exports.loadCustomerProfiles = loadCustomerProfiles;
module.exports.saveCustomerProfiles = saveCustomerProfiles;
module.exports.aggregateCustomers = aggregateCustomers;
module.exports.groupBySegment = groupBySegment;
module.exports.syncFromSaleSmartly = syncFromSaleSmartly;
