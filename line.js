// ============================================================
// MACARON DE LUXE · LINE Messaging API Client (T4.5 / T4.6)
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

// 字串→text message、物件直接 pass through
function normalize(messages) {
  const arr = Array.isArray(messages) ? messages : [messages];
  return arr.map(m => typeof m === "string" ? { type: "text", text: m } : m);
}

async function replyMessage(replyToken, messages) {
  if (!replyToken) throw new Error("replyToken required");
  return await linePost("/message/reply", {
    replyToken,
    messages: normalize(messages),
  });
}

async function pushMessage(to, messages) {
  if (!to) throw new Error("to (userId) required");
  return await linePost("/message/push", {
    to,
    messages: normalize(messages),
  });
}

async function broadcastMessage(messages) {
  return await linePost("/message/broadcast", {
    messages: normalize(messages),
  });
}

async function getUserProfile(userId) {
  if (!userId) throw new Error("userId required");
  return await lineGet(`/profile/${userId}`);
}

async function getBotStatus() {
  try { return await lineGet("/info"); } catch (e) { return null; }
}

// -------- Message builders (T4.6) --------

function textMessage(text) {
  return { type: "text", text: String(text).slice(0, 5000) };
}

function imageMessage(originalContentUrl, previewImageUrl) {
  return {
    type: "image",
    originalContentUrl,
    previewImageUrl: previewImageUrl || originalContentUrl,
  };
}

// Buttons Template（帶連結按鈕；text 有圖片時上限 60 字、無圖 160 字）
function buttonsMessage({ text, imageUrl, title, actions, altText }) {
  const template = {
    type: "buttons",
    text: String(text || "點此查看").slice(0, imageUrl ? 60 : 160),
    actions: (actions || []).slice(0, 4).map(a => ({
      type: "uri",
      label: String(a.label || "打開").slice(0, 20),
      uri: a.uri,
    })),
  };
  if (imageUrl) template.thumbnailImageUrl = imageUrl;
  if (title) template.title = String(title).slice(0, 40);
  return {
    type: "template",
    altText: String(altText || text || "訊息").slice(0, 400),
    template,
  };
}

// 統一建訊息陣列：text + 圖片 + 按鈕連結
function buildMessages({ text, imageUrl, linkUrl, linkLabel }) {
  const msgs = [];
  if (text && text.trim().length > 0) msgs.push(textMessage(text));
  if (imageUrl) msgs.push(imageMessage(imageUrl));
  if (linkUrl) {
    msgs.push(buttonsMessage({
      text: linkLabel || text || "點此查看",
      actions: [{ label: linkLabel || "打開連結", uri: linkUrl }],
      altText: linkLabel || text || "連結",
    }));
  }
  // LINE 單次 push/reply/broadcast 最多 5 則
  return msgs.slice(0, 5);
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
  buttonsMessage,
  buildMessages,
  linePost,
  lineGet,
};
