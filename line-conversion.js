// line-conversion.js — LINE 對話成交 → Meta CAPI Purchase event
//
// 流程：
//   1. 老闆/客服在 LINE 對話結束時收到 Flex Message（3 按鈕：✅成交 / ⏰待追 / ❌沒成交）
//   2. 按「成交」會跳兩段 postback：先選「商品類別」→ 再輸入金額
//   3. server 接到完整 payload → 寫入 data/line-orders.json
//   4. 推 Meta CAPI Purchase event → LEON 廣告演算法收到真實成交數據
//   5. 加入決策卡 history（DEX 報表 + VICTOR 簡報用）
//
// 環境變數需求：
//   META_PIXEL_ID, META_CAPI_TOKEN（已在 Render 設好）
//   LINE_CHANNEL_ACCESS_TOKEN（已設）
//   ADMIN_LINE_USER_ID（已設，用於通知）

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'line-orders.json');
const PENDING_FILE = path.join(DATA_DIR, 'line-conversion-pending.json');

const metaCapi = (() => { try { return require('./meta-capi'); } catch { return null; } })();
const decisions = (() => { try { return require('./decisions'); } catch { return null; } })();

// ============================================================
// File I/O
// ============================================================
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadOrders() {
  ensureDir();
  if (!fs.existsSync(ORDERS_FILE)) return { orders: [] };
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch { return { orders: [] }; }
}
function saveOrders(state) {
  ensureDir();
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(state, null, 2));
}
function loadPending() {
  ensureDir();
  if (!fs.existsSync(PENDING_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch { return {}; }
}
function savePending(state) {
  ensureDir();
  fs.writeFileSync(PENDING_FILE, JSON.stringify(state, null, 2));
}
function genOrderId() {
  return 'order_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

// ============================================================
// Meta CAPI Purchase Event
// ============================================================
async function sendPurchaseToMeta(order) {
  if (!metaCapi || typeof metaCapi.sendPurchase !== 'function') {
    console.warn('[line-conversion] meta-capi.sendPurchase 不可用');
    return { ok: false, reason: 'no meta-capi.sendPurchase' };
  }
  try {
    const r = await metaCapi.sendPurchase({
      contact_id: order.line_user_id || order.contact_id || '',
      name: order.customer_name,
      email: order.email,
      phone: order.phone,
      value: order.amount,
      currency: order.currency || 'TWD',
      content_name: order.product_name || order.category,
      content_category: order.category,
      event_id: order.id,
    });
    return { ok: true, response: r };
  } catch (e) {
    console.error('[line-conversion] CAPI Purchase 失敗:', e.message);
    return { ok: false, error: e.message };
  }
}

// ============================================================
// 紀錄一筆成交
// ============================================================
async function recordConversion(payload) {
  const order = {
    id: genOrderId(),
    created_at: new Date().toISOString(),
    line_user_id: payload.line_user_id || null,
    contact_id: payload.contact_id || null,
    customer_name: payload.customer_name || '',
    email: payload.email || '',
    phone: payload.phone || '',
    amount: Number(payload.amount) || 0,
    currency: payload.currency || 'TWD',
    product_name: payload.product_name || '',
    category: payload.category || 'course',
    note: payload.note || '',
    source: payload.source || 'line',
    capi_status: 'pending',
  };

  // 1. 寫入本地 log
  const state = loadOrders();
  state.orders.push(order);
  if (state.orders.length > 5000) state.orders = state.orders.slice(-5000);
  saveOrders(state);

  // 2. 推 Meta CAPI
  const capiResult = await sendPurchaseToMeta(order);
  order.capi_status = capiResult.ok ? 'sent' : 'failed';
  order.capi_error = capiResult.error || null;
  saveOrders(state);

  // 3. 加進決策卡 history（給 DEX/VICTOR 看）
  if (decisions && typeof decisions.addPending === 'function') {
    try {
      await decisions.addPending({
        title: '💰 成交 NT$ ' + order.amount.toLocaleString() + ' — ' + (order.product_name || order.category),
        recommendation: capiResult.ok
          ? '✅ 已自動回傳 Meta CAPI，LEON 演算法已收到'
          : '⚠️ Meta CAPI 失敗：' + (capiResult.error || '未知'),
        source: 'line-conversion',
        metadata: {
          type: 'order',
          orderId: order.id,
          amount: order.amount,
          category: order.category,
        },
      });
    } catch (e) {
      console.error('[line-conversion] decisions push 失敗:', e.message);
    }
  }

  return { ok: true, order, capi: capiResult };
}

// ============================================================
// 待補金額：當老闆按「成交」但還沒輸入金額時暫存
// ============================================================
function setPending(lineUserId, data) {
  const all = loadPending();
  all[lineUserId] = Object.assign({}, all[lineUserId] || {}, data, { updated_at: Date.now() });
  savePending(all);
  return all[lineUserId];
}
function getPending(lineUserId) {
  const all = loadPending();
  return all[lineUserId] || null;
}
function clearPending(lineUserId) {
  const all = loadPending();
  delete all[lineUserId];
  savePending(all);
}

// ============================================================
// 統計（給早安簡報 / DEX 用）
// ============================================================
function getMonthStats({ year, month } = {}) {
  const state = loadOrders();
  const now = new Date();
  const y = year || now.getFullYear();
  const m = month || (now.getMonth() + 1);
  const orders = state.orders.filter(o => {
    const d = new Date(o.created_at);
    return d.getFullYear() === y && (d.getMonth() + 1) === m;
  });
  const total = orders.reduce((s, o) => s + (o.amount || 0), 0);
  const byCategory = {};
  orders.forEach(o => {
    byCategory[o.category] = (byCategory[o.category] || 0) + (o.amount || 0);
  });
  return {
    year: y,
    month: m,
    order_count: orders.length,
    total_revenue: total,
    avg_order_value: orders.length > 0 ? Math.round(total / orders.length) : 0,
    by_category: byCategory,
  };
}

function getRecentOrders(limit = 20) {
  const state = loadOrders();
  return state.orders.slice(-limit).reverse();
}

function getTodayStats() {
  const state = loadOrders();
  const today = new Date().toISOString().slice(0, 10);
  const todays = state.orders.filter(o => (o.created_at || '').startsWith(today));
  return {
    count: todays.length,
    revenue: todays.reduce((s, o) => s + (o.amount || 0), 0),
    orders: todays,
  };
}

// ============================================================
// LINE Flex Message：對話結束三按鈕
// ============================================================
function buildConversionFlex({ contactName = '這位客戶', contactId = '', lineUserId = '' } = {}) {
  return {
    type: 'flex',
    altText: '對話結束 — 標記成交結果',
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#6B4226',
        paddingAll: 'md',
        contents: [
          { type: 'text', text: '對話結束', size: 'xs', color: '#F2E5D5' },
          { type: 'text', text: contactName, weight: 'bold', size: 'lg', color: '#FFFFFF', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: '請標記這次對話的結果：', size: 'sm', color: '#666666' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#4CAF50',
            action: {
              type: 'postback',
              label: '✅ 成交（選類別）',
              data: 'action=conv_won_step1&cid=' + encodeURIComponent(contactId) + '&luid=' + encodeURIComponent(lineUserId),
              displayText: '✅ 對話成交',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'postback',
              label: '⏰ 待追蹤',
              data: 'action=conv_followup&cid=' + encodeURIComponent(contactId),
              displayText: '⏰ 之後再追',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'postback',
              label: '❌ 未成交',
              data: 'action=conv_lost&cid=' + encodeURIComponent(contactId),
              displayText: '❌ 沒成交',
            },
          },
        ],
      },
    },
  };
}

// 第二步：選類別
function buildCategoryPicker({ contactId = '', lineUserId = '' } = {}) {
  const cats = [
    { label: '🍰 費南雪禮盒', value: 'financier-box' },
    { label: '🎁 客製禮盒', value: 'custom-gift' },
    { label: '🎁 婚禮喜餅', value: 'wedding-gift' },
    { label: '🛍️ 商品/工具', value: 'product' },
    { label: '📦 其他', value: 'other' },
  ];
  return {
    type: 'flex',
    altText: '選擇商品類別',
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: '步驟 2／3', size: 'xs', color: '#888888' },
          { type: 'text', text: '這筆是哪一類？', weight: 'bold', size: 'lg', color: '#6B4226' },
          { type: 'separator', margin: 'md' },
          ...cats.map(c => ({
            type: 'button',
            style: 'secondary',
            margin: 'sm',
            action: {
              type: 'postback',
              label: c.label,
              data: 'action=conv_won_step2&cat=' + encodeURIComponent(c.value) + '&cid=' + encodeURIComponent(contactId) + '&luid=' + encodeURIComponent(lineUserId),
              displayText: c.label,
            },
          })),
        ],
      },
    },
  };
}

// 第三步：請輸入金額（純文字提示）
function buildAmountPrompt() {
  return {
    type: 'text',
    text: '步驟 3／3：請直接輸入成交金額（純數字，例：38000）。\n\n10 分鐘內未輸入會自動取消這筆。',
  };
}

module.exports = {
  recordConversion,
  setPending,
  getPending,
  clearPending,
  getMonthStats,
  getRecentOrders,
  getTodayStats,
  buildConversionFlex,
  buildCategoryPicker,
  buildAmountPrompt,
  loadOrders,
};
