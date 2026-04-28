// alerts.js — 智慧週循環簡報 + 日警示系統
//
// 提供：
//   - dailyBriefing()：每日早安簡報（週一戰略 / 週三中週 / 週日回顧 / 平日摘要）
//   - sendBriefing()：實際組訊息推到 LINE（給 admin user）
//   - registerCronJobs(cron)：在 server.js 啟動時呼叫，註冊所有定時任務
//
// 環境變數：
//   ADMIN_LINE_USER_ID — 收簡報的 LINE userId（必填，否則簡報不會推送）
//   TZ                 — 預設 'Asia/Taipei'

const fs = require('fs');
const path = require('path');

let line, customers, meta, salesmartly, decisions;

// 軟引用：模組存在就載入，不存在就跳過（這樣 alerts.js 跟其他模組可以解耦）
function tryRequire(name) {
  try { return require(name); } catch { return null; }
}

line       = tryRequire('./line');
customers  = tryRequire('./customers');
meta       = tryRequire('./meta');
salesmartly = tryRequire('./salesmartly');
decisions  = tryRequire('./decisions');
const briefingAi = tryRequire('./briefing-ai');

const ADMIN = process.env.ADMIN_LINE_USER_ID || '';
const TZ = process.env.TZ || 'Asia/Taipei';

function getWeekday() {
  const now = new Date();
  const tw = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
  return tw.getDay();
}

function todayLabel() {
  const wd = getWeekday();
  const names = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
  return names[wd];
}

async function strategySection() {
  try {
    if (briefingAi && typeof briefingAi.generateStrategy === 'function') {
      const _ai = await briefingAi.generateStrategy();
      if (_ai) return _ai;
    }
  } catch (e) { console.error('[alerts] strategy AI:', e.message); }
  return [
    '🎯 本週戰略重點',
    '（VICTOR 從廣告 / 客戶 / 內容三個角度，給三件最關鍵的事）',
    '— 本段需要呼叫 Claude API 生成；如果未配置 ANTHROPIC_API_KEY 會跳過',
  ].join('\n');
}

async function midweekSection() {
  try {
    if (briefingAi && typeof briefingAi.generateMidweek === 'function') {
      const _ai = await briefingAi.generateMidweek();
      if (_ai) return _ai;
    }
  } catch (e) { console.error('[alerts] midweek AI:', e.message); }
  return [
    '🔧 中週調整建議',
    '前三天表現 vs 預期差距，建議調整：',
    '— 等實際接 Claude API 後填入',
  ].join('\n');
}

async function reviewSection() {
  try {
    if (briefingAi && typeof briefingAi.generateReview === 'function') {
      const _ai = await briefingAi.generateReview();
      if (_ai) return _ai;
    }
  } catch (e) { console.error('[alerts] review AI:', e.message); }
  return [
    '📊 本週回顧 + 下週預告',
    '本週成績：營業額 / 廣告 ROAS / 內容互動',
    '下週預告：上週回顧的 actions 進入下週',
  ].join('\n');
}

async function adsSection() {
  if (!meta) return null;
  try {
    if (typeof meta.getAdsSnapshot === 'function') {
      const snap = await meta.getAdsSnapshot({ days: 1 });
      const lines = ['💰 廣告燒費（昨日）'];
      lines.push(`  - 花費：NT$${snap.spend || 0}`);
      lines.push(`  - 成交：${snap.purchases || 0} 筆`);
      lines.push(`  - ROAS：${snap.roas || '—'}`);
      if (snap.roas !== undefined && snap.roas < 1) {
        lines.push('  ⚠️ ROAS 紅燈！LEON 建議檢查 creative 或受眾');
      }
      return lines.join('\n');
    }
  } catch (e) {}
  return null;
}

async function customersSection() {
  if (!customers) return null;
  try {
    if (typeof customers.getSegmentSnapshot === 'function') {
      const seg = await customers.getSegmentSnapshot();
      return [
        '👥 客戶分群',
        `  VIP：${seg.vip || 0}人`,
        `  活躍：${seg.active || 0}人`,
        `  新客：${seg.new || 0}人`,
        `  流失風險：${seg.churning || 0}人`,
      ].join('\n');
    }
  } catch (e) {}
  return null;
}

async function customerInsightsSection() {
  if (!salesmartly) return null;
  try {
    const insights = await salesmartly.getCustomerInsights({ days: 7 });
    if (insights.ok && insights.summary) return insights.summary;
  } catch (e) {}
  return null;
}

async function pendingDecisionsSection() {
  if (!decisions) return null;
  try {
    if (typeof decisions.getPending === 'function') {
      const pending = await decisions.getPending({ limit: 3 });
      if (!pending || pending.length === 0) return null;
      const lines = ['🤔 等你拍板（最多 3 件）'];
      pending.forEach((d, i) => {
        lines.push(`${i + 1}. ${d.title}`);
        if (d.recommendation) lines.push(`   AI 建議：${d.recommendation}`);
        lines.push(`   回覆 ${i + 1}ok / ${i + 1}no / ${i + 1}?`);
      });
      return lines.join('\n');
    }
  } catch (e) {}
  return null;
}

async function dailyBriefing() {
  const wd = getWeekday();
  const date = new Date().toLocaleDateString('zh-TW', { timeZone: TZ });

  const sections = [];
  sections.push(`☀️ VICTOR 早安簡報 — ${date} ${todayLabel()}`);
  sections.push('');

  const ads = await adsSection();
  if (ads) sections.push(ads);

  const cust = await customersSection();
  if (cust) sections.push(cust);

  const insights = await customerInsightsSection();
  if (insights) sections.push(insights);

  if (wd === 1) {
    sections.push(await strategySection());
  } else if (wd === 3) {
    sections.push(await midweekSection());
  } else if (wd === 0) {
    sections.push(await reviewSection());
  }

  const pending = await pendingDecisionsSection();
  if (pending) sections.push(pending);

  return sections.filter(Boolean).join('\n\n');
}

async function sendBriefing() {
  if (!ADMIN) {
    console.warn('[alerts] ADMIN_LINE_USER_ID not set, briefing not sent');
    return { ok: false, reason: 'ADMIN_LINE_USER_ID not set' };
  }
  if (!line || typeof line.pushMessage !== 'function') {
    console.warn('[alerts] line.pushMessage not available');
    return { ok: false, reason: 'line module not loaded' };
  }
  try {
    const text = await dailyBriefing();
    await line.pushMessage(ADMIN, [{ type: 'text', text: text.slice(0, 4900) }]);
    console.log('[alerts] daily briefing sent, length=' + text.length);
    return { ok: true, length: text.length };
  } catch (err) {
    console.error('[alerts] sendBriefing failed:', err.message);
    return { ok: false, reason: err.message };
  }
}

async function checkAdsAlerts() {
  if (!meta || !line || !ADMIN) return;
  try {
    if (typeof meta.getAdsSnapshot !== 'function') return;
    const snap = await meta.getAdsSnapshot({ hours: 1 });
    const alerts = [];
    if (snap.roas !== undefined && snap.roas < 1.0 && snap.spend >= 1000) {
      alerts.push(`🔴 廣告紅燈 ROAS ${snap.roas} (花費 NT$${snap.spend})`);
    }
    if (snap.spend >= 5000 && (snap.purchases || 0) === 0) {
      alerts.push(`🔴 燒了 NT$${snap.spend} 但 0 成交，建議暫停 underperformer`);
    }
    if (alerts.length > 0) {
      await line.pushMessage(ADMIN, [{ type: 'text', text: alerts.join('\n\n') }]);
    }
  } catch (e) {
    console.error('[alerts] checkAdsAlerts failed:', e.message);
  }
}

function registerCronJobs(cron) {
  if (!cron || typeof cron.schedule !== 'function') {
    console.warn('[alerts] cron module not provided, jobs not scheduled');
    return;
  }
  cron.schedule('0 9 * * *', sendBriefing, { timezone: TZ });
  cron.schedule('*/30 * * * *', checkAdsAlerts, { timezone: TZ });
  console.log('[alerts] cron jobs registered (daily 09:00 + ads every 30min)');
}

module.exports = {
  dailyBriefing,
  sendBriefing,
  checkAdsAlerts,
  registerCronJobs,
  adsSection,
  customersSection,
  customerInsightsSection,
  pendingDecisionsSection,
};
