// customer-profiler.js — AI 客戶畫像系統 (MACARON DE LUXE 版)
//
// 流程：每一條客戶訊息進來（LINE webhook / SaleSmartly webhook） →
//      呼叫 Claude Haiku 自動分析 (約 0.5-1 秒) →
//      累積成 customer_profiles.json 的客戶畫像 →
//      後續這位客戶再來，AI 員工（VICTOR / LEON / NOVA）就能看到他的歷史意圖、喜好、購買階段
//
// 業態：MACARON DE LUXE 台灣精品馬卡龍品牌
//   - 主力商品：禮盒 NT$480–2,280（6 入 NT$880 / 12 入 NT$1,580 是核心）
//   - 4 家門店 + 線上訂購
//   - TA：25–40 歲女性、職業 OL、送禮需求
//
// 環境變數：
//   ANTHROPIC_API_KEY     — Claude API key
//   RENDER_DISK_MOUNT_PATH 或 DATA_DIR — 資料存放路徑（預設 ./data）

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, 'data');
const PROFILES_FILE = path.join(DATA_DIR, 'customer_profiles.json');
const ANALYSIS_LOG = path.join(DATA_DIR, 'message_analysis.jsonl');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

let anthropic = null;
function getClient() {
  if (!anthropic && process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadProfiles() {
  try {
    ensureDir();
    if (!fs.existsSync(PROFILES_FILE)) return {};
    return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
  } catch { return {}; }
}

function saveProfiles(profiles) {
  ensureDir();
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
}

// ============================================================
// 核心：用 Haiku 分析單一訊息
// ============================================================
async function analyzeMessage({ msg, channel, prevProfile }) {
  const client = getClient();
  if (!client) return null;
  if (!msg || typeof msg !== 'string' || !msg.trim()) return null;

  const ctx = prevProfile ? `\n\n[該客人之前的畫像]\n類型：${prevProfile.latest?.customer_type || '未知'}\n上次意圖：${prevProfile.latest?.intent || ''}\n上次興趣品項：${(prevProfile.latest?.products_interested || []).join('、') || '—'}` : '';

  const prompt = `你是 MACARON DE LUXE 的 CRM 分析師。請分析一個客人傳進來的訊息，輸出 JSON。

MACARON DE LUXE 業態：
- 台灣精品馬卡龍品牌，定位法式高端禮贈
- 商品：禮盒 NT$480–2,280（6 入 NT$880 / 12 入 NT$1,580 是核心）
- 4 家門店（台北中山 / 台中 / 高雄 等）+ 線上宅配
- 客群：25–40 歲女性 / OL / 送禮 / 婚禮小物 / 企業禮贈
- 客製化：可訂製 logo、印字、客製口味、企業包裝

⚠️ 客戶類型判斷：
- 個人送禮 / 自用 → personal
- 婚禮小物（喜餅、二進、迎賓）→ wedding
- 企業禮贈 / 大量訂購 → corporate
- 純詢問 / 不明 → unknown

[訊息來源]：${channel || 'unknown'}
[客人訊息]："${String(msg).slice(0, 600)}"${ctx}

請輸出以下 JSON（不含 markdown、不含註解）:
{
  "customer_type": "personal|wedding|corporate|unknown",
  "intent": "兩三個字: 禮盒詢問|客製化|大量訂購|門市資訊|宅配時間|過敏成分|價格詢問|預訂|催單|客訴|其他",
  "products_interested": ["6入禮盒|12入禮盒|客製禮盒|單顆|限定口味|婚禮小物|企業禮贈"],
  "stage": "初步認識|評估考慮|決定下單|已下單|已收貨|回購|流失",
  "urgency": "高|中|低",
  "sentiment": "正面|中性|負面",
  "estimated_value_ntd": "預估這筆訂單金額（整數，無法判斷給 0）",
  "key_questions": ["主要疑問。最多3個"],
  "ad_attribution_hint": "看到廣告|FB|IG|朋友介紹|搜尋|店面路過|無提到",
  "next_action": "我方今天該對這人做什麼。一句話"
}`;

  try {
    const r = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = r.content?.[0]?.text || '';
    const cleaned = text.replace(/^\s*```json\s*/i, '').replace(/^\s*```\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!['personal','wedding','corporate','unknown'].includes(parsed.customer_type)) parsed.customer_type = 'unknown';
    return parsed;
  } catch (e) {
    console.error('[customer-profiler] analysis error:', e.message);
    return null;
  }
}

// ============================================================
// 更新客戶畫像（含歷史聚合）
// ============================================================
async function updateProfile({ chat_user_id, channel, msg, user_name, channel_id }) {
  if (!chat_user_id) return null;
  const profiles = loadProfiles();
  const prev = profiles[chat_user_id] || {
    msg_count: 0,
    history_intents: {},
    history_products: {},
    history_types: {},
    first_seen: new Date().toISOString()
  };

  const analysis = await analyzeMessage({ msg, channel, prevProfile: prev });
  const nowIso = new Date().toISOString();

  // 累積歷史
  if (analysis) {
    if (analysis.intent) prev.history_intents[analysis.intent] = (prev.history_intents[analysis.intent] || 0) + 1;
    if (analysis.customer_type) prev.history_types[analysis.customer_type] = (prev.history_types[analysis.customer_type] || 0) + 1;
    for (const p of (analysis.products_interested || [])) {
      prev.history_products[p] = (prev.history_products[p] || 0) + 1;
    }
  }

  const updated = {
    ...prev,
    chat_user_id,
    user_name: user_name || prev.user_name || null,
    channel: channel || prev.channel || null,
    channel_id: channel_id || prev.channel_id || null,
    msg_count: (prev.msg_count || 0) + 1,
    last_seen: nowIso,
    latest: analysis || prev.latest || null
  };

  profiles[chat_user_id] = updated;
  saveProfiles(profiles);

  // 寫 jsonl log（方便事後分析）
  try {
    ensureDir();
    fs.appendFileSync(ANALYSIS_LOG, JSON.stringify({
      ts: nowIso, chat_user_id, channel, msg_preview: String(msg).slice(0, 80), analysis
    }) + '\n');
  } catch {}

  return updated;
}

// ============================================================
// 聚合 insights — 給 AI 員工用 / 給儀表板用
// ============================================================
function getAggregatedInsights({ topN = 10, type = null } = {}) {
  const profiles = loadProfiles();
  const list = Object.values(profiles);
  const filtered = type ? list.filter(p => (p.latest?.customer_type) === type) : list;

  const intentCount = {}, productCount = {}, stageCount = {}, attribCount = {};
  for (const p of filtered) {
    for (const [k, v] of Object.entries(p.history_intents || {})) intentCount[k] = (intentCount[k] || 0) + v;
    for (const [k, v] of Object.entries(p.history_products || {})) productCount[k] = (productCount[k] || 0) + v;
    const s = p.latest?.stage; if (s) stageCount[s] = (stageCount[s] || 0) + 1;
    const a = p.latest?.ad_attribution_hint; if (a) attribCount[a] = (attribCount[a] || 0) + 1;
  }
  const topOf = obj => Object.entries(obj).sort((a,b) => b[1]-a[1]).slice(0, topN).map(([k,v]) => ({ key: k, count: v }));
  return {
    ok: true,
    total_customers: filtered.length,
    type_filter: type,
    top_intents: topOf(intentCount),
    top_products: topOf(productCount),
    stage_breakdown: topOf(stageCount),
    ad_attribution: topOf(attribCount)
  };
}

// ============================================================
// 把 insights 格式化成可塞 AI 員工 system prompt 的字串
// ============================================================
function formatInsightsForPrompt(type = null) {
  const ins = getAggregatedInsights({ topN: 5, type });
  if (!ins.total_customers) return '（暫無客戶畫像資料）';
  const lines = [];
  lines.push(`[客戶畫像快照 · ${ins.total_customers} 位${type?'（'+type+'）':''}客戶]`);
  if (ins.top_intents.length) lines.push('Top 意圖: ' + ins.top_intents.map(x => x.key + '(' + x.count + ')').join(', '));
  if (ins.top_products.length) lines.push('Top 興趣品項: ' + ins.top_products.map(x => x.key + '(' + x.count + ')').join(', '));
  if (ins.stage_breakdown.length) lines.push('購買階段分布: ' + ins.stage_breakdown.map(x => x.key + '(' + x.count + ')').join(', '));
  if (ins.ad_attribution.length) lines.push('歸因來源: ' + ins.ad_attribution.map(x => x.key + '(' + x.count + ')').join(', '));
  return lines.join('\n');
}

module.exports = {
  loadProfiles,
  saveProfiles,
  analyzeMessage,
  updateProfile,
  getAggregatedInsights,
  formatInsightsForPrompt,
};
