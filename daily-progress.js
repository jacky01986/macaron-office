// daily-progress.js — 每日/每週/每月進度自動同步到 Google Drive
// env: GDRIVE_SERVICE_ACCOUNT_JSON(同 gdrive-sync.js),GDRIVE_PROGRESS_FOLDER_ID
// 每日 23:30 / 週日 23:00 / 月底 23:00 自動跑

const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';

// =========== Service Account JWT → Access Token ===========
function getCreds() {
  const raw = process.env.GDRIVE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GDRIVE_SERVICE_ACCOUNT_JSON not set');
  try { return JSON.parse(raw); } catch (e) { throw new Error('GDRIVE_SERVICE_ACCOUNT_JSON parse err: ' + e.message); }
}
function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
async function getAccessToken() {
  const c = getCreds();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: c.client_email,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const sig = base64url(crypto.sign('RSA-SHA256', Buffer.from(header + '.' + payload), c.private_key));
  const jwt = header + '.' + payload + '.' + sig;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('OAuth fail: ' + JSON.stringify(d));
  return d.access_token;
}

// =========== 上傳檔案到 Drive ===========
async function uploadFile(name, content, folderId, mimeType) {
  const token = await getAccessToken();
  mimeType = mimeType || 'text/markdown';
  const boundary = '----macaronBoundary' + Math.random().toString(36).slice(2);
  const meta = { name, parents: [folderId], mimeType };
  const body =
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(meta) + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: ' + mimeType + '\r\n\r\n' +
    content + '\r\n' +
    '--' + boundary + '--';
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary },
    body
  });
  const d = await r.json();
  if (!d.id) throw new Error('upload fail: ' + JSON.stringify(d).slice(0, 300));
  return d;
}

// =========== 拉資料來源 ===========
async function fetchSrc(origin) {
  const base = origin || ('http://localhost:' + (process.env.PORT || 3000));
  async function jget(p) { try { const r = await fetch(base + p); return r.ok ? await r.json() : null; } catch { return null; } }
  return {
    edm_stats: await jget('/api/personal-edm/stats'),
    edm_queue: await jget('/api/personal-edm/queue'),
    edm_candidates: await jget('/api/personal-edm/candidates'),
    offline_summary: await jget('/api/offline-reports/summary'),
    offline_list: await jget('/api/offline-reports/list?limit=20'),
    shopline_today: await jget('/api/shopline/orders-summary?days=1'),
    shopline_7d: await jget('/api/shopline/orders-summary?days=7'),
    closer_board: await jget('/api/closer/board'),
    upgrades_status: await jget('/api/upgrades/status')
  };
}

// 拉 GitHub commits(過去 24/7/30 天)
async function fetchCommits(daysBack) {
  const since = new Date(Date.now() - daysBack * 86400000).toISOString();
  try {
    const r = await fetch('https://api.github.com/repos/jacky01986/macaron-office/commits?sha=prod-stable&since=' + since + '&per_page=100');
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d.map(c => ({
      sha: (c.sha || '').slice(0, 7),
      msg: (c.commit && c.commit.message || '').split('\n')[0],
      date: c.commit && c.commit.author && c.commit.author.date
    })) : [];
  } catch { return []; }
}

// =========== NOVA 整理報告 ===========
async function generateMarkdown(period, src, commits) {
  const dateStr = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
  const periodLabel = { daily: '今日', weekly: '本週', monthly: '本月' }[period] || period;

  // 萃取數據
  const s = src.edm_stats && src.edm_stats.last_7d || {};
  const o = src.offline_summary || {};
  const slToday = src.shopline_today || {};
  const slWeek = src.shopline_7d || {};
  const board = src.closer_board || {};

  const factsBlock = [
    '【關鍵數字】',
    'EDM 個人化觸及(過去 7 天):寄出 ' + (s.sent || 0) + ' 封 / 回訊 ' + (s.replied || 0) + ' 位 / 回流 ' + (s.ordered || 0) + ' 筆 / 營收 NT$' + (s.revenue || 0).toLocaleString() + ' / 轉換率 ' + (s.conversion_pct || 0) + '%',
    '線下報告中心:累積 ' + (o.total_reports || 0) + ' 筆 · 總營收 NT$' + (o.total_revenue || 0).toLocaleString() + ' · 訂單 ' + (o.total_orders || 0) + ' 筆 · 最近 7 天 NT$' + (o.revenue_7 || 0).toLocaleString(),
    'Shopline 線上(今日):' + (slToday.count || 0) + ' 單 · NT$' + (slToday.total_revenue || 0).toLocaleString() + ' · AOV NT$' + (slToday.aov_all || 0),
    'Shopline 線上(7 天):' + (slWeek.count || 0) + ' 單 · NT$' + (slWeek.total_revenue || 0).toLocaleString(),
    'SaleSmartly 對話板:' + (board.total || 0) + ' 個進行中 · 熱客戶 ' + (board.counts && board.counts.hot || 0) + ' · 等回 ' + (board.counts && board.counts.waiting || 0)
  ].join('\n');

  const commitsBlock = commits.length
    ? '【系統改動】\n' + commits.slice(0, 50).map(c => '• `' + c.sha + '` ' + c.msg).join('\n')
    : '【系統改動】\n(無)';

  const sys = '你是溫點 WarmPlace 的 AI 助理。為老闆寫一份「' + periodLabel + '進度報告」,他下班後會回去看。\n\n' +
    '規則:\n' +
    '1. 用 Markdown 格式,有標題、區塊、列點\n' +
    '2. 開頭用一句話總結今天/本週/本月最重要的事(1 行)\n' +
    '3. 接著分區塊呈現:🎯 重要成果 / 💰 數字 / 🛠️ 系統改動 / ⚠️ 該注意 / 🌅 明天/下週/下月建議\n' +
    '4. 數字必須引用下面提供的「關鍵數字」,不准編造\n' +
    '5. 系統改動引用下面提供的 commit 清單,寫成人話(不用 commit hash)\n' +
    '6. 溫暖但專業,像認真的工頭交班\n' +
    '7. 結尾留一句鼓勵或反思\n' +
    '8. 不要超過 800 字';

  const userMsg = '報告類型:' + periodLabel + '\n日期:' + dateStr + '\n\n' + factsBlock + '\n\n' + commitsBlock + '\n\n請整理成 Markdown 報告。';

  try {
    const r = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: sys,
      messages: [{ role: 'user', content: userMsg }]
    });
    return (r.content || []).map(c => c.text || '').join('').trim();
  } catch (e) {
    // fallback:純資料,不靠 AI
    return '# ' + periodLabel + '進度報告 · ' + dateStr + '\n\n' + factsBlock + '\n\n' + commitsBlock + '\n\n_(NOVA 整理失敗,純資料版)_';
  }
}

// =========== 主流程 ===========
async function runReport(period, origin) {
  const folderId = process.env.GDRIVE_PROGRESS_FOLDER_ID;
  if (!folderId) {
    console.warn('[daily-progress] GDRIVE_PROGRESS_FOLDER_ID not set — skip');
    return { ok: false, reason: 'no folder id' };
  }

  const daysMap = { daily: 1, weekly: 7, monthly: 31 };
  const days = daysMap[period] || 1;

  const src = await fetchSrc(origin);
  const commits = await fetchCommits(days);
  const md = await generateMarkdown(period, src, commits);

  const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }).replace(/\//g, '-');
  const periodLabel = { daily: '日報', weekly: '週報', monthly: '月報' }[period] || period;
  const filename = today + ' ' + periodLabel + '.md';

  const uploaded = await uploadFile(filename, md, folderId, 'text/markdown');

  // Telegram 通知
  const tgToken = process.env.TELEGRAM_BOT_TOKEN, tgChat = process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) {
    const tgMsg = '📂 ' + periodLabel + ' 已存 Drive · ' + filename + '\n\n預覽:\n' + md.slice(0, 400) + (md.length > 400 ? '...' : '');
    try {
      await fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChat, text: tgMsg })
      });
    } catch {}
  }

  return { ok: true, file_id: uploaded.id, filename, md_chars: md.length };
}

// =========== Express + Cron 註冊 ===========
function register(app, cron) {
  app.post('/api/daily-progress/run/:period', async (req, res) => {
    try {
      const period = req.params.period || 'daily';
      const origin = 'http://localhost:' + (process.env.PORT || 3000);
      const r = await runReport(period, origin);
      res.json(r);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/daily-progress/health', (req, res) => {
    res.json({
      ok: true,
      folder_id_set: !!process.env.GDRIVE_PROGRESS_FOLDER_ID,
      service_account_set: !!process.env.GDRIVE_SERVICE_ACCOUNT_JSON,
      telegram_set: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
      cron_schedules: ['daily 23:30', 'weekly Sun 23:00', 'monthly last-day 23:00']
    });
  });

  if (cron && typeof cron.schedule === 'function') {
    const tz = process.env.TZ || 'Asia/Taipei';
    // 每日 23:30
    cron.schedule('30 23 * * *', async () => {
      try {
        const origin = 'http://localhost:' + (process.env.PORT || 3000);
        const r = await runReport('daily', origin);
        console.log('[daily-progress] daily ran:', r.ok ? r.filename : r.reason);
      } catch (e) { console.error('[daily-progress] daily err:', e.message); }
    }, { timezone: tz });

    // 週日 23:00
    cron.schedule('0 23 * * 0', async () => {
      try {
        const origin = 'http://localhost:' + (process.env.PORT || 3000);
        const r = await runReport('weekly', origin);
        console.log('[daily-progress] weekly ran:', r.ok ? r.filename : r.reason);
      } catch (e) { console.error('[daily-progress] weekly err:', e.message); }
    }, { timezone: tz });

    // 每月最後一天 23:00 — 用 28-31 號 hack:若隔天是 1 號就跑
    cron.schedule('0 23 28-31 * *', async () => {
      const tomorrow = new Date(Date.now() + 86400000);
      if (tomorrow.getDate() !== 1) return;  // 不是月底
      try {
        const origin = 'http://localhost:' + (process.env.PORT || 3000);
        const r = await runReport('monthly', origin);
        console.log('[daily-progress] monthly ran:', r.ok ? r.filename : r.reason);
      } catch (e) { console.error('[daily-progress] monthly err:', e.message); }
    }, { timezone: tz });

    console.log('[daily-progress] cron registered: daily 23:30 + weekly Sun 23:00 + monthly last-day 23:00');
  }

  console.log('[daily-progress] registered: /run/:period + /health + 3 cron jobs');
}

module.exports = { register, runReport, uploadFile, getAccessToken };
