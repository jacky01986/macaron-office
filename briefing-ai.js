// briefing-ai.js — VICTOR (Opus 4.6) generates strategic content
// 給 alerts.js 的 strategySection / midweekSection / reviewSection 用
// env: ANTHROPIC_API_KEY (already set, used by main app)

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch {}

const meta = (() => { try { return require('./meta'); } catch { return null; } })();
const customers = (() => { try { return require('./customers'); } catch { return null; } })();
const salesmartly = (() => { try { return require('./salesmartly'); } catch { return null; } })();
const decisions = (() => { try { return require('./decisions'); } catch { return null; } })();

const DIRECTOR_MODEL = process.env.CLAUDE_DIRECTOR_MODEL || 'claude-opus-4-6';

let client = null;
function getClient() {
  if (client) return client;
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try { client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); }
  catch { client = null; }
  return client;
}

async function gatherContext({ days = 7 } = {}) {
  const ctx = {};
  try {
    if (meta && typeof meta.getAdsInsights === 'function') {
      const ins = await meta.getAdsInsights({ days });
      ctx.ads = ins;
    }
  } catch {}
  try {
    if (customers && typeof customers.getSegmentSnapshot === 'function') {
      ctx.customers = await customers.getSegmentSnapshot();
    }
  } catch {}
  try {
    if (salesmartly && typeof salesmartly.getCustomerInsights === 'function') {
      const r = await salesmartly.getCustomerInsights({ days });
      if (r && r.ok) ctx.customer_topics = r.topics;
    }
  } catch {}
  try {
    if (decisions && typeof decisions.getAll === 'function') {
      const all = await decisions.getAll();
      ctx.recent_decisions = (all.history || []).slice(-10).map(h => ({
        title: h.title, decision: h.decision, decided_at: h.decided_at, note: h.note,
      }));
    }
  } catch {}
  return ctx;
}

function ctxToPrompt(ctx) {
  const lines = [];
  if (ctx.ads) lines.push('=== 廣告（最近）===\n' + JSON.stringify(ctx.ads).slice(0, 1500));
  if (ctx.customers) lines.push('=== 客戶分群 ===\n' + JSON.stringify(ctx.customers));
  if (ctx.customer_topics) lines.push('=== 客人最常問什麼 ===\n' + JSON.stringify(ctx.customer_topics));
  if (ctx.recent_decisions && ctx.recent_decisions.length) {
    lines.push('=== 最近 10 件決策 ===\n' + JSON.stringify(ctx.recent_decisions));
  }
  if (lines.length === 0) return '（暫無數據可參考）';
  return lines.join('\n\n');
}

async function callClaude(systemPrompt, userPrompt, { maxTokens = 600 } = {}) {
  const c = getClient();
  if (!c) return null;
  try {
    const res = await c.messages.create({
      model: DIRECTOR_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const block = res.content && res.content[0];
    if (block && block.type === 'text') return block.text.trim();
    return null;
  } catch (err) {
    console.error('[briefing-ai] Claude call failed:', err.message);
    return null;
  }
}

async function generateStrategy() {
  const ctx = await gatherContext({ days: 7 });
  const sys = '你是 VICTOR — Macaron de Luxe Beauty Academy 的 AI 行銷總監。' +
    '你的工作是看完數據後，給老闆 3 件本週最關鍵的戰略行動。' +
    '回答要直接、具體、可執行。每件不超過 3 行。用繁體中文。';
  const user = '請給我「本週戰略重點」3 件最關鍵的事，從廣告、客戶經營、內容三個角度切入。\n\n' +
    '== 數據 ==\n' + ctxToPrompt(ctx);
  const out = await callClaude(sys, user, { maxTokens: 600 });
  if (!out) return '🎯 本週戰略重點\n（VICTOR 暫時不在線 — ANTHROPIC_API_KEY 未設或 API 失敗）';
  return '🎯 本週戰略重點（VICTOR）\n' + out;
}

async function generateMidweek() {
  const ctx = await gatherContext({ days: 3 });
  const sys = '你是 VICTOR — Macaron de Luxe 的 AI 行銷總監。週三中週要老闆做小幅調整。' +
    '看本週前 3 天數據 vs 預期，建議 1-2 件具體調整。簡短直接。用繁體中文。';
  const user = '本週前 3 天表現如何？需要調整什麼？\n\n== 數據 ==\n' + ctxToPrompt(ctx);
  const out = await callClaude(sys, user, { maxTokens: 400 });
  if (!out) return '🔧 中週調整建議\n（VICTOR 暫時不在線）';
  return '🔧 中週調整建議（VICTOR）\n' + out;
}

async function generateReview() {
  const ctx = await gatherContext({ days: 7 });
  const sys = '你是 VICTOR — Macaron de Luxe 的 AI 行銷總監。週日要做本週回顧 + 下週預告。' +
    '本週回顧：營業額 / 廣告 / 內容互動。下週預告：3 件主要任務。簡短具體，繁體中文。';
  const user = '請寫本週回顧（2-3 件主要成績）+ 下週預告（3 件主要任務）。\n\n== 數據 ==\n' + ctxToPrompt(ctx);
  const out = await callClaude(sys, user, { maxTokens: 600 });
  if (!out) return '📊 本週回顧 + 下週預告\n（VICTOR 暫時不在線）';
  return '📊 本週回顧 + 下週預告（VICTOR）\n' + out;
}

module.exports = { generateStrategy, generateMidweek, generateReview, gatherContext };
