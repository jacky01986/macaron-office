// ============================================================
// MACARON DE LUXE · LINE Messaging API Client (T4.5)
// ============================================================
// Required env vars:
//   LINE_CHANNEL_ACCESS_TOKEN   Long-lived channel access token
//   LINE_CHANNEL_SECRET         For webhook signature verification

const crypto = require("crypto");

const LINE_API = "https://api.line.me/v2/bot";

function tokenOk() {
  return !!process.env.LINE_CHANNEL_ACCESS_TOKEN && !!process.env.LINE_CHANNEL_SECRET;
}

function verifySignature(rawBody, signature) {
  if (!process.env.LINE_CHANNEL_SECRET) return false;
  if (!signature) return false;
  const expected = crypto
    .createHmac("SHA256", process.env.LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (e) {
    return false;
  }
}

async function linePost(path, body) {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN not set");
  const res = await fetch(`${LINE_API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`LINE API error: ${b.message || "HTTP " + res.status}`);
    err.details = b.details || null;
    err.status = res.status;
    throw err;
  }
  return b;
}

async function lineGet(path) {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN not set");
  const res = await fetch(`${LINE_API}${path}`, {
    headers: { "Authorization": `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`LINE API error: ${b.message || "HTTP " + res.status}`);
  return b;
}

// 轉成 LINE 訊息物件（字串→ text message）
function normalize(messages) {
  const arr = Array.isArray(messages) ? messages : [messages];
  return arr.map(m => typeof m === "string" ? { type: "text", text: m } : m);
}

// Reply（只在收到訊息後 30 分鐘內可用、單個 replyToken 限一次、免費）
async function replyMessage(replyToken, messages) {
  if (!replyToken) throw new Error("replyToken required");
  return await linePost("/message/reply", {
    replyToken,
    messages: normalize(messages),
  });
}

// Push（對特定 userId；計入月額度）
async function pushMessage(to, messages) {
  if (!to) throw new Error("to (userId) required");
  return await linePost("/message/push", {
    to,
    messages: normalize(messages),
  });
}

// Broadcast（發給全部好友；計入月額度，且每則 = 好友數 × 1）
async function broadcastMessage(messages) {
  return await linePost("/message/broadcast", {
    messages: normalize(messages),
  });
}

// 取用戶資料（名稱、頭像）
async function getUserProfile(userId) {
  if (!userId) throw new Error("userId required");
  return await lineGet(`/profile/${userId}`);
}

// 目前 bot 狀態（好友數等）
async function getBotStatus() {
  try {
    const info = await lineGet("/info");
    return info;
  } catch (e) {
    return null;
  }
}

// Helper：建立 Flex / image / sticker 訊息
function textMessage(text) {
  return { type: "text", text };
}
function imageMessage(originalContentUrl, previewImageUrl) {
  return { type: "image", originalContentUrl, previewImageUrl: previewImageUrl || originalContentUrl };
}

module.exports = {
  tokenOk,
  verifySignature,
  replyMessage,
  pushMessage,
  broadcastMessage,
  getUserProfile,
  getBotStatus,
  textMessage,
  imageMessage,
  linePost,
  lineGet,
};
