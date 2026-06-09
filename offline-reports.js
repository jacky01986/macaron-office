// offline-reports.js — 線下報告中心 (檔案上傳 + Claude 自動萃取 + AI 員工餵食)
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const ExcelJS = require('exceljs');

const router = express.Router();

const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/var/data') ? '/var/data' : '/tmp/data');
const REPORTS_FILE = path.join(DATA_DIR, 'offline-reports.jsonl');
const UPLOADS_DIR = path.join(DATA_DIR, 'offline-uploads');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}

const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 25 * 1024 * 1024 } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.use(express.json({ limit: '5mb' }));

function loadAll() {
  try {
    if (!fs.existsSync(REPORTS_FILE)) return [];
    return fs.readFileSync(REPORTS_FILE, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}
function appendReport(r) { fs.appendFileSync(REPORTS_FILE, JSON.stringify(r) + '\n'); return r; }
function genId() { return 'rpt_' + Math.random().toString(36).slice(2, 16); }

const EXTRACT_SYS = `你是溫點 WarmPlace 烘焙坊的營運分析師。從上傳的報告/單據/照片中萃取結構化資料。只回傳純 JSON,絕對不要前綴後綴或 markdown。欄位:
{"date":"YYYY-MM-DD","branch":"門市名","author":"填寫人","revenue":數字,"orders":數字,"problems":"問題點\\n問題點","review":"檢討觀察","action_items":"待辦\\n待辦","notes":"備註","type":"daily|weekly|event|problem|other","summary":"一句話摘要15字內"}
判斷不出來的欄位,字串填"",數字填0。日期一定YYYY-MM-DD格式。`;

async function extractWithClaude(messages) {
  const result = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    system: EXTRACT_SYS,
    messages
  });
  const respText = (result.content || []).map(c => c.text || '').join('');
  let extracted = {};
  try { const m = respText.match(/\{[\s\S]*\}/); if (m) extracted = JSON.parse(m[0]); }
  catch (e) { extracted = { _raw: respText.slice(0, 500), _parse_error: e.message }; }
  return { extracted, raw: respText };
}

router.post('/upload-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: '沒有檔案' });
    const filePath = req.file.path;
    const origName = req.file.originalname;
    const ext = (path.extname(origName) || '').toLowerCase();
    const mime = (req.file.mimetype || '').toLowerCase();
    let messages, preview = '';

    if (ext === '.pdf' || mime === 'application/pdf') {
      const b64 = fs.readFileSync(filePath).toString('base64');
      messages = [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: '請萃取此 PDF 報告為結構化 JSON' }] }];
    } else if (mime.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
      const b64 = fs.readFileSync(filePath).toString('base64');
      let mt = mime && mime.startsWith('image/') ? mime : (ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg');
      messages = [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mt, data: b64 } }, { type: 'text', text: '請萃取此照片中的報告內容為結構化 JSON' }] }];
    } else if (ext === '.xlsx' || ext === '.xls') {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(filePath);
      const rows = [];
      wb.eachSheet(sheet => {
        rows.push('=== ' + sheet.name + ' ===');
        sheet.eachRow(row => { rows.push((row.values || []).slice(1).map(v => (v === null || v === undefined) ? '' : String(v)).join('\t')); });
      });
      preview = rows.join('\n').slice(0, 30000);
      messages = [{ role: 'user', content: '以下是 Excel 報告內容,請萃取為結構化 JSON:\n\n' + preview }];
    } else if (ext === '.csv') {
      preview = fs.readFileSync(filePath, 'utf8').slice(0, 30000);
      messages = [{ role: 'user', content: '以下是 CSV 報告,請萃取為結構化 JSON:\n\n' + preview }];
    } else if (ext === '.txt' || ext === '.md') {
      preview = fs.readFileSync(filePath, 'utf8').slice(0, 30000);
      messages = [{ role: 'user', content: '以下是報告文字,請萃取為結構化 JSON:\n\n' + preview }];
    } else if (ext === '.docx') {
      try {
        const raw = fs.readFileSync(filePath).toString('binary');
        const textMatches = raw.match(/<w:t[^>]*>([^<]+)<\/w:t>/g) || [];
        preview = textMatches.map(m => m.replace(/<[^>]+>/g, '')).join(' ').slice(0, 30000);
        if (!preview) preview = '(docx 內容無法解析,建議另存為 PDF 後上傳)';
        messages = [{ role: 'user', content: '以下是 Word 報告內容,請萃取為結構化 JSON:\n\n' + preview }];
      } catch (e) { return res.status(400).json({ ok: false, error: 'docx 讀取失敗: ' + e.message }); }
    } else {
      return res.status(400).json({ ok: false, error: '不支援的檔案類型: ' + (ext || mime) + '。支援 PDF/圖片/Excel/CSV/TXT/DOCX' });
    }

    const { extracted } = await extractWithClaude(messages);
    const record = {
      id: genId(),
      ts: new Date().toISOString(),
      report_date: (extracted.date && /^\d{4}-\d{2}-\d{2}$/.test(extracted.date)) ? extracted.date : new Date().toISOString().slice(0, 10),
      type: ['daily', 'weekly', 'event', 'problem', 'other'].includes(extracted.type) ? extracted.type : 'other',
      branch: String(extracted.branch || req.body.branch || '').slice(0, 100),
      author: String(extracted.author || req.body.author || '').slice(0, 50),
      revenue: Number(extracted.revenue) || 0,
      orders: Number(extracted.orders) || 0,
      problems: String(extracted.problems || '').slice(0, 5000),
      review: String(extracted.review || '').slice(0, 5000),
      action_items: String(extracted.action_items || '').slice(0, 5000),
      notes: String(extracted.notes || req.body.notes || '').slice(0, 5000),
      summary: String(extracted.summary || '').slice(0, 200),
      source_file: origName,
      source_size: req.file.size,
      source_mime: mime,
      attachment_url: '/api/offline-reports/file/' + path.basename(filePath)
    };
    appendReport(record);
    res.json({ ok: true, id: record.id, record, extracted });
  } catch (e) {
    console.error('[offline-reports] upload error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/submit', (req, res) => {
  try {
    const b = req.body || {};
    const record = {
      id: genId(), ts: new Date().toISOString(),
      report_date: b.report_date || new Date().toISOString().slice(0, 10),
      type: b.type || 'other',
      branch: String(b.branch || '').slice(0, 100),
      author: String(b.author || '').slice(0, 50),
      revenue: Number(b.revenue) || 0,
      orders: Number(b.orders) || 0,
      problems: String(b.problems || '').slice(0, 5000),
      review: String(b.review || '').slice(0, 5000),
      action_items: String(b.action_items || '').slice(0, 5000),
      notes: String(b.notes || '').slice(0, 5000),
      summary: String(b.summary || '').slice(0, 200),
      attachment_url: String(b.attachment_url || '').slice(0, 500)
    };
    appendReport(record);
    res.json({ ok: true, id: record.id, record });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// List uploaded raw files in UPLOADS_DIR (for offline-reports.html init)
router.get('/uploads', (req, res) => {
  try {
    if (!fs.existsSync(UPLOADS_DIR)) return res.json({ ok: true, files: [] });
    const files = fs.readdirSync(UPLOADS_DIR).map(name => {
      try {
        const stat = fs.statSync(path.join(UPLOADS_DIR, name));
        return { name, size: stat.size, mtime: stat.mtime.toISOString(), url: '/api/offline-reports/file/' + name };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
    res.json({ ok: true, count: files.length, files });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Monthly targets per branch (stored in /var/data/offline-targets.json)
const TARGETS_FILE = path.join(DATA_DIR, 'offline-targets.json');
function loadTargets() {
  try {
    if (!fs.existsSync(TARGETS_FILE)) return {};
    return JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8'));
  } catch { return {}; }
}
function saveTargets(t) {
  try { fs.writeFileSync(TARGETS_FILE, JSON.stringify(t, null, 2)); } catch {}
}
router.get('/targets', (req, res) => {
  res.json({ ok: true, targets: loadTargets() });
});
router.post('/targets', (req, res) => {
  try {
    const incoming = req.body || {};
    const current = loadTargets();
    const merged = { ...current, ...incoming };
    saveTargets(merged);
    res.json({ ok: true, targets: merged });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Reanalyze a single uploaded file (re-extract via Claude)
router.post('/reanalyze/:filename', async (req, res) => {
  try {
    const safe = path.basename(req.params.filename);
    const fp = path.join(UPLOADS_DIR, safe);
    if (!fs.existsSync(fp)) return res.status(404).json({ ok: false, error: 'file not found' });
    const buf = fs.readFileSync(fp);
    const ext = (path.extname(safe) || '').toLowerCase();
    const mimeMap = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv', '.txt': 'text/plain', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    const r = await processBuffer(buf, { originalName: safe, mimeType: mimeMap[ext] || '', source: 'reanalyze' });
    res.json({ ok: true, record: r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Reanalyze all uploaded files
router.post('/reanalyze-all', async (req, res) => {
  try {
    if (!fs.existsSync(UPLOADS_DIR)) return res.json({ ok: true, processed: 0 });
    const files = fs.readdirSync(UPLOADS_DIR);
    let processed = 0, errors = [];
    for (const name of files) {
      try {
        const fp = path.join(UPLOADS_DIR, name);
        const buf = fs.readFileSync(fp);
        const ext = (path.extname(name) || '').toLowerCase();
        const mimeMap = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv', '.txt': 'text/plain', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
        await processBuffer(buf, { originalName: name, mimeType: mimeMap[ext] || '', source: 'reanalyze-all' });
        processed++;
      } catch (e) { errors.push({ name, error: e.message }); }
    }
    res.json({ ok: true, processed, errors });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/list', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const all = loadAll().slice(-limit).reverse();
  res.json({ ok: true, count: all.length, reports: all });
});

router.get('/report/:id', (req, res) => {
  const r = loadAll().find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, report: r });
});

router.get('/file/:name', (req, res) => {
  const safe = path.basename(req.params.name);
  const f = path.join(UPLOADS_DIR, safe);
  if (!fs.existsSync(f)) return res.status(404).send('not found');
  res.sendFile(f);
});

router.delete('/report/:id', (req, res) => {
  const all = loadAll();
  const filtered = all.filter(x => x.id !== req.params.id);
  if (filtered.length === all.length) return res.status(404).json({ ok: false, error: 'not found' });
  fs.writeFileSync(REPORTS_FILE, filtered.map(r => JSON.stringify(r)).join('\n') + (filtered.length ? '\n' : ''));
  res.json({ ok: true, removed: req.params.id });
});

function buildSummaryForAI() {
  const all = loadAll();
  const now = Date.now();
  const day = 86400000;
  const d30 = all.filter(r => (now - new Date(r.report_date).getTime()) <= 30 * day);
  const d7 = all.filter(r => (now - new Date(r.report_date).getTime()) <= 7 * day);
  const revenue_30 = d30.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
  const revenue_7 = d7.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
  const recent_problems = [];
  d30.slice(-20).reverse().forEach(r => {
    if (r.problems) r.problems.split('\n').filter(Boolean).slice(0, 4).forEach(p => {
      recent_problems.push({ branch: r.branch, date: r.report_date, p: p.trim() });
    });
  });
  const action_items = d30.slice(-10).reverse().filter(r => r.action_items).map(r => ({ branch: r.branch, date: r.report_date, items: r.action_items }));
  const trend = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * day).toISOString().slice(0, 10);
    const rev = all.filter(r => r.report_date === d).reduce((s, r) => s + (Number(r.revenue) || 0), 0);
    trend.push({ date: d, revenue: rev });
  }
  // 用「全部」資料算 by_branch (不限 30 天),讓前端門市卡能看完整歷史
  const branchMap = {};
  all.forEach(r => {
    const b = r.branch || '(無門市)';
    if (!branchMap[b]) branchMap[b] = { branch: b, count: 0, revenue: 0, problems: 0, reports: [], by_month: {} };
    branchMap[b].count++;
    branchMap[b].revenue += Number(r.revenue) || 0;
    if (r.problems) branchMap[b].problems++;
    branchMap[b].reports.push({
      id: r.id,
      date: r.report_date,
      revenue: Number(r.revenue) || 0,
      orders: Number(r.orders) || 0,
      summary: r.summary || '',
      problems: r.problems || '',
      review: r.review || '',
      action_items: r.action_items || '',
      notes: r.notes || '',
      attachment_url: r.attachment_url || ''
    });
    // 月份統計
    const ym = (r.report_date || '').slice(0, 7);
    if (ym) {
      if (!branchMap[b].by_month[ym]) branchMap[b].by_month[ym] = { month: ym, count: 0, revenue: 0, orders: 0 };
      branchMap[b].by_month[ym].count++;
      branchMap[b].by_month[ym].revenue += Number(r.revenue) || 0;
      branchMap[b].by_month[ym].orders += Number(r.orders) || 0;
    }
  });
  // 排序每店的 reports 由新到舊,限 100 筆,by_month 轉陣列
  // 並補上前端 renderBranches 需要的欄位:aov / target / achievement / mom_change
  const targetsAll = loadTargets();
  Object.values(branchMap).forEach(b => {
    b.reports.sort((a, x) => (x.date || '').localeCompare(a.date || ''));
    b.reports = b.reports.slice(0, 100);
    const monthsArr = Object.values(b.by_month).sort((a, x) => (x.month || '').localeCompare(a.month || ''));
    // 補欄位
    monthsArr.forEach((m, i) => {
      m.aov = m.orders > 0 ? Math.round(m.revenue / m.orders) : 0;
      // 月目標 — 從 targets file(若有設)
      const tkey = b.branch + '|' + m.month;
      m.target = (targetsAll[tkey] && typeof targetsAll[tkey].target === 'number') ? targetsAll[tkey].target : null;
      m.achievement_pct = m.target ? Math.round((m.revenue / m.target) * 1000) / 10 : null;
      m.achievement = m.achievement_pct;  // alias for backward compat
      // 月增減 vs 上月(monthsArr 是新到舊)
      const prev = monthsArr[i + 1];
      if (prev && prev.revenue > 0) {
        m.mom_change = Math.round(((m.revenue - prev.revenue) / prev.revenue) * 1000) / 10;
      } else {
        m.mom_change = null;
      }
    });
    b.by_month = monthsArr;
    // 整店欄位
    b.avg_revenue = b.count > 0 ? Math.round(b.revenue / b.count) : 0;
    b.total_orders = b.reports.reduce((s, r) => s + (Number(r.orders) || 0), 0);
    b.aov = b.total_orders > 0 ? Math.round(b.revenue / b.total_orders) : 0;
  });
  const by_branch = Object.values(branchMap).sort((a, b) => b.revenue - a.revenue);
  const recent_reports_brief = all.slice(-5).reverse().map(r => ({ date: r.report_date, branch: r.branch, summary: r.summary || (r.review || '').slice(0, 80), revenue: r.revenue }));

  // 加 by_month_all_stores: 全部月份 x 全部門市的 matrix (前端「全體月份總和」用)
  const monthsSet = new Set();
  all.forEach(r => { const ym = (r.report_date || '').slice(0, 7); if (ym) monthsSet.add(ym); });
  const all_months = [...monthsSet].sort((a, b) => b.localeCompare(a));
  const all_branches = by_branch.map(b => b.branch);
  const by_month_all_stores = all_months.map(month => {
    const row = { month, by_branch: {}, total_revenue: 0, total_orders: 0 };
    all_branches.forEach(b => {
      const m = (branchMap[b].by_month || []).find(x => x.month === month);
      const rev = m ? m.revenue : 0;
      const ord = m ? m.orders : 0;
      row.by_branch[b] = { revenue: rev, orders: ord, count: m ? m.count : 0 };
      row.total_revenue += rev;
      row.total_orders += ord;
    });
    return row;
  });
  // uploads — list raw files in UPLOADS_DIR
  let uploads = [];
  try {
    if (fs.existsSync(UPLOADS_DIR)) {
      uploads = fs.readdirSync(UPLOADS_DIR).map(name => {
        try { const st = fs.statSync(path.join(UPLOADS_DIR, name)); return { name, size: st.size, mtime: st.mtime.toISOString() }; } catch { return null; }
      }).filter(Boolean).sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
    }
  } catch {}
  // expanded / skipped (前端原本用於 Excel 展開狀態,先填空)
  const expanded = [];
  const skipped = [];

  return { ok: true, generated_at: new Date().toISOString(), total_reports: all.length, recent_30: d30.length, recent_7: d7.length, revenue_30, revenue_7, problem_count: recent_problems.length, recent_problems: recent_problems.slice(0, 15), action_items, revenue_trend: trend, by_branch, recent_reports_brief, all_branches, all_months, by_month_all_stores, uploads, expanded, skipped };
}

router.get('/summary', (req, res) => {
  try { res.json(buildSummaryForAI()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

async function sendDailyDigestToTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, error: 'no telegram env' };
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const yest = loadAll().filter(r => r.report_date === yesterday);
  if (yest.length === 0) {
    return await tg(token, chatId, `📋 *線下報告早報* (${yesterday})\n\n昨日無報告上傳。`);
  }
  const rev = yest.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
  const probs = [];
  yest.forEach(r => { if (r.problems) r.problems.split('\n').filter(Boolean).forEach(p => probs.push(`• ${r.branch || '(無)'}: ${p.trim()}`)); });
  let msg = `📋 *線下報告早報* (${yesterday})\n\n📊 *${yest.length}* 份報告 / 總營收 *NT$${rev.toLocaleString()}*\n\n`;
  msg += yest.map(r => `🏪 *${r.branch || '(無門市)'}* (${r.type}) NT$${(r.revenue || 0).toLocaleString()} / ${r.orders || 0} 單${r.summary ? '\n  ↳ ' + r.summary : ''}`).join('\n\n');
  if (probs.length) msg += `\n\n🚨 *問題點 (${probs.length})*\n` + probs.slice(0, 10).join('\n');
  msg += `\n\n🔗 https://macaron-office.onrender.com/offline-reports.html`;
  return await tg(token, chatId, msg);
}

async function tg(token, chatId, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }) });
    const d = await r.json();
    return { ok: !!d.ok, telegram: d };
  } catch (e) { return { ok: false, error: e.message }; }
}

router.get('/send-digest', async (req, res) => { res.json(await sendDailyDigestToTelegram()); });

// ============ AI 分析 endpoints — 4 層 ============
const ANALYSIS_SYS = `你是溫點 WarmPlace 烘焙坊的營運分析師。根據提供的營運報告數據,給出結構化分析。只回傳純 JSON,絕對不要前綴後綴或 markdown。schema:
{
 "executive_summary": "執行摘要,1-2 句話直白點出最重要的事(30-60 字)",
 "key_insights": "深度關鍵觀察,寫一段 80-150 字的洞察(數字 + 為什麼 + 含意)",
 "top_issues": [
   {"title":"問題標題(短)","detail":"具體狀況描述(20-50 字)","expected_impact":"如不處理會怎樣 / 處理後預期改善"}
 ],
 "recommendations": [
   {"title":"建議標題","detail":"做法細節","expected_impact":"預期效果(營收/客數/效率改善)"}
 ],
 "quick_wins": ["明天就能做的事 1(動詞開頭)","明天就能做的事 2","明天就能做的事 3"]
}
top_issues 給 2-4 條,recommendations 給 2-4 條,quick_wins 給 3-5 條。資料太少時欄位填空陣列或對應字串說明。`;

async function callAnalysisClaude(prompt) {
  try {
    const result = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      system: ANALYSIS_SYS,
      messages: [{ role: 'user', content: prompt }]
    });
    const respText = (result.content || []).map(c => c.text || '').join('');
    let parsed = {};
    try { const m = respText.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); }
    catch (e) { parsed = { _raw: respText.slice(0, 500), _parse_error: e.message }; }
    return parsed;
  } catch (e) {
    return { error: e.message, summary: '分析失敗:' + e.message, key_findings: [], problems: [], recommendations: [], immediate_actions: [], risks: [] };
  }
}

function statsFromRecords(records) {
  const totalRev = records.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
  const totalOrders = records.reduce((s, r) => s + (Number(r.orders) || 0), 0);
  const branches = {};
  records.forEach(r => {
    const b = r.branch || '(無門市)';
    if (!branches[b]) branches[b] = { count: 0, revenue: 0, orders: 0 };
    branches[b].count++;
    branches[b].revenue += Number(r.revenue) || 0;
    branches[b].orders += Number(r.orders) || 0;
  });
  const problems = records.filter(r => r.problems).slice(-20).map(r => ({ date: r.report_date, branch: r.branch, problems: r.problems }));
  return { count: records.length, totalRev, totalOrders, branches, recentProblems: problems };
}

// 1. 全店分析
router.get('/analysis/all-stores', async (req, res) => {
  try {
    const all = loadAll();
    if (all.length === 0) return res.json({ ok: true, analysis: { summary: '尚無報告資料', key_findings: [], problems: [], recommendations: [], immediate_actions: [], risks: [] } });
    const stats = statsFromRecords(all);
    const prompt = `請分析溫點全體門市營運(共 ${all.length} 份報告):\n總營收 NT$${stats.totalRev.toLocaleString()}\n總訂單 ${stats.totalOrders}\n門市分布: ${JSON.stringify(stats.branches)}\n近期問題點: ${JSON.stringify(stats.recentProblems)}\n\n請給跨店比較、贏家/落後門市、共通問題、優先行動。`;
    const analysis = await callAnalysisClaude(prompt);
    res.json({ ok: true, scope: 'all-stores', stats: { total: all.length, revenue: stats.totalRev, branches: Object.keys(stats.branches).length }, analysis });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 2. 單店分析
router.get('/analysis/branch/:branch', async (req, res) => {
  try {
    const branch = decodeURIComponent(req.params.branch);
    const records = loadAll().filter(r => r.branch === branch);
    if (records.length === 0) return res.json({ ok: true, analysis: { summary: branch + ' 尚無報告', key_findings: [], problems: [], recommendations: [], immediate_actions: [], risks: [] } });
    const stats = statsFromRecords(records);
    // monthly breakdown
    const byMonth = {};
    records.forEach(r => {
      const m = (r.report_date || '').slice(0, 7);
      if (!byMonth[m]) byMonth[m] = { count: 0, revenue: 0 };
      byMonth[m].count++;
      byMonth[m].revenue += Number(r.revenue) || 0;
    });
    const prompt = `請分析「${branch}」單店營運(${records.length} 份報告):\n累計營收 NT$${stats.totalRev.toLocaleString()}\n月份分布: ${JSON.stringify(byMonth)}\n近期問題: ${JSON.stringify(stats.recentProblems.slice(-10))}\n\n請給此店的趨勢、月份變化、最大問題、改善建議。`;
    const analysis = await callAnalysisClaude(prompt);
    res.json({ ok: true, scope: 'branch', branch, stats: { total: records.length, revenue: stats.totalRev, months: Object.keys(byMonth).length }, byMonth, analysis });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 3. 月份分析
router.get('/analysis/month/:branch/:month', async (req, res) => {
  try {
    const branch = decodeURIComponent(req.params.branch);
    const month = req.params.month;
    const records = loadAll().filter(r => r.branch === branch && (r.report_date || '').startsWith(month));
    if (records.length === 0) return res.json({ ok: true, analysis: { summary: branch + ' ' + month + ' 尚無報告', key_findings: [], problems: [], recommendations: [], immediate_actions: [], risks: [] } });
    const stats = statsFromRecords(records);
    // Day-by-day list
    const byDay = records.map(r => ({ date: r.report_date, revenue: r.revenue, orders: r.orders, problems: r.problems, summary: r.summary }));
    const prompt = `請分析「${branch}」${month} 月份營運(${records.length} 份報告):\n月營收 NT$${stats.totalRev.toLocaleString()}\n日別: ${JSON.stringify(byDay.slice(0, 35))}\n\n請給月份最高/最低日、波動原因、月內趨勢、下月建議。`;
    const analysis = await callAnalysisClaude(prompt);
    res.json({ ok: true, scope: 'month', branch, month, stats: { total: records.length, revenue: stats.totalRev }, byDay, analysis });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 4. 單日分析
router.get('/analysis/day/:branch/:date', async (req, res) => {
  try {
    const branch = decodeURIComponent(req.params.branch);
    const date = req.params.date;
    const records = loadAll().filter(r => r.branch === branch && r.report_date === date);
    if (records.length === 0) return res.json({ ok: true, analysis: { summary: branch + ' ' + date + ' 無紀錄', key_findings: [], problems: [], recommendations: [], immediate_actions: [], risks: [] } });
    const r0 = records[0];
    const prompt = `請分析「${branch}」${date} 單日營運:\n營收 NT$${(r0.revenue||0).toLocaleString()}, 訂單 ${r0.orders || 0}\n摘要: ${r0.summary || ''}\n問題: ${r0.problems || ''}\n檢討: ${r0.review || ''}\n待辦: ${r0.action_items || ''}\n備註: ${r0.notes || ''}\n\n請給當日重點、最該改善的事、明天可立刻做的事。`;
    const analysis = await callAnalysisClaude(prompt);
    res.json({ ok: true, scope: 'day', branch, date, record: r0, analysis });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 補:依門市拿明細 records(讓前端「最近 20 筆」工作)
router.get('/list-by-branch/:branch', (req, res) => {
  try {
    const branch = decodeURIComponent(req.params.branch);
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const records = loadAll().filter(r => r.branch === branch).sort((a, b) => (b.report_date || '').localeCompare(a.report_date || '')).slice(0, limit);
    res.json({ ok: true, branch, count: records.length, records });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

function registerCron(cron) {
  if (!cron) return;
  cron.schedule('0 8 * * *', async () => {
    try { const r = await sendDailyDigestToTelegram(); console.log('[offline-reports] daily digest:', r.ok); }
    catch (e) { console.error('[offline-reports] digest err:', e.message); }
  }, { timezone: 'Asia/Taipei' });
  console.log('[offline-reports] cron registered: 0 8 * * * Asia/Taipei');
}

// ============ For gdrive-sync.js — process buffer instead of multer file ============
async function processBuffer(buffer, opts = {}) {
  const origName = opts.originalName || ('gdrive-' + Date.now());
  const ext = (path.extname(origName) || '').toLowerCase();
  const mime = (opts.mimeType || '').toLowerCase();
  // Write to UPLOADS_DIR so download links work
  const safeFilename = 'gdrive-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + (ext || '');
  const filePath = path.join(UPLOADS_DIR, safeFilename);
  try { fs.writeFileSync(filePath, buffer); } catch (e) { /* keep going even if write fails */ }

  let messages, preview = '';
  if (ext === '.pdf' || mime === 'application/pdf') {
    const b64 = buffer.toString('base64');
    messages = [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: '請萃取此 PDF 報告為結構化 JSON' }] }];
  } else if ((mime && mime.startsWith('image/')) || ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
    const b64 = buffer.toString('base64');
    let mt = mime && mime.startsWith('image/') ? mime : (ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg');
    messages = [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mt, data: b64 } }, { type: 'text', text: '請萃取此照片中的報告內容為結構化 JSON' }] }];
  } else if (ext === '.xlsx' || ext === '.xls' || mime.includes('spreadsheet')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const rows = [];
    wb.eachSheet(sheet => {
      rows.push('=== ' + sheet.name + ' ===');
      sheet.eachRow(row => { rows.push((row.values || []).slice(1).map(v => (v === null || v === undefined) ? '' : String(v)).join('\t')); });
    });
    preview = rows.join('\n').slice(0, 30000);
    messages = [{ role: 'user', content: '以下是 Excel 報告內容,請萃取為結構化 JSON:\n\n' + preview }];
  } else if (ext === '.csv' || mime === 'text/csv') {
    preview = buffer.toString('utf8').slice(0, 30000);
    messages = [{ role: 'user', content: '以下是 CSV 報告,請萃取為結構化 JSON:\n\n' + preview }];
  } else if (ext === '.txt' || ext === '.md' || mime.startsWith('text/')) {
    preview = buffer.toString('utf8').slice(0, 30000);
    messages = [{ role: 'user', content: '以下是報告文字,請萃取為結構化 JSON:\n\n' + preview }];
  } else if (ext === '.docx') {
    const raw = buffer.toString('binary');
    const textMatches = raw.match(/<w:t[^>]*>([^<]+)<\/w:t>/g) || [];
    preview = textMatches.map(m => m.replace(/<[^>]+>/g, '')).join(' ').slice(0, 30000);
    if (!preview) preview = '(docx 內容無法解析)';
    messages = [{ role: 'user', content: '以下是 Word 報告內容,請萃取為結構化 JSON:\n\n' + preview }];
  } else {
    throw new Error('不支援的檔案類型: ' + (ext || mime));
  }

  const { extracted } = await extractWithClaude(messages);
  const record = {
    id: genId(),
    ts: new Date().toISOString(),
    report_date: (extracted.date && /^\d{4}-\d{2}-\d{2}$/.test(extracted.date)) ? extracted.date : new Date().toISOString().slice(0, 10),
    type: ['daily', 'weekly', 'event', 'problem', 'other'].includes(extracted.type) ? extracted.type : 'other',
    branch: String(extracted.branch || opts.branchHint || '').slice(0, 100),
    author: String(extracted.author || '').slice(0, 50),
    revenue: Number(extracted.revenue) || 0,
    orders: Number(extracted.orders) || 0,
    problems: String(extracted.problems || '').slice(0, 5000),
    review: String(extracted.review || '').slice(0, 5000),
    action_items: String(extracted.action_items || '').slice(0, 5000),
    notes: String(extracted.notes || '').slice(0, 5000),
    summary: String(extracted.summary || '').slice(0, 200),
    source_file: origName,
    source_size: buffer.length,
    source_mime: mime,
    source: opts.source || 'manual',
    gdrive_file_id: opts.gdriveFileId,
    gdrive_modified_time: opts.modifiedTime,
    attachment_url: '/api/offline-reports/file/' + safeFilename
  };
  appendReport(record);
  return record;
}

module.exports = router;
module.exports.buildSummaryForAI = buildSummaryForAI;
module.exports.sendDailyDigestToTelegram = sendDailyDigestToTelegram;
module.exports.registerCron = registerCron;
module.exports.processBuffer = processBuffer;
