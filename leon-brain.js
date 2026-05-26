// leon-brain.js — LEON 自我改進大腦
// 每週四自動：1) 驗證上週建議對錯 2) 拍本週快照對比上週 3) 產新建議 4) 算 LEON 累計準確率

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const BRAIN_FILE = path.join(DATA_DIR, 'leon_brain.jsonl');

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function loadAll() {
  ensureDir();
  try {
    return fs.readFileSync(BRAIN_FILE, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function append(record) {
  ensureDir();
  try { fs.appendFileSync(BRAIN_FILE, JSON.stringify(record) + '\n'); } catch {}
}

// 拍快照：抓 Meta 過去 7 天表現
async function takeSnapshot(metaModule, label) {
  const out = { type: 'snapshot', label, ts: new Date().toISOString(), iso_week: getIsoWeek(), data: {} };
  try {
    if (metaModule && metaModule.getAdsWithInsights) {
      const ads = await metaModule.getAdsWithInsights({ days: 7 });
      const adsList = (ads && (ads.data || ads)) || [];
      const byCampaign = {};
      let totalSpend = 0, totalImp = 0, totalClicks = 0;
      for (const a of adsList) {
        const ins = a.insights || a;
        const spend = parseFloat(ins.spend || 0);
        const imp = parseInt(ins.impressions || 0);
        const clk = parseInt(ins.clicks || 0);
        totalSpend += spend; totalImp += imp; totalClicks += clk;
        const cname = a.campaign_name || 'unknown';
        if (!byCampaign[cname]) byCampaign[cname] = { spend: 0, impressions: 0, clicks: 0, ad_count: 0 };
        byCampaign[cname].spend += spend;
        byCampaign[cname].impressions += imp;
        byCampaign[cname].clicks += clk;
        byCampaign[cname].ad_count++;
      }
      out.data = {
        total: { spend: Math.round(totalSpend), impressions: totalImp, clicks: totalClicks,
                 ctr: totalImp > 0 ? (totalClicks/totalImp*100).toFixed(2) : '0',
                 cpm: totalImp > 0 ? Math.round(totalSpend/totalImp*1000) : 0,
                 cpc: totalClicks > 0 ? Math.round(totalSpend/totalClicks) : 0 },
        by_campaign: byCampaign
      };
    }
  } catch (e) { out.error = e.message; }
  append(out);
  return out;
}

function getIsoWeek() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return d.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
}

// 比較本週與上週快照，找出進步 / 退步的 Campaign
function compareSnapshots(thisWeek, lastWeek) {
  if (!lastWeek || !lastWeek.data || !lastWeek.data.by_campaign) {
    return { is_first_run: true, summary: '無上週資料對比' };
  }
  const result = { changes: [], improvers: [], degraders: [], new_campaigns: [], paused: [] };
  const thisC = thisWeek.data.by_campaign || {};
  const lastC = lastWeek.data.by_campaign || {};
  for (const name of new Set([...Object.keys(thisC), ...Object.keys(lastC)])) {
    const t = thisC[name], l = lastC[name];
    if (t && !l) { result.new_campaigns.push(name); continue; }
    if (!t && l) { result.paused.push(name); continue; }
    const tCpc = t.clicks > 0 ? t.spend / t.clicks : 0;
    const lCpc = l.clicks > 0 ? l.spend / l.clicks : 0;
    const tCtr = t.impressions > 0 ? t.clicks / t.impressions * 100 : 0;
    const lCtr = l.impressions > 0 ? l.clicks / l.impressions * 100 : 0;
    const cpcChange = lCpc > 0 ? ((tCpc - lCpc) / lCpc * 100).toFixed(1) : null;
    const ctrChange = lCtr > 0 ? ((tCtr - lCtr) / lCtr * 100).toFixed(1) : null;
    const entry = { name, this_spend: Math.round(t.spend), last_spend: Math.round(l.spend),
                    this_cpc: Math.round(tCpc), last_cpc: Math.round(lCpc), cpc_change: cpcChange,
                    this_ctr: tCtr.toFixed(2), last_ctr: lCtr.toFixed(2), ctr_change: ctrChange };
    result.changes.push(entry);
    if (cpcChange && parseFloat(cpcChange) <= -10) result.improvers.push(entry);
    if (cpcChange && parseFloat(cpcChange) >= 15) result.degraders.push(entry);
  }
  return result;
}

// 用 Claude 產建議
async function generateSuggestions(snapshot, comparison) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = '你是 LEON — 溫點 WarmPlace 的 AI 廣告投手。根據以下廣告數據對比，產出 3-5 條具體可執行的建議。\n\n' +
      '本週快照：\n' + JSON.stringify(snapshot.data, null, 2) + '\n\n' +
      '本週 vs 上週對比：\n' + JSON.stringify(comparison, null, 2) + '\n\n' +
      '請以 JSON 陣列輸出，每條建議包含：\n' +
      '- id: 唯一識別（如 sug_001）\n' +
      '- type: pause / scale_up / scale_down / test / pivot\n' +
      '- target: Campaign 名稱或 ad_id\n' +
      '- action: 具體動作（一句話）\n' +
      '- reason: 為什麼（用數字佐證）\n' +
      '- prediction: 預期一週後結果（用數字描述）\n' +
      '- confidence: 信心 1-10\n\n' +
      '只回 JSON，不要任何說明文字。';
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = resp.content && resp.content[0] && resp.content[0].text || '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch (e) { return [{ error: e.message }]; }
}

// 驗證上週建議
async function verifyPastSuggestions(metaModule) {
  const all = loadAll();
  const lastSugs = all.filter(r => r.type === 'suggestions' && !r.verified)
    .sort((a,b) => new Date(b.ts) - new Date(a.ts))[0];
  if (!lastSugs) return { ok: false, reason: '無上週未驗證建議' };
  // Pull current state
  const currentSnap = await takeSnapshot(metaModule, 'verify_check');
  const verifyResults = (lastSugs.suggestions || []).map(s => {
    let outcome = 'unknown';
    if (s.target && currentSnap.data && currentSnap.data.by_campaign) {
      const stillExists = !!currentSnap.data.by_campaign[s.target];
      if (s.type === 'pause' && !stillExists) outcome = 'implemented';
      else if (s.type === 'pause' && stillExists) outcome = 'not_implemented';
      else if (s.type === 'scale_up' || s.type === 'scale_down') outcome = stillExists ? 'check_metrics' : 'paused';
    }
    return { id: s.id, action: s.action, prediction: s.prediction, outcome };
  });
  const verified = { type: 'verification', ts: new Date().toISOString(), parent_id: lastSugs.id, results: verifyResults };
  append(verified);
  // Mark suggestions as verified
  lastSugs.verified = true;
  return { ok: true, count: verifyResults.length, results: verifyResults };
}

// 算 LEON 累計準確率
function getAccuracy() {
  const verifications = loadAll().filter(r => r.type === 'verification');
  let total = 0, implemented = 0;
  for (const v of verifications) {
    for (const r of (v.results || [])) {
      total++;
      if (r.outcome === 'implemented' || r.outcome === 'check_metrics') implemented++;
    }
  }
  return { total_suggestions_tracked: total, implemented_rate: total > 0 ? (implemented/total*100).toFixed(1) + '%' : 'N/A',
           weekly_runs: verifications.length };
}

// 一週循環主函式
async function weeklyRun(metaModule) {
  const result = { ts: new Date().toISOString(), iso_week: getIsoWeek() };
  // Step 1: 驗證上週
  result.verification = await verifyPastSuggestions(metaModule);
  // Step 2: 本週快照
  result.snapshot = await takeSnapshot(metaModule, 'weekly_thursday');
  // Step 3: 找上週快照對比
  const all = loadAll();
  const prevSnap = all.filter(r => r.type === 'snapshot' && r.label === 'weekly_thursday')
    .sort((a,b) => new Date(b.ts) - new Date(a.ts))[1]; // [1] = previous one
  result.comparison = compareSnapshots(result.snapshot, prevSnap);
  // Step 4: 產建議
  result.suggestions = await generateSuggestions(result.snapshot, result.comparison);
  // Step 5: 累計準確率
  result.accuracy = getAccuracy();
  // Save suggestions for next week's verification
  append({ type: 'suggestions', id: 'sug_' + Date.now(), ts: result.ts, iso_week: result.iso_week,
           suggestions: result.suggestions, verified: false });
  return result;
}

// 把週報格式化成 Telegram 訊息
function formatForTelegram(report) {
  let msg = '🧠 LEON 每週自學報告 · ' + report.iso_week + '\n';
  msg += '─────────────\n\n';
  // 累計準確率
  msg += '📈 LEON 累計表現：' + (report.accuracy.weekly_runs || 0) + ' 週、' + (report.accuracy.implemented_rate || 'N/A') + ' 採納率\n\n';
  // 進步 / 退步
  if (report.comparison && report.comparison.changes) {
    if (report.comparison.improvers && report.comparison.improvers.length > 0) {
      msg += '✅ 進步：\n';
      for (const c of report.comparison.improvers.slice(0, 3)) {
        msg += '  · ' + c.name + ' CPC ' + c.cpc_change + '%（' + c.last_cpc + ' → ' + c.this_cpc + '）\n';
      }
      msg += '\n';
    }
    if (report.comparison.degraders && report.comparison.degraders.length > 0) {
      msg += '⚠️ 退步：\n';
      for (const c of report.comparison.degraders.slice(0, 3)) {
        msg += '  · ' + c.name + ' CPC +' + c.cpc_change + '%（' + c.last_cpc + ' → ' + c.this_cpc + '）\n';
      }
      msg += '\n';
    }
  }
  // 建議
  msg += '🎯 本週建議（' + (report.suggestions || []).length + ' 條）：\n';
  for (const s of (report.suggestions || []).slice(0, 5)) {
    if (s.error) { msg += '  · 產建議失敗：' + s.error + '\n'; continue; }
    msg += '  [' + (s.type || '?') + '] ' + (s.action || s.target || '?') + '\n';
    if (s.reason) msg += '     原因：' + s.reason + '\n';
  }
  return msg;
}

module.exports = { takeSnapshot, compareSnapshots, generateSuggestions, verifyPastSuggestions, getAccuracy, weeklyRun, formatForTelegram, loadAll };
