// ============================================================
// MACARON DE LUXE · LINE 客人畫像 + RFM 分群 (T8)
// ============================================================
// 從 line-messages.json 聚合，計算 R/F/M，分 4 組

const fs = require("fs");
const path = require("path");

// segment 4 組
const SEGMENTS = {
  vip: { label: "🔥 VIP", color: "#B08D57", desc: "高頻 + 詢價多 + 最近活躍" },
  active: { label: "💚 活躍客", color: "#3ddc84", desc: "最近 14 天有對話" },
  new: { label: "🆕 新客", color: "#4285F4", desc: "首次聯絡 ≤ 14 天" },
  atrisk: { label: "😴 潛在流失", color: "#ff6b6b", desc: "超過 30 天沒聯絡" },
};

// 意圖分數（用來估算潛在價值，當作 M 替代）
const INTENT_VALUE = {
  price: 5,        // 詢價最高分
  gifting: 4,      // 送禮也是高意願
  pickup: 3,       // 取貨表示已下單
  product: 2,      // 一般產品問題
  storage: 1,      // 保存問題（已買）
  complaint: 1,    // 抱怨（要小心處理但仍是客人）
  other: 1,
};

function loadMessages(dataDir) {
  const file = path.join(dataDir, "line-messages.json");
  if (!fs.existsSync(file)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function loadCustomerProfiles(dataDir) {
  const file = path.join(dataDir, "customer-profiles.json");
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch (e) {
    return {};
  }
}

function saveCustomerProfiles(dataDir, profiles) {
  const file = path.join(dataDir, "customer-profiles.json");
  fs.writeFileSync(file, JSON.stringify(profiles, null, 2));
}

function daysBetween(t1, t2) {
  return Math.floor((new Date(t2).getTime() - new Date(t1).getTime()) / (24 * 3600 * 1000));
}

// 把 messages 聚合成 customers
function aggregateCustomers(messages, profiles = {}) {
  const byUser = {};
  const now = Date.now();
  for (const m of messages) {
    if (!m.userId) continue;
    if (!byUser[m.userId]) {
      byUser[m.userId] = {
        userId: m.userId,
        userName: m.userName || m.userId.slice(0, 12),
        firstMessageAt: m.timestamp,
        lastMessageAt: m.timestamp,
        messageCount: 0,
        intents: {},
        messages: [],
        replied: 0,
      };
    }
    const c = byUser[m.userId];
    c.messageCount++;
    if (m.replied) c.replied++;
    if (m.timestamp < c.firstMessageAt) c.firstMessageAt = m.timestamp;
    if (m.timestamp > c.lastMessageAt) c.lastMessageAt = m.timestamp;
    const intent = m.intent || "other";
    c.intents[intent] = (c.intents[intent] || 0) + 1;
    c.messages.push({ id: m.id, text: m.text, intent, timestamp: m.timestamp, replied: m.replied, replyText: m.replyText });
  }

  // 計算 R/F/M + segment
  const customers = Object.values(byUser).map(c => {
    const recencyDays = Math.floor((now - new Date(c.lastMessageAt).getTime()) / (24 * 3600 * 1000));
    const ageDays = Math.floor((now - new Date(c.firstMessageAt).getTime()) / (24 * 3600 * 1000));
    const frequency = c.messageCount;
    // M = 意圖分數加權
    let monetary = 0;
    for (const [intent, count] of Object.entries(c.intents)) {
      monetary += (INTENT_VALUE[intent] || 1) * count;
    }
    // 分組邏輯
    let segment;
    if (ageDays <= 14 && frequency <= 3) {
      segment = "new";
    } else if (recencyDays > 30) {
      segment = "atrisk";
    } else if (frequency >= 5 && monetary >= 15 && recencyDays <= 14) {
      segment = "vip";
    } else if (recencyDays <= 14) {
      segment = "active";
    } else {
      segment = "atrisk";
    }
    // 拉 saved profile (AI 畫像)
    const profile = profiles[c.userId] || {};
    return {
      ...c,
      recencyDays,
      ageDays,
      frequency,
      monetary,
      segment,
      aiProfile: profile.aiProfile || null,
      tags: profile.tags || [],
      profileUpdatedAt: profile.updatedAt || null,
      messages: c.messages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
    };
  });
  // 排序：VIP / Active / New 越近越前；At-risk 越久越前
  customers.sort((a, b) => {
    const order = { vip: 0, active: 1, new: 2, atrisk: 3 };
    if (order[a.segment] !== order[b.segment]) return order[a.segment] - order[b.segment];
    return new Date(b.lastMessageAt) - new Date(a.lastMessageAt);
  });
  return customers;
}

// 統計分組數
function groupBySegment(customers) {
  const groups = { vip: [], active: [], new: [], atrisk: [] };
  for (const c of customers) {
    if (groups[c.segment]) groups[c.segment].push(c);
  }
  return groups;
}

module.exports = {
  SEGMENTS,
  loadMessages,
  loadCustomerProfiles,
  saveCustomerProfiles,
  aggregateCustomers,
  groupBySegment,
  daysBetween,
};
