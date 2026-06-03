// ============================================================
// customers.js — 客人畫像 + RFM 分群 (溫點 WarmPlace)
// 改用 SaleSmartly 全管道 (FB DM + IG DM + LINE) — 用 session.title 抓 FB/IG/LINE 真實顯示名
// 掛載：app.use('/api/customers', require('./customers'));
// ============================================================
const express = require('express');
const router = express.Router();
const sm = (() => { try { return require('./salesmartly'); } catch { return null; } })();

// 只看溫點 macaron 的頻道：FB 溫點 page id + IG @warmplace.here
const MACARON_FB_PAGE_ID = '903707566167263';
function isMacaronChannel(s) {
  const ch = Number(s.channel);
  const cid = String(s.channel_id);
  if (ch === 1 && cid === MACARON_FB_PAGE_ID) return true; // FB 溫點
  if (ch === 6) return true;  // IG 溫點
  if (ch === 2) return true;  // LINE (若有)
  return false;
}
function channelName(s) {
  const ch = Number(s.channel);
  if (ch === 1) return 'FB';
  if (ch === 6) return 'IG';
  if (ch === 2) return 'LINE';
  return 'CH' + ch;
}

const SEGMENTS = {
  vip:    { label: '🔥 VIP',      color: '#B08D57', desc: '高頻 (≥5) + 近 14 天活躍' },
  active: { label: '💚 活躍客',   color: '#3ddc84', desc: '14 天內有對話' },
  new:    { label: '🆕 新客',     color: '#4285F4', desc: '首次聯絡 ≤ 14 天' },
  atrisk: { label: '😴 潛在流失', color: '#ff6b6b', desc: '超過 30 天沒聯絡' },
};

const DAY = 86400 * 1000;

function classifySegment({ recencyDays, ageDays, msgCount }) {
  if (ageDays <= 14 && msgCount <= 3) return 'new';
  if (recencyDays > 30) return 'atrisk';
  if (msgCount >= 5 && recencyDays <= 14) return 'vip';
  if (recencyDays <= 14) return 'active';
  return 'atrisk';
}

function tsToMs(t) {
  if (!t) return 0;
  const n = parseInt(t);
  if (!n) return 0;
  return n > 1e12 ? n : n * 1000; // SaleSmartly 有時用 sec、有時 ms
}

async function buildAll({ days = 60 } = {}) {
  if (!sm || !sm.listRecentConversations) {
    return { ok: false, error: 'salesmartly 未載入', total: 0, summary: { total: 0, vip: 0, active: 0, new: 0, atrisk: 0 }, groups: { vip: [], active: [], new: [], atrisk: [] }, segments: SEGMENTS };
  }
  const conv = await sm.listRecentConversations({ days, page_size: 200 });
  const list = (conv && (conv.list || (conv.data && conv.data.list))) || [];
  const macaron = list.filter(isMacaronChannel);
  const now = Date.now();

  // 把同一 chat_user_id 的多個 session 合併
  const byUser = {};
  for (const s of macaron) {
    const uid = s.chat_user_id || s.contact_id || s.user_id || s.session_id || s.id;
    if (!uid) continue;
    const lastMs = tsToMs(s.last_message_time) || tsToMs(s.end_time) || tsToMs(s.start_time);
    const firstMs = tsToMs(s.start_time) || lastMs;
    const msgCount = (parseInt(s.msg_count) || 0) || ((parseInt(s.customer_msg_count) || 0) + (parseInt(s.user_msg_count) || 0));
    const custMsgCount = parseInt(s.customer_msg_count) || 0;
    const replyCount = parseInt(s.user_msg_count) || 0; // 我們的回覆數

    if (!byUser[uid]) {
      byUser[uid] = {
        userId: uid,
        userName: s.title || ('客人 ' + String(uid).slice(0, 6)),
        channel: channelName(s),
        channel_raw: s.channel,
        firstMessageAt: firstMs,
        lastMessageAt: lastMs,
        messageCount: 0,
        customerMessageCount: 0,
        replyCount: 0,
        tags: Array.isArray(s.tags) ? [...s.tags] : [],
        labels: Array.isArray(s.labels) ? [...s.labels] : [],
        sessions: 0,
      };
    }
    const c = byUser[uid];
    if (!c.userName || c.userName.startsWith('客人 ')) c.userName = s.title || c.userName;
    if (firstMs && (!c.firstMessageAt || firstMs < c.firstMessageAt)) c.firstMessageAt = firstMs;
    if (lastMs && lastMs > c.lastMessageAt) c.lastMessageAt = lastMs;
    c.messageCount += msgCount;
    c.customerMessageCount += custMsgCount;
    c.replyCount += replyCount;
    c.sessions += 1;
    if (Array.isArray(s.tags)) for (const t of s.tags) if (!c.tags.includes(t)) c.tags.push(t);
    if (Array.isArray(s.labels)) for (const l of s.labels) if (!c.labels.includes(l)) c.labels.push(l);
  }

  // 算 R/F + segment
  const customers = Object.values(byUser).map(c => {
    const recencyDays = c.lastMessageAt ? Math.floor((now - c.lastMessageAt) / DAY) : 9999;
    const ageDays = c.firstMessageAt ? Math.floor((now - c.firstMessageAt) / DAY) : 0;
    const segment = classifySegment({ recencyDays, ageDays, msgCount: c.messageCount });
    return {
      ...c,
      recencyDays,
      ageDays,
      frequency: c.messageCount,
      lastMessageAtIso: c.lastMessageAt ? new Date(c.lastMessageAt).toISOString() : null,
      firstMessageAtIso: c.firstMessageAt ? new Date(c.firstMessageAt).toISOString() : null,
      segment,
      hasReplied: c.replyCount > 0,
    };
  });

  // 排序：VIP / Active / New 最近的最前；At-risk 越久越前
  const order = { vip: 0, active: 1, new: 2, atrisk: 3 };
  customers.sort((a, b) => {
    if (order[a.segment] !== order[b.segment]) return order[a.segment] - order[b.segment];
    return b.lastMessageAt - a.lastMessageAt;
  });

  // 分群
  const groups = { vip: [], active: [], new: [], atrisk: [] };
  for (const c of customers) if (groups[c.segment]) groups[c.segment].push(c);

  const summary = {
    total: customers.length,
    vip: groups.vip.length,
    active: groups.active.length,
    new: groups.new.length,
    atrisk: groups.atrisk.length,
  };

  return { ok: true, total: customers.length, days_range: days, summary, groups, segments: SEGMENTS, customers };
}

// ───────── Routes ─────────
router.get('/', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 60, 7), 365);
    res.json(await buildAll({ days }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/profiles', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 60, 7), 365);
    const r = await buildAll({ days });
    res.json({ ok: r.ok, total: r.total, profiles: r.customers || [] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/segments', (req, res) => res.json({ ok: true, segments: SEGMENTS }));

// Stubs to keep existing UI happy (broadcast 暫不開放)
router.post('/segment-broadcast', express.json(), (req, res) => res.status(403).json({ ok: false, error: '群發功能暫未開放（草稿模式）' }));
router.post('/segment-push', express.json(), (req, res) => res.status(403).json({ ok: false, error: '群發功能暫未開放（草稿模式）' }));

module.exports = router;
module.exports.buildAll = buildAll;
module.exports.SEGMENTS = SEGMENTS;
