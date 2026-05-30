// auto-publish.js — 自動產文 → 拍板 → 發佈 IG/FB
// 流程：
//   1. 每天 09:00 + 19:00 cron → Claude 寫 IG + FB 草稿
//   2. 草稿存到 data/auto-drafts.json + push 到 decisions 待審清單
//   3. 早安簡報 / Telegram 列出來等你 1ok / 1no
//   4. 每 5 分鐘 cron 檢查 decisions.history → 已 1ok 的 → 自動發佈
//
// ⚙️ 2026-05 政策調整 (Jeffrey 要求):
//   - FB 自動發文「整個關閉」: 即使你回 2ok 也不會自動貼 FB, 只保留草稿等你手動發
//   - 夜間 / 週末不自動發: 只有台北時間「週一~週五 09:00-18:00」才會自動發佈
//   - 這兩個閘門都只擋「發佈」, 不擋「產草稿+Telegram 預覽」

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const DRAFTS_FILE = path.join(DATA_DIR, 'auto-drafts.json');

// ===== 政策開關 =====
// FB 自動發文總開關: 預設關閉(只產草稿,絕不自動貼 FB)。
// 想重新打開就把這行改成 true,或設環境變數 FB_AUTOPUBLISH=on
const FB_AUTOPUBLISH_ENABLED = (process.env.FB_AUTOPUBLISH || 'off').toLowerCase() === 'on';

// 只有台北時間 週一~週五 09:00-18:00 才允許自動發佈
function isPublishWindowOpen() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const day = now.getDay();   // 0=週日, 6=週六
  const hour = now.getHours();
  if (day === 0 || day === 6) return { open: false, reason: '週末不自動發' };
  if (hour < 9 || hour >= 18) return { open: false, reason: '非營業時段(09:00-18:00)不自動發' };
  return { open: true };
}

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch {}

const decisions = (() => { try { return require('./decisions'); } catch { return null; } })();
const customers = (() => { try { return require('./customers'); } catch { return null; } })();
const salesmartly = (() => { try { return require('./salesmartly'); } catch { return null; } })();
const imageGen = (() => { try { return require('./image-gen'); } catch { return null; } })();

// Telegram 通知 helper
async function tgSendPhoto(photoUrl, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const resp = await fetch('https://api.telegram.org/bot' + token + '/sendPhoto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, photo: photoUrl, caption: caption.slice(0, 1024), parse_mode: 'HTML' })
    });
    return resp.ok;
  } catch { return false; }
}
async function tgSendText(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const resp = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), parse_mode: 'HTML' })
    });
    return resp.ok;
  } catch { return false; }
}

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadDrafts() {
  ensureDir();
  if (!fs.existsSync(DRAFTS_FILE)) return { drafts: [] };
  try { return JSON.parse(fs.readFileSync(DRAFTS_FILE, 'utf8')); } catch { return { drafts: [] }; }
}
function saveDrafts(state) {
  ensureDir();
  fs.writeFileSync(DRAFTS_FILE, JSON.stringify(state, null, 2));
}
function genId() { return 'draft_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6); }

// 把所有 pending 草稿標記為 dismissed (清空待審 queue,不會再被自動發)
function clearPendingDrafts() {
  const state = loadDrafts();
  let cleared = 0;
  (state.drafts || []).forEach(d => {
    if (d.status === 'pending') { d.status = 'dismissed'; d.dismissed_at = new Date().toISOString(); cleared++; }
  });
  saveDrafts(state);
  return { ok: true, cleared };
}

let client = null;
function getClient() {
  if (client) return client;
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try { client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); }
  catch { client = null; }
  return client;
}

async function generateCaption({ platform, context }) {
  const c = getClient();
  if (!c) return null;
  const sys = platform === 'IG'
    ? '你是 CAMILLE — 溫點 WarmPlace 韓系精品甜點品牌的 IG 文案企劃。品牌名一律寫「溫點 WarmPlace」(絕對不要寫 MACARON DE LUXE 或任何舊品牌)。我們有雙主力:🍬 馬卡龍 + 🍰 費南雪。寫一篇 IG 貼文,主題圍繞:馬卡龍 6/12 入禮盒、費南雪禮盒、馬卡龍+費南雪混合禮盒、客製禮盒、婚禮喜餅、企業禮贈、季節限定口味、品牌故事 等。' +
      '風格:韓系療癒、雋永、留白、像韓系咖啡店文案。長度 80-120 字。最後加 5-8 個相關 hashtag (例: #溫點WarmPlace #warmplacehere #韓系馬卡龍 #精品禮盒 #台南甜點)。用繁體中文。禁用詞:超讚/必吃/CP值/秒殺/小資/親民。禁止出現「MACARON DE LUXE」這個舊品牌名。'
    : '你是 CAMILLE — 溫點 WarmPlace 韓系精品甜點品牌的 FB 文案企劃。品牌名一律寫「溫點 WarmPlace」(絕對不要寫 MACARON DE LUXE 或任何舊品牌)。我們有雙主力:🍬 馬卡龍 + 🍰 費南雪。寫一篇 FB 貼文,主題圍繞:馬卡龍禮盒、費南雪禮盒、雙主力綜合禮盒、客製禮盒、婚禮喜餅、企業禮贈、季節限定、品牌故事 等。' +
      '風格:親切、有條理、引導行動,韓系療癒基調。長度 100-180 字,結尾加 1 個 CTA (例:「📩 私訊預訂」「🌹 線上訂購」)。用繁體中文。禁用詞:超讚/必吃/CP值/秒殺/小資/親民。禁止出現「MACARON DE LUXE」這個舊品牌名。';
  const user = '請寫今天的 ' + platform + ' 貼文。\n\n參考資料：\n' + JSON.stringify(context || {}).slice(0, 1500);
  try {
    const res = await c.messages.create({
      model: MODEL,
      max_tokens: 700,
      system: sys,
      messages: [{ role: 'user', content: user }],
    });
    const block = res.content && res.content[0];
    if (block && block.type === 'text') return block.text.trim();
  } catch (err) {
    console.error('[auto-publish] Claude failed:', err.message);
  }
  return null;
}

async function generateAndQueueDrafts() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[auto-publish] ANTHROPIC_API_KEY not set, skip');
    return { ok: false, reason: 'no api key' };
  }
  const context = {};
  try { if (customers && customers.getSegmentSnapshot) context.customers = await customers.getSegmentSnapshot(); } catch {}
  try {
    if (salesmartly && salesmartly.getCustomerInsights) {
      const r = await salesmartly.getCustomerInsights({ days: 7 });
      if (r && r.ok) context.customer_topics = r.topics;
    }
  } catch {}

  const generated = [];
  for (const platform of ['IG', 'FB']) {
    const caption = await generateCaption({ platform, context });
    if (!caption) continue;
    const draft = {
      id: genId(),
      platform,
      caption,
      status: 'pending',
      created_at: new Date().toISOString(),
      published_at: null,
      image_url: null,
    };

    // ★ IG 一定要圖;FB 順便也產一張(可選不發)
    if (imageGen && process.env.OPENAI_API_KEY) {
      try {
        const img = await imageGen.generateImage({
          caption, brief: caption, platform, slug: platform + '-' + draft.id.slice(-6)
        });
        draft.image_url = img.publicUrl;
        draft.image_filename = img.filename;
        console.log('[auto-publish] ' + platform + ' 生圖完成: ' + img.publicUrl);
      } catch (e) {
        console.error('[auto-publish] 生圖失敗 (' + platform + '):', e.message);
        draft.image_error = e.message;
      }
    }

    generated.push(draft);
    if (decisions && decisions.addPending) {
      try {
        const dec = await decisions.addPending({
          title: '📱 ' + platform + ' 草稿:' + caption.slice(0, 30) + (caption.length > 30 ? '...' : ''),
          recommendation: '建議發佈(CAMILLE 已寫、ARIA 已配圖)',
          source: 'auto-publish',
          metadata: { type: 'auto-draft', draftId: draft.id, platform, imageUrl: draft.image_url },
        });
        draft.decisionId = dec.id;
      } catch (e) {
        console.error('[auto-publish] add to decisions failed:', e.message);
      }
    }

    // ★ Telegram 預覽推送 (有圖就推圖文,無圖只推文字)
    const fbNote = platform === 'FB'
      ? '\n\n────────────\n📝 FB 自動發已關閉 — 這只是草稿。要發請到 ' + (process.env.SITE_URL || 'https://macaron-office.onrender.com') + '/auto-publish.html 手動發佈'
      : '';
    const baseCap = '<b>📱 ' + platform + ' 新草稿</b>\n\n' + caption;
    const tail = platform === 'FB'
      ? fbNote
      : (draft.image_url
          ? '\n\n────────────\n✅ 圖已配好,回覆 <code>1ok</code> 即發布 IG'
          : '\n\n────────────\n⚠️ IG 還缺圖片,到 ' + (process.env.SITE_URL || 'https://macaron-office.onrender.com') + '/auto-publish.html 上傳圖片後再發');
    const previewCaption = baseCap + tail;
    try {
      if (draft.image_url) {
        await tgSendPhoto(draft.image_url, previewCaption);
      } else {
        await tgSendText(previewCaption);
      }
    } catch (e) {
      console.error('[auto-publish] TG 推送失敗:', e.message);
    }
  }
  const state = loadDrafts();
  state.drafts.push(...generated);
  if (state.drafts.length > 50) state.drafts = state.drafts.slice(-50);
  saveDrafts(state);
  console.log('[auto-publish] generated ' + generated.length + ' drafts');
  return { ok: true, generated_count: generated.length, drafts: generated };
}

async function metaGraphPost(endpoint, params = {}) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('META_ACCESS_TOKEN not set');
  const url = 'https://graph.facebook.com/v19.0' + endpoint;
  const body = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => body.append(k, v));
  body.append('access_token', token);
  const res = await fetch(url, { method: 'POST', body });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error('Graph: ' + (j.error?.message || res.status));
  return j;
}

async function publishFB(caption) {
  const pageId = process.env.META_FB_PAGE_ID;
  if (!pageId) throw new Error('META_FB_PAGE_ID not set');
  return metaGraphPost('/' + pageId + '/feed', { message: caption });
}

async function publishIG(caption, imageUrl) {
  const igId = process.env.META_IG_USER_ID;
  if (!igId) throw new Error('META_IG_USER_ID not set');
  if (!imageUrl) throw new Error('IG requires image_url');
  const created = await metaGraphPost('/' + igId + '/media', { image_url: imageUrl, caption });
  return metaGraphPost('/' + igId + '/media_publish', { creation_id: created.id });
}

async function processDecidedDrafts() {
  if (!decisions || !decisions.getAll) return;
  const all = await decisions.getAll();
  const okHistory = (all.history || []).filter(h => h.decision === 'ok' && h.metadata && h.metadata.type === 'auto-draft');
  const state = loadDrafts();
  let publishedThis = 0;
  for (const dec of okHistory) {
    const draftId = dec.metadata && dec.metadata.draftId;
    if (!draftId) continue;
    const draft = state.drafts.find(d => d.id === draftId);
    if (!draft || draft.status !== 'pending') continue;
    try {
      if (draft.platform === 'FB') {
        // 🚫 FB 自動發文已關閉 — 即使你回 2ok 也不自動貼,只標記等你手動發
        if (!FB_AUTOPUBLISH_ENABLED) {
          draft.note = '⏸️ FB 自動發已關閉。要發請到 /auto-publish.html 手動按發佈。';
          continue;
        }
        // 夜間/週末閘門
        const win = isPublishWindowOpen();
        if (!win.open) { draft.note = '⏳ ' + win.reason + ',暫不發,等營業時段。'; continue; }
        const r = await publishFB(draft.caption);
        draft.status = 'published';
        draft.published_at = new Date().toISOString();
        draft.publish_id = r.id;
        publishedThis++;
        console.log('[auto-publish] FB published:', r.id);
        await tgSendText('✅ FB 已發佈\n\n' + draft.caption.slice(0, 200));
      } else if (draft.platform === 'IG') {
        if (!draft.image_url) {
          // 不報錯,只是先把狀態維持為 pending 等待手動上傳
          draft.note = '⏳ IG 等你手動上傳圖片(到 /auto-publish.html 控制台拖圖)';
          continue;
        }
        // 夜間/週末閘門 (IG 也套用)
        const win = isPublishWindowOpen();
        if (!win.open) { draft.note = '⏳ ' + win.reason + ',暫不發,等營業時段。'; continue; }
        const r = await publishIG(draft.caption, draft.image_url);
        draft.status = 'published';
        draft.published_at = new Date().toISOString();
        draft.publish_id = r.id;
        publishedThis++;
        console.log('[auto-publish] IG published:', r.id);
        await tgSendText('✅ IG 已發佈\n\n' + draft.caption.slice(0, 200));
      }
    } catch (e) {
      draft.status = 'failed';
      draft.error = e.message;
      console.error('[auto-publish] publish failed:', e.message);
    }
  }
  if (publishedThis > 0) saveDrafts(state);
  return { processed: okHistory.length, published: publishedThis };
}

function registerCronJobs(cron) {
  if (!cron || typeof cron.schedule !== 'function') return;
  const tz = process.env.TZ || 'Asia/Taipei';
  // 早上 09:00 + 晚上 19:00 雙峰時段,Telegram 預覽推送讓你看(只產草稿,不自動發)
  cron.schedule('0 9 * * *', generateAndQueueDrafts, { timezone: tz });
  cron.schedule('0 19 * * *', generateAndQueueDrafts, { timezone: tz });
  // 每 5 分鐘掃決策清單,看有 1ok 就發(FB 已關閉,IG 限營業時段)
  cron.schedule('*/5 * * * *', processDecidedDrafts, { timezone: tz });
  console.log('[auto-publish] cron jobs registered (drafts 09:00 + 19:00 daily, publish check every 5min; FB auto-publish=' + FB_AUTOPUBLISH_ENABLED + ')');
}

module.exports = {
  generateAndQueueDrafts,
  processDecidedDrafts,
  publishFB,
  publishIG,
  registerCronJobs,
  loadDrafts,
  clearPendingDrafts,
  isPublishWindowOpen,
  FB_AUTOPUBLISH_ENABLED,
};
