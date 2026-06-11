// ai-team-upgrades.js — 一次裝 3 個升級
// #3 真實數字注入(employees.js 自動 prepend)
// #4 每日 06:30 推「今日三件事」到 Telegram
// #endpoint /api/upgrades/* 給 debug
//
// 自動學偏好(#1)在 memory-widget.js v5 前端 fetch hook 內做。

let _statsCache = { ts: 0, head: '', raw: null };
const STATS_CACHE_MS = 5 * 60 * 1000;

async function fetchStats(origin) {
  try {
    const base = origin || ('http://localhost:' + (process.env.PORT || 3000));
    const [summaryR, listR, shoplineR] = await Promise.all([
      fetch(base + '/api/offline-reports/summary').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(base + '/api/offline-reports/list?limit=80').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(base + '/api/shopline/orders-summary?days=1').then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    return { summary: summaryR, recent: listR, shopline_today: shoplineR };
  } catch { return null; }
}

function buildStatsHead(data) {
  if (!data) return '';
  const s = (data.summary && data.summary.ok !== false) ? data.summary : {};
  const recent = (data.recent && data.recent.reports) || [];

  const ago7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const last7 = recent.filter(r => r.report_date && r.report_date >= ago7);
  const byBranch = {};
  last7.forEach(r => {
    if (!r.branch) return;
    if (!byBranch[r.branch]) byBranch[r.branch] = { revenue: 0, orders: 0, days: 0 };
    byBranch[r.branch].revenue += (r.revenue || 0);
    byBranch[r.branch].orders += (r.orders || 0);
    byBranch[r.branch].days++;
  });

  const lines = [];
  lines.push('【📊 即時營運數字(寫文案/做分析請優先用這些真實數字,不准編造)】');
  if (s.total_revenue !== undefined) {
    lines.push('全店累計:' + (s.total_reports || 0) + ' 筆報告,總營收 NT$' + (s.total_revenue || 0).toLocaleString() + ',訂單 ' + (s.total_orders || 0) + ' 筆');
  }
  if (s.revenue_30 !== undefined) {
    lines.push('最近 30 天:NT$' + (s.revenue_30 || 0).toLocaleString() + ' (' + (s.recent_30 || 0) + ' 筆)');
  }
  if (s.revenue_7 !== undefined) {
    lines.push('最近 7 天:NT$' + (s.revenue_7 || 0).toLocaleString() + ' (' + (s.recent_7 || 0) + ' 筆)');
  }
  if (Object.keys(byBranch).length) {
    lines.push('各門市最近 7 天:');
    Object.entries(byBranch).forEach(([b, v]) => {
      const aov = v.orders ? Math.round(v.revenue / v.orders) : 0;
      lines.push('  ▸ ' + b + ': NT$' + v.revenue.toLocaleString() + ' (' + v.orders + ' 單 / ' + v.days + ' 天 / 客單 NT$' + aov + ')');
    });
  }
  const sl = data.shopline_today;
  if (sl && sl.ok) {
    lines.push('Shopline 線上(今日):' + (sl.count || 0) + ' 筆,營收 NT$' + (sl.total_revenue || 0).toLocaleString() + ',AOV NT$' + (sl.aov_all || 0));
    if (sl.top_skus && sl.top_skus.length) {
      lines.push('Shopline 熱賣前 3:' + sl.top_skus.slice(0, 3).map(t => t.sku + '×' + t.q).join(' / '));
    }
  }
  if (s.problem_count > 0) lines.push('⚠️ 待解問題 ' + s.problem_count + ' 個');
  return '\n\n' + lines.join('\n') + '\n';
}

async function refreshStatsCache(origin) {
  try {
    const raw = await fetchStats(origin);
    _statsCache = { ts: Date.now(), head: buildStatsHead(raw), raw };
  } catch (e) {
    // 留舊 cache
  }
}

// 同步讀(Proxy 必須 sync)
function getLiveStatsHead() {
  return _statsCache.head || '';
}

// SSE 解析(把 /api/chat 串流文字壓回純文字)
function parseSSEText(sse) {
  let out = '';
  (sse || '').split('\n').forEach(line => {
    if (!line.startsWith('data:')) return;
    try {
      const d = JSON.parse(line.slice(5).trim());
      if (d.text) out += d.text;
      if (d.delta) out += d.delta;
      if (d.caption) out += d.caption + '\n';
      if (d.description) out += d.description + '\n';
      if (d.message) out += d.message + '\n';
    } catch { }
  });
  return out;
}

// 每日三件事
async function runDailyBrief(origin) {
  const base = origin || ('http://localhost:' + (process.env.PORT || 3000));
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  if (!tgToken || !tgChat) return { ok: false, reason: 'no telegram env' };
  try {
    await refreshStatsCache(base);
    const stats = getLiveStatsHead();
    const prompt =
      '根據以下即時數字直接給我「今天該做的 3 件事」。\n\n' +
      '規則:\n' +
      '• 每件事一行,動作明確、有對象、有可量化結果\n' +
      '• 不要寒暄、不要前言、不要結尾、不要表情符號排版\n' +
      '• 順序:最緊急 → 中度 → 機會\n' +
      '• 結尾加一句「我建議優先做第 X 件,因為 ____」\n\n' +
      stats +
      '\n格式:\n1. [動作]:[原因 + 預期]\n2. [動作]:[原因 + 預期]\n3. [動作]:[原因 + 預期]\n──\n我的建議:優先做第 X,因為 ____';

    const r = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: 'victor', messages: [{ role: 'user', content: prompt }] })
    });
    const sse = await r.text();
    let aiText = parseSSEText(sse);
    if (!aiText) aiText = '(VICTOR 沒回應,可能在學習中)';
    // 去 HTML 標籤(VICTOR 用 HTML 片段)
    aiText = aiText.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();

    const msg = '☀️ 今日三件事 · ' + new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }) + '\n' +
      '──────────\n' + aiText.slice(0, 2500);
    await fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChat, text: msg })
    });
    return { ok: true, brief: aiText.slice(0, 500) + (aiText.length > 500 ? '...' : '') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function register(app, cron) {
  // 啟動先 warm 一次
  setTimeout(() => refreshStatsCache(), 8000);
  // 每 5 分鐘背景 refresh
  setInterval(() => refreshStatsCache(), STATS_CACHE_MS);

  app.get('/api/upgrades/live-stats', async (req, res) => {
    await refreshStatsCache();
    res.json({ ok: true, head: getLiveStatsHead(), cached_at: new Date(_statsCache.ts).toISOString(), raw: _statsCache.raw });
  });
  app.get('/api/upgrades/daily-brief/run', async (req, res) => {
    const r = await runDailyBrief();
    res.json(r);
  });
  app.get('/api/upgrades/status', (req, res) => {
    res.json({
      ok: true,
      live_stats: {
        cache_age_min: _statsCache.ts ? Math.floor((Date.now() - _statsCache.ts) / 60000) : null,
        head_length: getLiveStatsHead().length,
      },
      daily_brief: {
        cron: '30 6 * * * Asia/Taipei',
        telegram_ready: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
      },
      auto_learn: {
        location: 'memory-widget.js v5 (前端 fetch hook)',
        endpoint: '/api/memory/extract',
      }
    });
  });

  if (cron && typeof cron.schedule === 'function') {
    const tz = process.env.TZ || 'Asia/Taipei';
    cron.schedule('30 6 * * *', async () => {
      try {
        const r = await runDailyBrief();
        console.log('[ai-team-upgrades] daily brief 06:30:', r.ok ? 'sent' : (r.reason || r.error));
      } catch (e) { console.error('[ai-team-upgrades] brief err:', e.message); }
    }, { timezone: tz });
    console.log('[ai-team-upgrades] cron registered: 30 6 * * * Asia/Taipei (daily brief)');
  }

  console.log('[ai-team-upgrades] registered: live-stats(5min refresh) + daily-brief(06:30) + auto-learn(frontend hook)');
}

module.exports = { register, getLiveStatsHead, runDailyBrief, refreshStatsCache };
