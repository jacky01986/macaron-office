// auto-publish.js — 自動產文 → 拍板 → 發佈 IG/FB
// 流程：
//   1. 每天 10:00 cron → Claude 寫 IG + FB 草稿
//   2. 草稿存到 data/auto-drafts.json + push 到 decisions 待審清單
//   3. 早安簡報列出來等你 1ok / 1no
//   4. 每 5 分鐘 cron 檢查 decisions.history → 已 1ok 的 → 自動發佈

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DRAFTS_FILE = path.join(DATA_DIR, 'auto-drafts.json');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch {}

const decisions = (() => { try { return require('./decisions'); } catch { return null; } })();
const customers = (() => { try { return require('./customers'); } catch { return null; } })();
const salesmartly = (() => { try { return require('./salesmartly'); } catch { return null; } })();

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
    ? '你是 CAMILLE — Macaron de Luxe 的 IG 文案企劃。寫一篇 IG 貼文，主題環繞美甲/美容課程。' +
      '風格：溫暖、療癒、誠懇。長度 80-120 字。最後加 5-8 個相關 hashtag。用繁體中文。'
    : '你是 CAMILLE — Macaron de Luxe 的 FB 文案企劃。寫一篇 FB 貼文，主題環繞美甲/美容課程或品牌故事。' +
      '風格：親切、有條理、引導行動。長度 100-180 字，結尾加 1 個 CTA。用繁體中文。';
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
    };
    generated.push(draft);
    if (decisions && decisions.addPending) {
      try {
        const dec = await decisions.addPending({
          title: '📱 ' + platform + ' 草稿：' + caption.slice(0, 30) + (caption.length > 30 ? '...' : ''),
          recommendation: '建議發佈（VICTOR/CAMILLE 已預覽）',
          source: 'auto-publish',
          metadata: { type: 'auto-draft', draftId: draft.id, platform },
        });
        draft.decisionId = dec.id;
      } catch (e) {
        console.error('[auto-publish] add to decisions failed:', e.message);
      }
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
        const r = await publishFB(draft.caption);
        draft.status = 'published';
        draft.published_at = new Date().toISOString();
        draft.publish_id = r.id;
        publishedThis++;
        console.log('[auto-publish] FB published:', r.id);
      } else if (draft.platform === 'IG') {
        draft.status = 'needs-image';
        draft.note = 'IG 需要圖片才能發佈，請手動到 IG 貼文 + 把這份草稿的 caption 貼上';
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
  cron.schedule('0 10 * * *', generateAndQueueDrafts, { timezone: tz });
  cron.schedule('*/5 * * * *', processDecidedDrafts, { timezone: tz });
  console.log('[auto-publish] cron jobs registered (drafts daily 10:00, publish every 5min)');
}

module.exports = {
  generateAndQueueDrafts,
  processDecidedDrafts,
  publishFB,
  publishIG,
  registerCronJobs,
  loadDrafts,
};
