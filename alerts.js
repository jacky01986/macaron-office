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
const marketIntel = tryRequire('./market-intel');
let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch {}
let _anth = null;
function getAnthropic() {
  if (_anth) return _anth;
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try { _anth = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); } catch { _anth = null; }
  return _anth;
}

// ============================================================
// A1 — 客戶對話日報 (從 Meta inbox 過去 24h)
// ============================================================
async function customerConversationDailyReport() {
  if (!meta || typeof meta.getInbox !== 'function') return null;
  try {
    const ib = await meta.getInbox({ limit_conv: 15, limit_msg: 10 });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const all = [...(ib.fb || []), ...(ib.ig || [])];
    const recent = all.filter(c => {
      const t = new Date(c.updated_time).getTime();
      return !isNaN(t) && t > cutoff;
    });
    if (recent.length === 0) return '📨 過去 24 小時客戶對話\n(無新對話)';

    const needsReply = [];
    const stalledAtPrice = [];
    const conversed = [];
    for (const c of recent) {
      const msgs = c.messages || [];
      if (msgs.length === 0) continue;
      const last = msgs[msgs.length - 1];
      const who = (c.participants || []).find(p => !/溫點|warmplace/i.test(p.name || ''));
      const name = (who && who.name) || (c.participants[0] && c.participants[0].name) || '匿名';
      if (last && !last.from_is_us) {
        needsReply.push({ name, last_text: last.text.slice(0, 80), at: last.at });
        if (/價|多少錢|價格|報價|多錢/.test(last.text)) {
          stalledAtPrice.push({ name, q: last.text.slice(0, 60) });
        }
      } else {
        conversed.push({ name });
      }
    }

    const c = getAnthropic();
    let topQuestions = '';
    if (c && recent.length > 0) {
      const allText = recent.flatMap(r => (r.messages || []).filter(m => !m.from_is_us).map(m => m.text)).join('\n').slice(0, 4000);
      try {
        const resp = await c.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          system: '你是溫點 WarmPlace 客服分析師。看完客人訊息後,給 Top 3 最常見的問題類型 (例: 價格 / 取貨方式 / 客製化 / 過敏原) 各 1 行. 純條列,不要其他.',
          messages: [{ role: 'user', content: allText }],
        });
        const block = resp.content && resp.content[0];
        if (block && block.type === 'text') topQuestions = block.text.trim();
      } catch (e) { console.error('[A1 ai]', e.message); }
    }

    const lines = ['📨 過去 24h 客戶對話 (Meta DM)'];
    lines.push(`  總計: ${recent.length} 通 (${needsReply.length} 待回, ${conversed.length} 已回)`);
    if (topQuestions) {
      lines.push('\n  🔍 Top 問題:');
      topQuestions.split('\n').slice(0, 3).forEach(l => lines.push('     ' + l.replace(/^[\s\d\.\-]+/, '').trim()));
    }
    if (needsReply.length > 0) {
      lines.push('\n  ⚠️ 待回客人 (' + needsReply.length + '):');
      needsReply.slice(0, 8).forEach(r => lines.push(`     • ${r.name}: 「${r.last_text}」`));
    }
    if (stalledAtPrice.length > 0) {
      lines.push('\n  🚨 問完價沒下文 (急救名單):');
      stalledAtPrice.slice(0, 5).forEach(r => lines.push(`     • ${r.name}`));
    }
    return lines.join('\n');
  } catch (e) {
    console.error('[customerConversationDailyReport]', e.message);
    return null;
  }
}

// ============================================================
// A2 — 轉換漏斗週報
// ============================================================
async function conversionFunnelWeeklyReport() {
  const base = process.env.SITE_URL || 'https://macaron-office.onrender.com';
  try {
    const [ads, cust] = await Promise.all([
      fetch(base + '/api/meta/ads/insights').then(r => r.json()).catch(() => null),
      fetch(base + '/api/customer-hub/dashboard').then(r => r.json()).catch(() => null),
    ]);
    const impressions = (ads && ads.data && ads.data[0] && +ads.data[0].impressions) || 0;
    const clicks = (ads && ads.data && ads.data[0] && +ads.data[0].clicks) || 0;
    const inquiries = (cust && cust.inquiries && cust.inquiries.total) || 0;
    const customers_total = (cust && cust.groups && cust.groups.summary && cust.groups.summary.total) || 0;
    const ctr = impressions > 0 ? ((clicks / impressions) * 100).toFixed(2) : '0';
    const inq_rate = clicks > 0 ? ((inquiries / clicks) * 100).toFixed(1) : '0';
    const lines = [
      '📊 轉換漏斗週報 (過去 7 天)',
      '',
      `  曝光: ${impressions.toLocaleString()}`,
      `   ↓ ${ctr}% CTR`,
      `  點擊: ${clicks.toLocaleString()}`,
      `   ↓ ${inq_rate}% 詢問轉換`,
      `  詢問: ${inquiries}`,
      `   ↓ -`,
      `  客戶: ${customers_total}`,
    ];
    if (clicks > 0 && parseFloat(inq_rate) < 5) {
      lines.push('\n  🚨 點擊 → 詢問漏最多 (詢問轉換率 < 5%)');
      lines.push('     建議: CAMILLE 強化 IG 限時動態 CTA + 直接報價');
    } else if (parseFloat(ctr) < 1) {
      lines.push('\n  🚨 曝光 → 點擊漏最多 (CTR < 1%)');
      lines.push('     建議: ARIA 視覺 + CAMILLE 文案翻新');
    }
    return lines.join('\n');
  } catch (e) {
    console.error('[conversionFunnelWeeklyReport]', e.message);
    return null;
  }
}

// ============================================================
// B2 — Cron 錯誤推 Telegram
// ============================================================
async function notifyError(source, error) {
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  if (!tgToken || !tgChat) return;
  try {
    const text = '⚠️ 系統錯誤 ' + new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) +
      '\n\n來源: ' + source +
      '\n訊息: ' + ((error && error.message) || String(error)).slice(0, 400);
    await fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChat, text }),
    });
  } catch {}
}

function wrapCron(name, fn) {
  return async () => {
    try { await fn(); }
    catch (e) {
      console.error('[cron:' + name + ']', e.message);
      await notifyError('cron:' + name, e);
    }
  };
}

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
    '（VICTOR 從客戶經營 / 內容創作 / 門店體驗三個角度，給三件最關鍵的事）',
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
    '本週成績：禮盒銷量 / 客戶互動 / 各門店表現',
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

async function marketSection() {
  if (!marketIntel) return null;
  try {
    const intel = marketIntel.loadLatestIntel();
    if (!intel) return null;
    const lines = ['🌍 今日市場掃描 (' + intel.date + ')'];
    const stats = intel.summary_stats || {};
    lines.push(`  📰 ${stats.total_news || 0} 篇新聞 · 💬 ${stats.total_ptt || 0} PTT · 🎓 ${stats.total_dcard || 0} Dcard · 🔥 ${stats.total_gtrends || 0} GTrends · 📢 ${stats.total_fb_ads || 0} 對手廣告`);

    // Google Trends Top 3
    if (Array.isArray(intel.google_trends) && intel.google_trends.length > 0) {
      lines.push('\n  🔥 今日熱搜 Top 3:');
      intel.google_trends.slice(0, 3).forEach(t => {
        lines.push(`     • ${t.keyword}${t.traffic ? ' (' + t.traffic + ')' : ''}`);
      });
    }

    // PTT 熱門討論 (合計 top 3)
    const pttTop = [];
    for (const items of Object.values(intel.ptt || {})) {
      if (Array.isArray(items)) pttTop.push(...items.slice(0, 1));
    }
    if (pttTop.length) {
      lines.push('\n  💬 PTT 討論 Top 3:');
      pttTop.slice(0, 3).forEach(it => lines.push(`     • ${it.title.slice(0, 60)}`));
    }

    // Dcard 熱門 (合計 top 3)
    const dcardTop = [];
    for (const items of Object.values(intel.dcard || {})) {
      if (Array.isArray(items)) dcardTop.push(...items.slice(0, 1));
    }
    if (dcardTop.length) {
      lines.push('\n  🎓 Dcard 話題 Top 3:');
      dcardTop.slice(0, 3).forEach(it => lines.push(`     • [${it.forum}] ${it.title.slice(0, 50)} (❤${it.like || 0})`));
    }

    // 對手廣告 top 3
    if (Array.isArray(intel.fb_ads) && intel.fb_ads.length > 0) {
      lines.push('\n  📢 對手在跑的廣告 Top 3:');
      intel.fb_ads.slice(0, 3).forEach(ad => {
        const hook = (ad.body || ad.title || '').slice(0, 60);
        lines.push(`     • [${ad.page}] ${hook}`);
      });
    }
    return lines.join('\n');
  } catch (e) {
    console.error('[alerts marketSection]', e.message);
    return null;
  }
}

async function dailyBriefing() {
  const wd = getWeekday();
  const date = new Date().toLocaleDateString('zh-TW', { timeZone: TZ });

  const sections = [];
  sections.push(`☀️ VICTOR 早安簡報 — ${date} ${todayLabel()}`);
  sections.push('');

  // [REMOVED] 廣告 section — 老闆要求不顯示

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

  const custConv = await customerConversationDailyReport();
  if (custConv) sections.push(custConv);

  const market = await marketSection();
  if (market) sections.push(market);

  if (wd === 0) {
    const funnel = await conversionFunnelWeeklyReport();
    if (funnel) sections.push(funnel);
  }

  const pending = await pendingDecisionsSection();
  if (pending) sections.push(pending);

  return sections.filter(Boolean).join('\n\n');
}

async function sendBriefing() {
  // Telegram-only: 簡報只推到 Telegram, 不發 LINE 官方帳號 (避免騷擾客戶)
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  if (!tgToken || !tgChat) {
    console.warn("[alerts] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set, briefing not sent");
    return { ok: false, reason: "TELEGRAM env not set" };
  }
  try {
    const text = await dailyBriefing();
    const trimmed = text.slice(0, 4000);
    const r = await fetch("https://api.telegram.org/bot" + tgToken + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tgChat, text: trimmed })
    });
    const j = await r.json();
    if (!j.ok) throw new Error("Telegram sendMessage failed: " + JSON.stringify(j));
    console.log("[alerts] daily briefing sent via Telegram, length=" + text.length);
    return { ok: true, length: text.length };
  } catch (err) {
    console.error("[alerts] sendBriefing failed:", err.message);
    return { ok: false, reason: err.message };
  }
}

async function checkAdsAlerts() {
  // Telegram-only: 廣告警示也只推 Telegram, 不發 LINE
  if (!meta) return;
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  if (!tgToken || !tgChat) return;
  try {
    if (typeof meta.getAdsSnapshot !== 'function') return;
    const snap = await meta.getAdsSnapshot({ hours: 1 });
    const alerts = [];
    if (snap.roas !== undefined && snap.roas < 1.0 && snap.spend >= 1000) {
      alerts.push(`🔴 廣告紅燈 ROAS ${snap.roas} (花費 NT$${snap.spend})`);
    }
    if (snap.spend >= 5000 && (snap.purchases || 0) === 0) {
      alerts.push(`🔴 燒了 NT$${snap.spend} 但 0 成交,建議暫停 underperformer`);
    }
    if (alerts.length > 0) {
      await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChat, text: alerts.join('\n\n') })
      });
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
  cron.schedule('0 9 * * *', wrapCron('dailyBriefing', sendBriefing), { timezone: TZ });
  // [REMOVED] cron.schedule('*/30 * * * *', checkAdsAlerts, { timezone: TZ }); // 老闆要求不推廣告警示
  cron.schedule('0 18 * * 0', wrapCron('weeklyFunnel', async () => {
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChat = process.env.TELEGRAM_CHAT_ID;
    if (!tgToken || !tgChat) return;
    const report = await conversionFunnelWeeklyReport();
    if (!report) return;
    await fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChat, text: report }),
    });
  }), { timezone: TZ });
  console.log('[alerts] cron: daily 09:00 briefing + Sunday 18:00 funnel + error notification');
}

function loadAdmin(dataDir) {
  try {
    const file = path.join(dataDir || __dirname, 'admin.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return {};
}

function registerAdminFromLine(dataDir, userId, displayName) {
  try {
    const file = path.join(dataDir || __dirname, 'admin.json');
    fs.writeFileSync(file, JSON.stringify({ lineUserId: userId, userName: displayName || '', registeredAt: new Date().toISOString() }, null, 2));
  } catch (e) { console.error('[alerts] registerAdmin failed:', e.message); }
}

module.exports = { dailyBriefing, sendBriefing, checkAdsAlerts, registerCronJobs, loadAdmin, registerAdminFromLine, customerConversationDailyReport, conversionFunnelWeeklyReport, notifyError, wrapCron };
