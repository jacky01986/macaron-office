// scout.js — SCOUT 全球市場調查員 + DISTILL 情報精煉
//
// 流程：
//   1. SCOUT scoutScanAll() — 對 8 個業務領域用 web_search 蒐集競品（Sonnet）
//   2. distillIntelligence() — 用 Opus 把 8 個報告精煉成「市場情報」
//   3. 所有 AI 員工 require ./scout 拿 getContextForOtherAgents()
//   4. 每週一 08:00 自動跑 SCAN → DISTILL，09:00 VICTOR 簡報用最新情報

const fs = require('fs');
const path = require('path');
const Anthropic = (() => { try { return require('@anthropic-ai/sdk').default; } catch { return null; } })();
const { BUSINESS_CONTEXT } = require('./business-context');

// 預設用 Sonnet 4.6 跑 SCOUT（避開 Opus rate limit 30K/min）
const SCOUT_MODEL = process.env.SCOUT_MODEL || 'claude-sonnet-4-6';
// DISTILL 用 Opus 4.6（synthesis 需要更深度）
const DISTILL_MODEL = process.env.DISTILL_MODEL || 'claude-opus-4-6';

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const SCOUT_FILE = path.join(DATA_DIR, 'scout-reports.json');
const INTEL_FILE = path.join(DATA_DIR, 'market-intelligence.json');

// 服務間延遲（避免 rate limit）
const INTER_SERVICE_DELAY_MS = 20000;
// 429 重試
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 30000;

const SERVICES = [
  { id: 'macaron_gift_box', name: '馬卡龍禮盒', search_terms: '馬卡龍 6入 12入 法式 精品' },
  { id: 'financier_gift_box', name: '費南雪禮盒', search_terms: '費南雪 financier 法式 杏仁小蛋糕 禮盒' },
  { id: 'combo_gift', name: '馬卡龍+費南雪 綜合禮盒', search_terms: '馬卡龍 費南雪 綜合禮盒 雙主力' },
  { id: 'custom_gift', name: '客製禮盒', search_terms: '馬卡龍 費南雪 客製禮盒 婚禮 企業' },
  { id: 'wedding_gift', name: '婚禮小物', search_terms: '婚禮 馬卡龍 費南雪 喜餅 小物' },
  { id: 'corporate_gift', name: '企業禮贈', search_terms: '企業禮贈 高端甜點 客戶禮' },
  { id: 'french_competitor', name: '法式品牌競品', search_terms: '法朋 亞尼克 Paul Ladurée Pierre Hermé 法式甜點 費南雪' },
  { id: 'luxury_brand', name: '高端品牌策略', search_terms: '精品法式甜點 馬卡龍 費南雪 品牌策略' },
];

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadJson(file, fallback) {
  ensureDir();
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, data) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
function loadReports() { return loadJson(SCOUT_FILE, { reports: {}, last_run: null, runs: [] }); }
function saveReports(s) { saveJson(SCOUT_FILE, s); }

function getClient() {
  if (!Anthropic) return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({ apiKey });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const SCOUT_SYSTEM = BUSINESS_CONTEXT + '\n\n' + `你是 SCOUT，溫點 WarmPlace 的全球市場調查員。

任務：用 web_search 蒐集網路上「指定業務領域」的競品（法式甜點品牌）。
搜全球，重點：台灣、馬來西亞、東南亞、中國、日韓、歐美。

每份報告 JSON 必含：
- items（陣列）每項含：name、source、region（TW/MY/CN/KR/US/Global）、type（online_course/offline_service/offline_course/product）、price_range、selling_points（陣列 3-5 點）、appeal、analysis、reproducibility（high/medium/low + 一句說明）、source_url
- summary（200-300 字整體市場觀察）
- opportunities（陣列）— 溫點 WarmPlace 沒想到但該注意的機會
- threats（陣列）— 競爭威脅
- recommended_actions（陣列）— 給 VICTOR 的執行建議

只輸出 JSON。`;

const DISTILL_SYSTEM = BUSINESS_CONTEXT + '\n\n' + `你是 溫點 WarmPlace 的市場情報 DISTILL 引擎。

任務：拿 SCOUT 收集的全球 8 個業務領域競品報告，精煉成「市場情報」（讓所有 AI 員工自動學習用）。

輸出 JSON 必含：
- trending_topics（陣列 3-5 個）— 全球熱門話題，每項含 { topic, from_services, why_hot }
- emerging_price_points（陣列 2-3 個）— 新興定價趨勢，含 { range, region, note }
- new_techniques（陣列 2-3 個）— 新技術/工具/詞彙，含 { name, desc, who_using }
- differentiation_opportunities（陣列 3-5 個）— 溫點 WarmPlace 可切入的差異化角度
- content_angles（陣列 5-8 個）— CAMILLE 可用的 IG/FB 內容角度（具體！）
- pricing_recommendations（物件）— 溫點 WarmPlace 雙主力 (馬卡龍+費南雪) 商品的建議定價（依競品中位數）
- threats_to_watch（陣列 2-3 個）
- action_items（陣列 3-5 個）— 給 VICTOR 的具體執行項
- vocabulary_updates（陣列）— 業界新詞彙，所有 AI prompt 應該知道
- weekly_focus（一段 100-150 字）— 本週最該關注什麼

只輸出 JSON。`;

async function callWithRetry(client, params) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (e) {
      lastErr = e;
      const is429 = e.status === 429 || (e.message && e.message.includes('429'));
      if (is429 && attempt < MAX_RETRIES - 1) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.log('[scout] 429 rate limit, retry in ' + delay + 'ms (attempt ' + (attempt + 1) + ')');
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function callScoutWithSearch(serviceName, searchTerms) {
  const client = getClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY not set');

  const userPrompt = '請對「' + serviceName + '」做一輪全球市場調查（搜尋詞：' + searchTerms + '）。' +
    '至少使用 web_search 5 次（不同關鍵字組合 / 不同地區），蒐集 5-8 個精選競品（重質不重量），輸出結構化 JSON 報告。' +
    '記得搜全球,包含台灣、法國、日本、韓國、歐美的法式精品馬卡龍 / 高端禮盒品牌。';

  const response = await callWithRetry(client, {
    model: SCOUT_MODEL,
    max_tokens: 12000,
    system: SCOUT_SYSTEM,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
    messages: [{ role: 'user', content: userPrompt }],
  });

  let textOut = '';
  let searchCount = 0;
  for (const block of response.content) {
    if (block.type === 'text') textOut += block.text;
    if (block.type === 'server_tool_use' && block.name === 'web_search') searchCount++;
  }

  let parsed = null;
  let parseAttempts = [textOut];
  // Strip markdown code fences
  const fenceMatch = textOut.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) parseAttempts.push(fenceMatch[1]);
  // Extract first {...} block (greedy)
  const objMatch = textOut.match(/\{[\s\S]*\}/);
  if (objMatch) parseAttempts.push(objMatch[0]);
  for (const attempt of parseAttempts) {
    try { parsed = JSON.parse(attempt); break; } catch {}
  }

  return { raw: textOut, parsed, search_count: searchCount, usage: response.usage || null };
}

async function scoutOneService(service) {
  try {
    const result = await callScoutWithSearch(service.name, service.search_terms);
    return {
      service_id: service.id,
      service_name: service.name,
      generated_at: new Date().toISOString(),
      model: SCOUT_MODEL,
      search_count: result.search_count,
      data: result.parsed,
      raw: result.parsed ? null : result.raw,
      ok: !!result.parsed,
    };
  } catch (e) {
    return {
      service_id: service.id,
      service_name: service.name,
      generated_at: new Date().toISOString(),
      ok: false,
      error: e.message,
    };
  }
}

async function scoutScanAll(opts) {
  opts = opts || {};
  const startTime = Date.now();
  const state = loadReports();
  const newReports = {};
  const errors = [];

  for (let i = 0; i < SERVICES.length; i++) {
    const svc = SERVICES[i];
    console.log('[SCOUT ' + (i+1) + '/' + SERVICES.length + '] ' + svc.name + '...');
    const r = await scoutOneService(svc);
    newReports[svc.id] = r;
    if (!r.ok) errors.push(svc.id + ': ' + (r.error || 'parse failed'));
    state.reports[svc.id] = r;
    saveReports(state);

    if (i < SERVICES.length - 1) {
      console.log('[SCOUT] cooldown ' + (INTER_SERVICE_DELAY_MS/1000) + 's...');
      await sleep(INTER_SERVICE_DELAY_MS);
    }
  }

  state.last_run = new Date().toISOString();
  if (!state.runs) state.runs = [];
  state.runs.unshift({
    at: state.last_run,
    duration_ms: Date.now() - startTime,
    services_scanned: SERVICES.length,
    success_count: Object.values(newReports).filter(r => r.ok).length,
    errors,
  });
  if (state.runs.length > 20) state.runs = state.runs.slice(0, 20);
  saveReports(state);

  // 自動跑 DISTILL（synthesize 出市場情報）
  let distillResult = null;
  try {
    if (Object.values(newReports).filter(r => r.ok).length > 0) {
      console.log('[SCOUT] running DISTILL...');
      distillResult = await distillIntelligence();
    }
  } catch (e) {
    console.error('[SCOUT] distill failed:', e.message);
  }

  return {
    ok: true,
    last_run: state.last_run,
    success_count: Object.values(newReports).filter(r => r.ok).length,
    total: SERVICES.length,
    errors,
    duration_seconds: Math.round((Date.now() - startTime) / 1000),
    distilled: distillResult ? distillResult.ok : false,
  };
}

async function scoutOne(serviceId) {
  const svc = SERVICES.find(s => s.id === serviceId);
  if (!svc) return { ok: false, error: 'unknown service: ' + serviceId };
  const r = await scoutOneService(svc);
  const state = loadReports();
  state.reports[svc.id] = r;
  if (!state.last_run) state.last_run = new Date().toISOString();
  saveReports(state);
  return { ok: r.ok, service: svc.name, search_count: r.search_count, error: r.error };
}

async function distillIntelligence() {
  const client = getClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY not set');
  const state = loadReports();
  if (!state.last_run) return { ok: false, reason: 'no SCOUT data' };

  // 把 SCOUT 報告打包給 DISTILL
  const ctx = { last_run: state.last_run, services: {} };
  for (const [id, r] of Object.entries(state.reports || {})) {
    if (!r || !r.ok || !r.data) continue;
    ctx.services[id] = {
      name: r.service_name,
      summary: r.data.summary,
      items: r.data.items,
      opportunities: r.data.opportunities,
      threats: r.data.threats,
    };
  }
  if (Object.keys(ctx.services).length === 0) return { ok: false, reason: 'no successful reports' };

  const userPrompt = '請從下列 SCOUT 競品報告精煉出市場情報：\n\n' + JSON.stringify(ctx).slice(0, 30000);

  const response = await callWithRetry(client, {
    model: DISTILL_MODEL,
    max_tokens: 8000,
    system: DISTILL_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  });

  let textOut = '';
  for (const block of response.content) if (block.type === 'text') textOut += block.text;

  let parsed = null;
  try {
    const m = textOut.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch {}

  if (!parsed) return { ok: false, raw: textOut, error: 'parse failed' };

  parsed.distilled_at = new Date().toISOString();
  parsed.based_on_scout_run = state.last_run;
  parsed.distill_model = DISTILL_MODEL;
  saveJson(INTEL_FILE, parsed);

  return { ok: true, intelligence: parsed };
}

function getMarketIntelligence() {
  return loadJson(INTEL_FILE, null);
}

function getLatestReports() { return loadReports(); }

function getReportSummary() {
  const state = loadReports();
  if (!state.last_run) return null;
  const summary = { last_run: state.last_run, services: {}, aggregated_opportunities: [], aggregated_threats: [] };
  for (const [id, r] of Object.entries(state.reports || {})) {
    if (!r || !r.ok || !r.data) continue;
    summary.services[id] = {
      name: r.service_name,
      summary: r.data.summary,
      items_count: Array.isArray(r.data.items) ? r.data.items.length : 0,
      opportunities: r.data.opportunities || [],
      threats: r.data.threats || [],
    };
    if (Array.isArray(r.data.opportunities)) summary.aggregated_opportunities.push(...r.data.opportunities.map(o => '[' + r.service_name + '] ' + (typeof o === 'string' ? o : JSON.stringify(o))));
    if (Array.isArray(r.data.threats)) summary.aggregated_threats.push(...r.data.threats.map(t => '[' + r.service_name + '] ' + (typeof t === 'string' ? t : JSON.stringify(t))));
  }
  return summary;
}

function getContextForOtherAgents() {
  const intel = getMarketIntelligence();
  const parts = [];

  if (intel) {
    parts.push('【市場情報（DISTILL ' + (intel.distilled_at || '').slice(0, 10) + '）】');
    if (intel.weekly_focus) parts.push('🎯 本週重點：' + String(intel.weekly_focus).slice(0, 200));
    if (Array.isArray(intel.trending_topics)) {
      const list = intel.trending_topics.slice(0, 5).map(t => typeof t === 'string' ? t : (t.topic || JSON.stringify(t)));
      parts.push('🔥 熱門話題：' + list.join('、'));
    }
    if (Array.isArray(intel.differentiation_opportunities)) {
      const list = intel.differentiation_opportunities.slice(0, 4).map(o => typeof o === 'string' ? o : JSON.stringify(o));
      parts.push('💎 差異化機會：' + list.join('；'));
    }
    if (Array.isArray(intel.content_angles)) {
      const list = intel.content_angles.slice(0, 6).map(a => typeof a === 'string' ? a : JSON.stringify(a));
      parts.push('📝 可用內容角度：' + list.join('、'));
    }
    if (Array.isArray(intel.action_items)) {
      const list = intel.action_items.slice(0, 4).map(a => typeof a === 'string' ? a : JSON.stringify(a));
      parts.push('⚡ 建議行動：' + list.join('；'));
    }
    if (Array.isArray(intel.vocabulary_updates)) {
      const list = intel.vocabulary_updates.slice(0, 8).map(v => typeof v === 'string' ? v : (v.term || JSON.stringify(v)));
      parts.push('📚 業界新詞彙：' + list.join('、'));
    }
    return parts.join('\n');
  }

  // fallback: 沒 DISTILL 資料則用原始 summary
  const sum = getReportSummary();
  if (!sum) return '';
  parts.push('【最新市場調查（SCOUT）— ' + sum.last_run.slice(0, 10) + '】');
  for (const [id, s] of Object.entries(sum.services)) {
    if (!s.summary) continue;
    parts.push('• ' + s.name + '：' + String(s.summary).slice(0, 150));
  }
  return parts.join('\n');
}

function registerCronJobs(cron) {
  // 每天 07:00 跑 SCAN（會自動接 DISTILL）
  cron.schedule('0 7 * * *', () => {
    scoutScanAll().catch(e => console.error('[SCOUT cron]', e));
  }, { timezone: 'Asia/Taipei' });
  console.log('[scout] cron registered (DAILY 07:00 — scan + distill)');
}

module.exports = {
  SERVICES,
  scoutScanAll,
  scoutOne,
  distillIntelligence,
  getLatestReports,
  getReportSummary,
  getMarketIntelligence,
  getContextForOtherAgents,
  registerCronJobs,
};
