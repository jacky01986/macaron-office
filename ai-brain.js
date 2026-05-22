// ai-brain.js — 全員 AI 員工自我改進大腦框架
// 每位員工每週自動：拍快照 → 對比上週 → 產建議 → 一週後驗證對錯 → 累積準確率
// + SCOUT 競品報告 + VOC 顧客之聲 自動餵進每次建議產生的 context

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');

function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }
function brainFile(name) { return path.join(DATA_DIR, name.toLowerCase() + '_brain.jsonl'); }

function loadAll(name) {
  ensureDir();
  try {
    return fs.readFileSync(brainFile(name), 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function append(name, record) {
  ensureDir();
  try { fs.appendFileSync(brainFile(name), JSON.stringify(record) + '\n'); } catch {}
}

function getIsoWeek() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return d.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
}

// 員工註冊表 — 每位員工的 domain 設定
const EMPLOYEES = {
  victor: {
    name: 'VICTOR', emoji: '👑', role: '行銷總監',
    collectMetrics: async () => {
      try {
        const r = await fetch('http://localhost:' + (process.env.PORT || 10000) + '/api/roas/today?days=7').then(x => x.json());
        return { lead_count: r.lead_count, ad_spend: r.ad_spend_ntd, cpl: r.cost_per_lead_ntd, breakdown: r.breakdown };
      } catch { return {}; }
    },
    focusAreas: '整體行銷策略、預算配置、各員工協調、KPI 達成率'
  },
  leon: {
    name: 'LEON', emoji: '🎯', role: '廣告投手',
    collectMetrics: async () => {
      try {
        const meta = require('./meta');
        if (!meta.getAdsWithInsights) return {};
        const ads = await meta.getAdsWithInsights({ days: 7 });
        const list = (ads && (ads.data || ads)) || [];
        let spend = 0, imp = 0, clk = 0;
        const byCampaign = {};
        for (const a of list) {
          const ins = a.insights || a;
          spend += parseFloat(ins.spend || 0);
          imp += parseInt(ins.impressions || 0);
          clk += parseInt(ins.clicks || 0);
          const cn = a.campaign_name || 'unknown';
          if (!byCampaign[cn]) byCampaign[cn] = { spend:0, impressions:0, clicks:0 };
          byCampaign[cn].spend += parseFloat(ins.spend || 0);
          byCampaign[cn].impressions += parseInt(ins.impressions || 0);
          byCampaign[cn].clicks += parseInt(ins.clicks || 0);
        }
        return { spend, impressions: imp, clicks: clk, ctr: imp>0?(clk/imp*100).toFixed(2):0,
                 cpc: clk>0?Math.round(spend/clk):0, cpm: imp>0?Math.round(spend/imp*1000):0,
                 by_campaign: byCampaign };
      } catch { return {}; }
    },
    focusAreas: 'Meta 廣告 ROI、CPL、CTR、CPM、預算分配、素材疲勞、受眾優化'
  },
  camille: {
    name: 'CAMILLE', emoji: '✒️', role: '文案企劃',
    collectMetrics: async () => {
      try {
        // Articles published this week + FB engagement
        const r = await fetch('http://localhost:' + (process.env.PORT || 10000) + '/api/geo/auto-publish-log?n=20').then(x => x.json());
        const recent = (r.items || []).filter(it => it.ts && Date.now() - new Date(it.ts).getTime() < 7*86400000);
        const fbSuccess = recent.filter(it => it.fb && it.fb.success_count > 0).length;
        return { articles_this_week: recent.length, fb_publish_success: fbSuccess,
                 titles: recent.slice(0, 5).map(it => it.title) };
      } catch { return {}; }
    },
    focusAreas: '文章標題吸引力、FB 貼文 CTR、內容主題覆蓋度、轉換率提升的文案調整'
  },
  dex: {
    name: 'DEX', emoji: '📊', role: '數據分析師',
    collectMetrics: async () => {
      try {
        const r = await fetch('http://localhost:' + (process.env.PORT || 10000) + '/api/customers/inquiries?days=7').then(x => x.json());
        return { total_customers: r.total, segments: r.segments && Object.fromEntries(Object.entries(r.segments).map(([k,v])=>[k,v.count])) };
      } catch { return {}; }
    },
    focusAreas: '客戶分群動態、活躍 / 流失趨勢、漏斗轉換、隱藏的數據洞察'
  },
  emi: {
    name: 'EMI', emoji: '📝', role: '客戶經營',
    collectMetrics: async () => {
      try {
        const r = await fetch('http://localhost:' + (process.env.PORT || 10000) + '/api/customers/inquiries?days=30').then(x => x.json());
        return { active_30d: r.segments && r.segments.active && r.segments.active.count,
                 cold: r.segments && r.segments.cold && r.segments.cold.count,
                 lost: r.segments && r.segments.lost && r.segments.lost.count };
      } catch { return {}; }
    },
    focusAreas: '客戶回購率、流失率、nurture flow 效果、VIP 留存'
  }
};

// 抓 SCOUT 競品報告（共用 context）
async function getScoutContext() {
  try {
    const r = await fetch('http://localhost:' + (process.env.PORT || 10000) + '/api/scout/reports').then(x => x.json());
    const reports = r.reports || {};
    return Object.entries(reports).slice(0, 3).map(([k, rep]) => ({
      service: rep.service_name, generated_at: rep.generated_at,
      key_insight: rep.data && rep.data.items && rep.data.items.slice(0, 2).map(i => i.name + ' (' + i.price_range + ')').join('; ')
    }));
  } catch { return []; }
}

// 抓 VOC 顧客之聲（共用 context）
async function getVocContext() {
  try {
    const r = await fetch('http://localhost:' + (process.env.PORT || 10000) + '/api/voc/mine?days=30').then(x => x.json());
    return r.analysis ? r.analysis.slice(0, 800) : null;
  } catch { return null; }
}

// 拍快照
async function takeSnapshot(empKey) {
  const emp = EMPLOYEES[empKey];
  if (!emp) return null;
  const metrics = await emp.collectMetrics();
  const snap = { type: 'snapshot', emp: empKey, ts: new Date().toISOString(), iso_week: getIsoWeek(), data: metrics };
  append(empKey, snap);
  return snap;
}

// 對比上週
function compareToLastWeek(empKey, thisWeek) {
  const history = loadAll(empKey);
  const lastWeek = history.filter(r => r.type === 'snapshot')
    .sort((a,b) => new Date(b.ts) - new Date(a.ts))[1];
  if (!lastWeek) return { is_first_run: true };
  return { this_week: thisWeek.data, last_week: lastWeek.data, last_ts: lastWeek.ts };
}

// 驗證上週建議
async function verifyPast(empKey) {
  const history = loadAll(empKey);
  const lastSugs = history.filter(r => r.type === 'suggestions' && !r.verified)
    .sort((a,b) => new Date(b.ts) - new Date(a.ts))[0];
  if (!lastSugs) return { ok: false, reason: '無上週建議' };
  const currentMetrics = await EMPLOYEES[empKey].collectMetrics();
  // Use Claude to assess if predictions came true
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = '評估以下 ' + empKey + ' 員工上週的建議是否實現。比對「預測」和「現在實際數據」，每條給 outcome: correct / partial / wrong / unknown。\n\n' +
      '上週建議：\n' + JSON.stringify(lastSugs.suggestions, null, 2) + '\n\n' +
      '本週實際數據：\n' + JSON.stringify(currentMetrics, null, 2) + '\n\n' +
      '只輸出 JSON 陣列，每元素 {id, outcome, note}。';
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = resp.content[0].text;
    const m = text.match(/\[[\s\S]*\]/);
    const results = m ? JSON.parse(m[0]) : [];
    append(empKey, { type: 'verification', ts: new Date().toISOString(), parent_id: lastSugs.id, results });
    lastSugs.verified = true;
    return { ok: true, count: results.length, results };
  } catch (e) { return { ok: false, error: e.message }; }
}

// 產建議（餵 SCOUT + VOC + 歷史 verification）
async function generateSuggestions(empKey, snapshot, comparison) {
  const emp = EMPLOYEES[empKey];
  const history = loadAll(empKey);
  const pastVerifications = history.filter(r => r.type === 'verification').slice(-3);
  const accuracy = getAccuracy(empKey);
  const [scoutCtx, vocCtx] = await Promise.all([getScoutContext(), getVocContext()]);
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = '你是 ' + emp.name + ' ' + emp.emoji + ' — MACARON DE LUXE 的 ' + emp.role + '。\n' +
      '你的關注領域：' + emp.focusAreas + '\n\n' +
      '【本週數據】\n' + JSON.stringify(snapshot.data, null, 2) + '\n\n' +
      '【vs 上週】\n' + JSON.stringify(comparison, null, 2) + '\n\n' +
      (scoutCtx.length ? '【競品最新動態 (SCOUT)】\n' + JSON.stringify(scoutCtx, null, 2) + '\n\n' : '') +
      (vocCtx ? '【顧客之聲摘要 (VOC)】\n' + vocCtx + '\n\n' : '') +
      (pastVerifications.length ? '【你過去 3 次建議的驗證結果（記取教訓）】\n' + JSON.stringify(pastVerifications, null, 2) + '\n\n' : '') +
      '【你的累計準確率】' + accuracy.implemented_rate + ' (' + accuracy.weekly_runs + ' 週)\n\n' +
      '請產 3-5 條本週具體可執行建議。JSON 陣列輸出，每條：\n' +
      '{id: "sug_xxx", type: "動作類型", target: "對象", action: "具體動作", reason: "原因+數字", prediction: "預期一週後結果", confidence: 1-10, learns_from_past: "從過去哪次學到的"}\n\n' +
      '只回 JSON。';
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = resp.content[0].text;
    const m = text.match(/\[[\s\S]*\]/);
    return m ? JSON.parse(m[0]) : [{ error: 'parse failed', raw: text.slice(0, 200) }];
  } catch (e) { return [{ error: e.message }]; }
}

function getAccuracy(empKey) {
  const history = loadAll(empKey);
  const verifications = history.filter(r => r.type === 'verification');
  let total = 0, correct = 0;
  for (const v of verifications) {
    for (const r of (v.results || [])) {
      total++;
      if (r.outcome === 'correct' || r.outcome === 'partial') correct++;
    }
  }
  return { total_predictions: total, correct_rate: total > 0 ? (correct/total*100).toFixed(1) + '%' : 'N/A',
           weekly_runs: verifications.length };
}

// 一週循環
async function weeklyRun(empKey) {
  const result = { emp: empKey, ts: new Date().toISOString(), iso_week: getIsoWeek() };
  result.verification = await verifyPast(empKey);
  result.snapshot = await takeSnapshot(empKey);
  result.comparison = compareToLastWeek(empKey, result.snapshot);
  result.suggestions = await generateSuggestions(empKey, result.snapshot, result.comparison);
  result.accuracy = getAccuracy(empKey);
  append(empKey, { type: 'suggestions', id: 'sug_' + Date.now(), ts: result.ts, iso_week: result.iso_week,
                   suggestions: result.suggestions, verified: false });
  return result;
}

function formatForTelegram(empKey, report) {
  const emp = EMPLOYEES[empKey];
  let msg = emp.emoji + ' ' + emp.name + ' 每週自學報告 · ' + report.iso_week + '\n';
  msg += '─────────────\n';
  msg += '📈 累計準確率：' + report.accuracy.correct_rate + ' (' + report.accuracy.weekly_runs + ' 週)\n\n';
  msg += '🎯 本週建議：\n';
  for (const s of (report.suggestions || []).slice(0, 5)) {
    if (s.error) { msg += '  ⚠️ ' + s.error + '\n'; continue; }
    msg += '  · [' + (s.type || '?') + '] ' + (s.action || s.target || '?') + '\n';
    if (s.reason) msg += '    💡 ' + s.reason.slice(0, 100) + '\n';
  }
  if (report.verification && report.verification.ok) {
    msg += '\n✅ 上週建議驗證：' + report.verification.count + ' 條已評估\n';
  }
  return msg;
}

async function runAllEmployees() {
  const results = {};
  for (const key of Object.keys(EMPLOYEES)) {
    try { results[key] = await weeklyRun(key); }
    catch (e) { results[key] = { error: e.message }; }
  }
  return results;
}

module.exports = { EMPLOYEES, takeSnapshot, weeklyRun, runAllEmployees, getAccuracy, formatForTelegram, loadAll };
