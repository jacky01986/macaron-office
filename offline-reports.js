// offline-reports.js — 線下報告中心
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
router.use(express.json({ limit: '5mb' }));

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const REPORTS_FILE = path.join(DATA_DIR, 'offline-reports.jsonl');

function ensureDir() { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {} }
function loadAll() {
  if (!fs.existsSync(REPORTS_FILE)) return [];
  try { return fs.readFileSync(REPORTS_FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
function appendReport(r) { ensureDir(); fs.appendFileSync(REPORTS_FILE, JSON.stringify(r) + '\n'); }

router.post('/submit', async (req, res) => {
  try {
    const b = req.body || {};
    const rec = { id: 'rpt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), ts: new Date().toISOString(), report_date: b.report_date || new Date().toISOString().slice(0, 10), type: b.type || 'daily', branch: b.branch || '', author: b.author || '', revenue: parseFloat(b.revenue) || 0, orders: parseInt(b.orders) || 0, problems: (b.problems || '').slice(0, 5000), review: (b.review || '').slice(0, 5000), action_items: (b.action_items || '').slice(0, 3000), notes: (b.notes || '').slice(0, 3000), attachment_url: b.attachment_url || '' };
    appendReport(rec);
    res.json({ ok: true, id: rec.id, record: rec });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/list', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const reports = loadAll().sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, limit);
    res.json({ ok: true, count: reports.length, reports });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/summary', (req, res) => {
  try {
    const reports = loadAll();
    const now = Date.now();
    const r30 = reports.filter(r => (now - new Date(r.ts).getTime()) <= 30 * 86400000);
    const r7 = reports.filter(r => (now - new Date(r.ts).getTime()) <= 7 * 86400000);
    const totalRev30 = r30.reduce((s, r) => s + (r.revenue || 0), 0);
    const totalRev7 = r7.reduce((s, r) => s + (r.revenue || 0), 0);
    const problems = [];
    r30.forEach(r => { if (r.problems) r.problems.split(/[\n,，、;；]+/).map(s => s.trim()).filter(Boolean).forEach(p => problems.push({ p, branch: r.branch, date: r.report_date })); });
    const byDate = {};
    r30.forEach(r => { const d = r.report_date || r.ts.slice(0, 10); byDate[d] = (byDate[d] || 0) + (r.revenue || 0); });
    const revTrend = Object.entries(byDate).sort((a, b) => a[0].localeCompare(b[0])).map(([date, rev]) => ({ date, revenue: rev }));
    const byBranch = {};
    r30.forEach(r => { const bn = r.branch || '(未指定)'; if (!byBranch[bn]) byBranch[bn] = { branch: bn, count: 0, revenue: 0, problems: 0 }; byBranch[bn].count++; byBranch[bn].revenue += r.revenue || 0; if (r.problems) byBranch[bn].problems++; });
    res.json({ ok: true, generated_at: new Date().toISOString(), total_reports: reports.length, recent_30: r30.length, recent_7: r7.length, revenue_30: Math.round(totalRev30), revenue_7: Math.round(totalRev7), problem_count: problems.length, recent_problems: problems.slice(-20).reverse(), action_items: r30.filter(r => r.action_items).map(r => ({ branch: r.branch, date: r.report_date, items: r.action_items })).slice(-10).reverse(), revenue_trend: revTrend.slice(-14), by_branch: Object.values(byBranch).sort((a, b) => b.revenue - a.revenue) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/report/:id', (req, res) => {
  try { const r = loadAll().find(x => x.id === req.params.id); if (!r) return res.status(404).json({ ok: false, error: 'not found' }); res.json({ ok: true, report: r }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

function buildSummaryForAI() {
  try {
    const reports = loadAll();
    if (reports.length === 0) return { ok: true, empty: true, message: '尚無線下報告上傳' };
    const now = Date.now();
    const r30 = reports.filter(r => (now - new Date(r.ts).getTime()) <= 30 * 86400000);
    const totalRev = r30.reduce((s, r) => s + (r.revenue || 0), 0);
    const allProblems = [];
    r30.forEach(r => { if (r.problems) r.problems.split(/[\n,，、;；]+/).map(s => s.trim()).filter(Boolean).forEach(p => allProblems.push(p)); });
    return { ok: true, report_count_30d: r30.length, total_revenue_30d: Math.round(totalRev), recent_problems: allProblems.slice(-15), recent_reports_brief: r30.slice(-5).map(r => ({ date: r.report_date, branch: r.branch, revenue: r.revenue, problems_excerpt: (r.problems||'').slice(0,200), review_excerpt: (r.review||'').slice(0,200) })) };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function sendDailyDigestToTelegram() {
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  if (!tgToken || !tgChat) return { ok: false, reason: 'no telegram env' };
  try {
    const reports = loadAll();
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const yR = reports.filter(r => r.report_date === yesterday);
    if (yR.length === 0) {
      const msg = '📋 *線下報告早報*\n\n昨日(' + yesterday + ')沒有新報告上傳';
      const r = await fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: tgChat, text: msg, parse_mode: 'Markdown' }) });
      return { ok: r.ok, sent: 0 };
    }
    const totalRev = yR.reduce((s, r) => s + (r.revenue || 0), 0);
    const totalOrders = yR.reduce((s, r) => s + (r.orders || 0), 0);
    const branches = [...new Set(yR.map(r => r.branch).filter(Boolean))];
    const allProblems = [];
    yR.forEach(r => { if (r.problems) r.problems.split(/[\n,，、;；]+/).map(s => s.trim()).filter(Boolean).forEach(p => allProblems.push('  - ' + p)); });
    const allActions = [];
    yR.forEach(r => { if (r.action_items) r.action_items.split(/[\n,，、;；]+/).map(s => s.trim()).filter(Boolean).forEach(a => allActions.push('  - ' + a)); });
    const text = '📋 *線下報告早報 — ' + yesterday + '*\n────────────────\n報告: ' + yR.length + ' 份 | 門市: ' + branches.length + ' 家\n營收: NT$' + totalRev.toLocaleString() + '\n訂單: ' + totalOrders + ' 筆\n\n🚨 *昨日問題* (' + allProblems.length + '):\n' + (allProblems.slice(0, 8).join('\n') || '  - 無') + '\n\n✅ *行動項目* (' + allActions.length + '):\n' + (allActions.slice(0, 8).join('\n') || '  - 無');
    const r = await fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: tgChat, text, parse_mode: 'Markdown' }) });
    return { ok: r.ok, sent: yR.length };
  } catch (e) { return { ok: false, error: e.message }; }
}

router.get('/send-digest', async (req, res) => { res.json(await sendDailyDigestToTelegram()); });

function registerCron(cron) {
  if (!cron || typeof cron.schedule !== 'function') return;
  const tz = process.env.TZ || 'Asia/Taipei';
  cron.schedule('0 8 * * *', async () => { try { const r = await sendDailyDigestToTelegram(); console.log('[offline-reports] 08:00 digest:', r.ok ? 'sent ' + (r.sent || 0) : r.reason || r.error); } catch (e) { console.error('[offline-reports] cron failed:', e.message); } }, { timezone: tz });
  console.log('[offline-reports] cron registered (daily 08:00)');
}

module.exports = router;
module.exports.buildSummaryForAI = buildSummaryForAI;
module.exports.sendDailyDigestToTelegram = sendDailyDigestToTelegram;
module.exports.registerCron = registerCron;
