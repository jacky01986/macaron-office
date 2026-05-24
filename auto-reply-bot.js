// auto-reply-bot.js — Auto-Smart Reply for Messenger
// AI replies within 5 seconds before human takes over
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

const REPLIED_FILE = path.join(DATA_DIR, 'auto_replied.json');
const LOG_FILE = path.join(DATA_DIR, 'auto_reply_log.jsonl');

function loadReplied() {
  try { return JSON.parse(fs.readFileSync(REPLIED_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveReplied(obj) {
  try { fs.writeFileSync(REPLIED_FILE, JSON.stringify(obj)); } catch (e) {}
}
function appendLog(entry) {
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n'); } catch (e) {}
}

function getLog(n) {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

// Get page access token from /me/accounts
async function getPageToken(pageId) {
  const userToken = process.env.META_USER_TOKEN || process.env.FB_USER_TOKEN;
  if (!userToken) throw new Error('META_USER_TOKEN not set');
  const url = 'https://graph.facebook.com/v19.0/me/accounts?fields=id,name,access_token&access_token=' + encodeURIComponent(userToken);
  const resp = await fetch(url);
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message);
  const page = (json.data || []).find(p => String(p.id) === String(pageId));
  if (!page) throw new Error('Page ' + pageId + ' not in /me/accounts');
  return { token: page.access_token, name: page.name };
}

async function generateReply(customerMessage, pageName) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const sysPrompt = [
    '你是 MACARON DE LUXE（' + pageName + ' 粉專）的客服 AI。',
    '回覆規則：',
    '1. 親切、專業、簡短（80 字內）',
    '2. 報價只給「禮盒區間 NT$880-2,280」級別資訊,具體要請客人到店或私訊詳談',
    '3. 結尾一定要 CTA：邀請對方留下「想做的項目」與「方便的時段」',
    '4. 適度使用 ❤️ 或 ✨ 但不過量（每則最多 1 個）',
    '5. 不要說自己是 AI 或機器人，自稱「我們」',
    '6. 不要承諾甜點功效(避免食品法規問題)',
    '7. 不要回覆敏感問題（醫療、法律、退款糾紛），改為「請稍候老師回覆」',
    '8. 用繁體中文（台灣用詞）',
    '9. 不要使用 markdown 格式',
    '10. 如果是純表情、貼圖、單字（如「在嗎」「？」），就回「您好 🥐 在喔～請問您想了解禮盒、單顆,還是企業客製呢?」'
  ].join('\n');
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: sysPrompt,
    messages: [{ role: 'user', content: customerMessage }]
  });
  return resp.content[0].text.trim();
}

async function sendMessage(pageId, pageToken, recipientId, messageText) {
  const url = 'https://graph.facebook.com/v19.0/me/messages?access_token=' + encodeURIComponent(pageToken);
  const body = {
    messaging_type: 'RESPONSE',
    recipient: { id: recipientId },
    message: { text: messageText }
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message);
  return json;
}

async function handleMessageEvent(entry) {
  const pageId = entry.id;
  if (!entry.messaging) return;
  for (const event of entry.messaging) {
    try {
      const senderId = event.sender && event.sender.id;
      const msg = event.message;
      if (!msg) continue;
      if (msg.is_echo) continue;
      if (!msg.text) continue;
      if (!senderId || String(senderId) === String(pageId)) continue;
      const replied = loadReplied();
      const key = pageId + '_' + senderId;
      const last = replied[key] || 0;
      if (Date.now() - last < 24 * 3600 * 1000) {
        continue;
      }
      const { token: pageToken, name: pageName } = await getPageToken(pageId);
      const reply = await generateReply(msg.text, pageName);
      await sendMessage(pageId, pageToken, senderId, reply);
      replied[key] = Date.now();
      saveReplied(replied);
      appendLog({
        ts: new Date().toISOString(),
        pageId,
        pageName,
        senderId,
        incoming: msg.text,
        reply
      });

      // Send Lead event to Meta Conversions API
      try {
        const capi = require('./meta-capi');
        const capiResult = await capi.sendLeadEvent({
          pageId,
          senderId,
          message: msg.text,
          eventTimeMs: Date.now()
        });
        if (capiResult && capiResult.ok) {
          console.log('[capi] sent', capiResult.tier, 'lead for', senderId, '($' + capiResult.value + ')');
        }
      } catch (capiErr) {
        console.error('[capi]', capiErr.message);
      }
      console.log('[auto-reply] replied to', senderId, 'on', pageName, ':', reply.slice(0, 50));
    } catch (e) {
      console.error('[auto-reply event]', e.message);
    }
  }
}

async function subscribeMessages() {
  const userToken = process.env.META_USER_TOKEN || process.env.FB_USER_TOKEN;
  if (!userToken) throw new Error('META_USER_TOKEN not set');
  const acctUrl = 'https://graph.facebook.com/v19.0/me/accounts?fields=id,name,access_token&access_token=' + encodeURIComponent(userToken);
  const resp = await fetch(acctUrl);
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  const pages = data.data || [];
  const results = [];
  for (const p of pages) {
    try {
      const subUrl = 'https://graph.facebook.com/v19.0/' + p.id + '/subscribed_apps?subscribed_fields=messages,messaging_postbacks&access_token=' + encodeURIComponent(p.access_token);
      const r = await fetch(subUrl, { method: 'POST' });
      const j = await r.json();
      if (j.error) results.push({ pageId: p.id, pageName: p.name, ok: false, error: j.error.message });
      else results.push({ pageId: p.id, pageName: p.name, ok: true });
    } catch (e) {
      results.push({ pageId: p.id, pageName: p.name, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = { handleMessageEvent, subscribeMessages, getLog, sendMessage, generateReply };
