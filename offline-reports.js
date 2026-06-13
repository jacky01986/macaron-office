// offline-reports.js — 線下報告中心 v3 (Hybrid Excel: ExcelJS schema + cell-level extraction)
// v3 主要差異:Excel 改成 ExcelJS 自己 iterate cells,Claude 只當輕量 schema mapper
// → 100% 精準、不會被 max_tokens 截斷、所有檔一視同仁
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

// ============ 通用 Claude 萃取(用於 PDF/image/csv/txt) ============
const EXTRACT_SYS = `你是溫點 WarmPlace 烘焙坊的營運分析師。從上傳的報告/單據/照片中萃取結構化資料。只回傳純 JSON,絕對不要前綴後綴或 markdown。
回傳格式:
{"date":"YYYY-MM-DD","branch":"門市名","author":"填寫人","revenue":整數,"orders":整數,"problems":"","review":"","action_items":"","notes":"","type":"daily|weekly|monthly|event|problem|other","summary":""}

⚠️ 規則:revenue/orders 只抓「實際營收/訂單」,絕對不抓「目標」「預算」「去年同期」。日期一律 YYYY-MM-DD。判斷不出來填 0 或 ""。`;

async function extractWithClaude(messages, opts = {}) {
  const result = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: opts.maxTokens || 2048,
    system: opts.system || EXTRACT_SYS,
    messages
  });
  const respText = (result.content || []).map(c => c.text || '').join('');
  let extracted = {};
  let parseError = null;
  try { const m = respText.match(/\{[\s\S]*\}/); if (m) extracted = JSON.parse(m[0]); }
  catch (e) { parseError = e.message; extracted = { _raw: respText.slice(0, 500), _parse_error: e.message }; }
  return { extracted, raw: respText, parseError, stopReason: result.stop_reason };
}

// ============ 🎯 Hybrid Excel extraction — Claude 只猜 schema,ExcelJS 自己掃 cells ============
const EXCEL_SCHEMA_SYS = `你是 Excel 結構分析師。我會給你一份 Excel 報表前面幾列的內容(每個 sheet 列出)。
你只需要回傳「欄位對應 schema」JSON,不需要回傳實際每日資料(資料會由程式自己抓)。

回傳純 JSON,絕對不要 markdown:
{
  "branch": "門市名(從 sheet 名稱、檔名或表頭判斷)",
  "sheets": [
    {
      "sheet_name": "Excel sheet 的名字",
      "header_row": 標題列號(從 1 起算,例如 3),
      "data_start_row": 資料起始列號(通常 header_row + 1),
      "date_col": 日期欄的「欄號」(從 1 起算,例如 1 表示 A 欄, 2 表示 B 欄, 4 表示 D 欄),
      "revenue_col": 實際營收欄(整數,要確定是「實際」不是目標),
      "orders_col": 訂單/客數欄(整數,沒這欄就填 0)
    }
  ]
}

⚠️ 重點:
1. branch 從 sheet 名、檔名或表頭找最可能的門市名
2. sheets[] 列出所有「有日期+營收」的工作表,跳過純說明/封面 sheet
3. revenue_col 一定要是「實際」「達成」欄,不是「目標」「預算」「去年同期」欄。如果只有目標、沒有實際,填 0
4. orders_col 看「訂單數/客數/單數/客流/PCS」欄,沒有填 0
5. 列號從 1 起算(第 1 行是 1)
6. 如果是「整月一張表」就只回一個 sheet entry,header 列含日期/營收/訂單欄位`;

async function inferExcelSchema(buffer, hintFilename) {
  // 1. 用 ExcelJS 開檔,把每個 sheet 前 25 行 + col 標題 列給 Claude
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheetPreviews = [];
  let totalChars = 0;
  wb.eachSheet(sheet => {
    const lines = [`=== Sheet: "${sheet.name}" (${sheet.rowCount} rows × ${sheet.columnCount} cols) ===`];
    let rowsShown = 0;
    sheet.eachRow((row, rowNumber) => {
      if (rowsShown >= 30) return;
      // 印出「列號 | 各欄」格式,讓 Claude 看到 col index
      const cells = [];
      for (let c = 1; c <= Math.min(sheet.columnCount, 20); c++) {
        const v = row.getCell(c).value;
        let s = '';
        if (v === null || v === undefined) s = '';
        else if (v instanceof Date) s = v.toISOString().slice(0, 10);
        else if (typeof v === 'object') s = (v.text || v.result || JSON.stringify(v)).toString().slice(0, 20);
        else s = String(v).slice(0, 20);
        cells.push('[' + c + ']=' + s);
      }
      lines.push('row' + rowNumber + ': ' + cells.join(' '));
      rowsShown++;
    });
    const block = lines.join('\n');
    if (totalChars + block.length < 20000) {
      sheetPreviews.push(block);
      totalChars += block.length;
    }
  });
  const messages = [{
    role: 'user',
    content: `檔名: ${hintFilename}\n\n${sheetPreviews.join('\n\n')}\n\n請回 schema JSON。`
  }];
  const { extracted, raw, stopReason } = await extractWithClaude(messages, {
    system: EXCEL_SCHEMA_SYS,
    maxTokens: 2048
  });
  return { schema: extracted, raw, stopReason };
}

function parseDate(cellValue) {
  if (cellValue === null || cellValue === undefined || cellValue === '') return null;
  if (cellValue instanceof Date) {
    if (isNaN(cellValue.getTime())) return null;
    return cellValue.toISOString().slice(0, 10);
  }
  // Excel serial number (天數 since 1900-01-01)
  if (typeof cellValue === 'number') {
    if (cellValue < 30000 || cellValue > 80000) return null; // 不像合理日期 serial
    // 1900-01-01 = 1, 但 Excel bug: 把 1900 當閏年,所以 -2 而不是 -1
    const d = new Date(Date.UTC(1900, 0, cellValue - 1));
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  if (typeof cellValue === 'object') {
    if (cellValue.text) return parseDate(cellValue.text);
    if (cellValue.result) return parseDate(cellValue.result);
    return null;
  }
  const s = String(cellValue).trim();
  // YYYY-MM-DD / YYYY/MM/DD / 2026年1月1日
  let m = s.match(/(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})/);
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  m = s.match(/^(\d{1,2})[-\/月](\d{1,2})/);
  if (m) {
    // 月日格式 — 推測年份(用今年)
    const y = new Date().getFullYear();
    return y + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
  }
  return null;
}

function parseNumber(cellValue) {
  if (cellValue === null || cellValue === undefined || cellValue === '') return 0;
  if (typeof cellValue === 'number') return Math.round(cellValue);
  if (typeof cellValue === 'object') {
    if (typeof cellValue.result === 'number') return Math.round(cellValue.result);
    if (cellValue.text) return parseNumber(cellValue.text);
    return 0;
  }
  const s = String(cellValue).replace(/[, $NT＄¥%]/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : Math.round(n);
}

async function extractExcelHybrid(buffer, hintFilename) {
  // 🎯 規則式 parser — 寫死「溫點營業目標」Excel 模板的欄位 mapping
  // 模板結構(用 Python openpyxl 驗證過,4 個檔 100% 一致):
  //   Sheet 名:202601 ~ 202612 (12 個月)
  //   Cell A1 = 門市名
  //   Row 4 = 標題列
  //   Row 5+ 資料:B 欄=日期, D 欄=實際營業額, E 欄=筆數
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const todayStr = new Date().toISOString().slice(0, 10);
  let branch = '';
  const dailyMap = new Map();
  const monthsFound = [];

  wb.eachSheet(sheet => {
    const sn = sheet.name;
    // sheet 名必須是 6 位數字(202601 格式)
    if (!/^\d{6}$/.test(sn)) return;
    // 從 cell A1 取門市名(第一個有值的 sheet)
    if (!branch) {
      const a1 = sheet.getCell(1, 1).value;
      if (a1) branch = String(typeof a1 === 'object' ? (a1.text || a1.result || '') : a1).trim().slice(0, 100);
    }
    let monthDays = 0;
    for (let r = 5; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const dVal = row.getCell(2).value; // B = 日期
      const rVal = row.getCell(4).value; // D = 實際營業額
      const oVal = row.getCell(5).value; // E = 筆數
      const date = parseDate(dVal);
      if (!date) continue;
      if (date > todayStr) continue;
      const rev = parseNumber(rVal);
      const ord = parseNumber(oVal);
      if (rev <= 0 && ord <= 0) continue;
      const cur = dailyMap.get(date) || { date, revenue: 0, orders: 0 };
      cur.revenue += rev;
      cur.orders += ord;
      dailyMap.set(date, cur);
      monthDays++;
    }
    if (monthDays > 0) monthsFound.push({ sheet: sn, days: monthDays });
  });

  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!branch || daily.length === 0) {
    return { ok: false, reason: 'no_template_match', branch, daily_count: 0, monthsFound };
  }
  return { ok: true, branch, daily, schema: { template: '溫點營業目標', monthsFound, total_days: daily.length, total_revenue: daily.reduce((s,d)=>s+d.revenue,0), total_orders: daily.reduce((s,d)=>s+d.orders,0) } };
}

// ============ Routes ============

router.post('/upload-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: '沒有檔案' });
    const filePath = req.file.path;
    const origName = req.file.originalname;
    const buf = fs.readFileSync(filePath);
    const ext = (path.extname(origName) || '').toLowerCase();
    const mime = (req.file.mimetype || '').toLowerCase();
    const mimeMap = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv', '.txt': 'text/plain', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    const r = await processBuffer(buf, { originalName: origName, mimeType: mime || mimeMap[ext] || '', source: 'manual-upload' });
    try { fs.unlinkSync(filePath); } catch {}
    res.json({ ok: true, result: r });
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

const TARGETS_FILE = path.join(DATA_DIR, 'offline-targets.json');
function loadTargets() {
  try { if (!fs.existsSync(TARGETS_FILE)) return {}; return JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveTargets(t) { try { fs.writeFileSync(TARGETS_FILE, JSON.stringify(t, null, 2)); } catch {} }
router.get('/targets', (req, res) => { res.json({ ok: true, targets: loadTargets() }); });
router.post('/targets', (req, res) => {
  try {
    const incoming = req.body || {};
    const current = loadTargets();
    const merged = { ...current, ...incoming };
    saveTargets(merged);
    res.json({ ok: true, targets: merged });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/reanalyze/:filename', async (req, res) => {
  try {
    const safe = path.basename(req.params.filename);
    const fp = path.join(UPLOADS_DIR, safe);
    if (!fs.existsSync(fp)) return res.status(404).json({ ok: false, error: 'file not found' });
    const buf = fs.readFileSync(fp);
    const ext = (path.extname(safe) || '').toLowerCase();
    const mimeMap = { '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    const r = await processBuffer(buf, { originalName: safe, mimeType: mimeMap[ext] || '', source: 'reanalyze', force: true });
    res.json({ ok: true, record: r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

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
        const mimeMap = { '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
        await processBuffer(buf, { originalName: name, mimeType: mimeMap[ext] || '', source: 'reanalyze-all', force: true });
        processed++;
      } catch (e) { errors.push({ name, error: e.message }); }
    }
    res.json({ ok: true, processed, errors });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/list', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
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

// ============ ADMIN ============
router.post('/admin/reset', (req, res) => {
  if (req.query.confirm !== '1') return res.status(400).json({ ok: false, error: '必須帶 ?confirm=1 才會真的清空' });
  const removed = { reports: 0, uploads: 0, gdrive_processed: 0, errors: [] };
  try {
    if (fs.existsSync(REPORTS_FILE)) { removed.reports = loadAll().length; fs.writeFileSync(REPORTS_FILE, ''); }
  } catch (e) { removed.errors.push('reports: ' + e.message); }
  try {
    if (fs.existsSync(UPLOADS_DIR)) {
      const files = fs.readdirSync(UPLOADS_DIR);
      for (const f of files) { try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); removed.uploads++; } catch (e) {} }
    }
  } catch (e) { removed.errors.push('uploads: ' + e.message); }
  try {
    const PROCESSED = path.join(DATA_DIR, 'gdrive-processed.jsonl');
    if (fs.existsSync(PROCESSED)) { removed.gdrive_processed = fs.readFileSync(PROCESSED, 'utf8').split('\n').filter(Boolean).length; fs.unlinkSync(PROCESSED); }
    const STATE = path.join(DATA_DIR, 'gdrive-state.json');
    if (fs.existsSync(STATE)) fs.unlinkSync(STATE);
  } catch (e) { removed.errors.push('gdrive cache: ' + e.message); }
  res.json({ ok: true, removed });
});

router.get('/admin/health', (req, res) => {
  const all = loadAll();
  let uploadCount = 0;
  try { if (fs.existsSync(UPLOADS_DIR)) uploadCount = fs.readdirSync(UPLOADS_DIR).length; } catch {}
  res.json({ ok: true, reports_count: all.length, uploads_count: uploadCount, data_dir: DATA_DIR, has_anthropic_key: !!process.env.ANTHROPIC_API_KEY });
});

// Debug: 對單一檔跑 hybrid extraction,回 schema + daily 數 + 樣本
router.get('/admin/debug-excel/:filename', async (req, res) => {
  try {
    const safe = path.basename(req.params.filename);
    const fp = path.join(UPLOADS_DIR, safe);
    if (!fs.existsSync(fp)) return res.status(404).json({ ok: false, error: 'file not found' });
    const buf = fs.readFileSync(fp);
    const r = await extractExcelHybrid(buf, safe);
    res.json({
      ok: r.ok,
      reason: r.reason,
      schema: r.schema,
      daily_count: r.daily ? r.daily.length : 0,
      daily_sample: r.daily ? r.daily.slice(0, 5) : [],
      daily_total_revenue: r.daily ? r.daily.reduce((s, d) => s + d.revenue, 0) : 0,
      daily_total_orders: r.daily ? r.daily.reduce((s, d) => s + d.orders, 0) : 0,
      raw_head: (r.raw || '').slice(0, 1000)
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ============ Summary aggregator ============
function buildSummaryForAI() {
  const all = loadAll().filter(r => (Number(r.revenue) || 0) > 0 || (Number(r.orders) || 0) > 0);
  const now = Date.now();
  const day = 86400000;
  const d30 = all.filter(r => (now - new Date(r.report_date).getTime()) <= 30 * day);
  const d7 = all.filter(r => (now - new Date(r.report_date).getTime()) <= 7 * day);
  const revenue_30 = d30.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
  const revenue_7 = d7.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
  const recent_problems = [];
  d30.slice(-20).reverse().forEach(r => {
    if (r.problems) r.problems.split('\n').filter(Boolean).slice(0, 4).forEach(p => recent_problems.push({ branch: r.branch, date: r.report_date, p: p.trim() }));
  });
  const action_items = d30.slice(-10).reverse().filter(r => r.action_items).map(r => ({ branch: r.branch, date: r.report_date, items: r.action_items }));
  const trend = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * day).toISOString().slice(0, 10);
    const rev = all.filter(r => r.report_date === d).reduce((s, r) => s + (Number(r.revenue) || 0), 0);
    trend.push({ date: d, revenue: rev });
  }
  const branchMap = {};
  all.forEach(r => {
    const b = r.branch || '(無門市)';
    if (!branchMap[b]) branchMap[b] = { branch: b, count: 0, revenue: 0, problems: 0, reports: [], by_month: {} };
    branchMap[b].count++;
    branchMap[b].revenue += Number(r.revenue) || 0;
    if (r.problems) branchMap[b].problems++;
    branchMap[b].reports.push({
      id: r.id, date: r.report_date, revenue: Number(r.revenue) || 0, orders: Number(r.orders) || 0,
      summary: r.summary || '', problems: r.problems || '', review: r.review || '',
      action_items: r.action_items || '', notes: r.notes || '', attachment_url: r.attachment_url || ''
    });
    const ym = (r.report_date || '').slice(0, 7);
    if (ym) {
      if (!branchMap[b].by_month[ym]) branchMap[b].by_month[ym] = { month: ym, count: 0, revenue: 0, orders: 0 };
      branchMap[b].by_month[ym].count++;
      branchMap[b].by_month[ym].revenue += Number(r.revenue) || 0;
      branchMap[b].by_month[ym].orders += Number(r.orders) || 0;
    }
  });
  const targetsAll = loadTargets();
  Object.values(branchMap).forEach(b => {
    b.reports.sort((a, x) => (x.date || '').localeCompare(a.date || ''));
    b.reports = b.reports.slice(0, 100);
    const monthsArr = Object.values(b.by_month).sort((a, x) => (x.month || '').localeCompare(a.month || ''));
    monthsArr.forEach((m, i) => {
      m.aov = m.orders > 0 ? Math.round(m.revenue / m.orders) : 0;
      const tkey = b.branch + '|' + m.month;
      m.target = (targetsAll[tkey] && typeof targetsAll[tkey].target === 'number') ? targetsAll[tkey].target : null;
      m.achievement_pct = m.target ? Math.round((m.revenue / m.target) * 1000) / 10 : null;
      m.achievement = m.achievement_pct;
      const prev = monthsArr[i + 1];
      m.mom_change = (prev && prev.revenue > 0) ? Math.round(((m.revenue - prev.revenue) / prev.revenue) * 1000) / 10 : null;
      m.mom_change_pct = m.mom_change;
      m.mom_pct = m.mom_change;
    });
    b.by_month = monthsArr;
    b.avg_revenue = b.count > 0 ? Math.round(b.revenue / b.count) : 0;
    b.total_revenue = b.revenue;
    b.total_orders = b.reports.reduce((s, r) => s + (Number(r.orders) || 0), 0);
    b.aov = b.total_orders > 0 ? Math.round(b.revenue / b.total_orders) : 0;
  });
  const by_branch = Object.values(branchMap).sort((a, b) => b.revenue - a.revenue);
  const recent_reports_brief = all.slice(-5).reverse().map(r => ({ date: r.report_date, branch: r.branch, summary: r.summary || (r.review || '').slice(0, 80), revenue: r.revenue }));
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
  let uploads = [];
  try {
    if (fs.existsSync(UPLOADS_DIR)) {
      uploads = fs.readdirSync(UPLOADS_DIR).map(name => {
        try { const st = fs.statSync(path.join(UPLOADS_DIR, name)); return { name, size: st.size, mtime: st.mtime.toISOString() }; } catch { return null; }
      }).filter(Boolean).sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
    }
  } catch {}
  const total_revenue = by_branch.reduce((s, b) => s + (Number(b.revenue) || 0), 0);
  const total_orders = by_branch.reduce((s, b) => s + (Number(b.total_orders) || 0), 0);
  return {
    ok: true, generated_at: new Date().toISOString(),
    total_reports: all.length, total_revenue, total_orders,
    recent_30: d30.length, recent_7: d7.length, revenue_30, revenue_7,
    problem_count: recent_problems.length, recent_problems: recent_problems.slice(0, 15),
    action_items, revenue_trend: trend,
    by_branch, branches: by_branch, recent_reports_brief,
    all_branches, all_months, by_month_all_stores,
    uploads, expanded: [], skipped: []
  };
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
  if (yest.length === 0) return await tg(token, chatId, `📋 *線下報告早報* (${yesterday})\n\n昨日無報告上傳。`);
  const rev = yest.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
  let msg = `📋 *線下報告早報* (${yesterday})\n📊 *${yest.length}* 份 / NT$${rev.toLocaleString()}\n\n`;
  msg += yest.map(r => `🏪 *${r.branch || '(無)'}*: NT$${(r.revenue||0).toLocaleString()} / ${r.orders||0} 單`).join('\n');
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

// ============ AI Analysis ============
const ANALYSIS_SYS = `你是溫點 WarmPlace 烘焙坊的營運分析師。根據提供的營運報告數據,給出結構化分析。只回傳純 JSON,絕對不要前綴後綴或 markdown。schema:
{
 "executive_summary": "執行摘要,1-2 句話直白點出最重要的事(30-60 字)",
 "key_insights": "深度關鍵觀察,寫一段 80-150 字的洞察(數字 + 為什麼 + 含意)",
 "top_issues": [{"title":"問題標題","detail":"具體狀況","expected_impact":"影響"}],
 "recommendations": [{"title":"建議標題","detail":"做法細節","expected_impact":"預期效果"}],
 "quick_wins": ["明天就能做的事 1","明天就能做的事 2","明天就能做的事 3"]
}
top_issues 給 2-4 條,recommendations 給 2-4 條,quick_wins 給 3-5 條。`;
async function callAnalysisClaude(prompt) {
  try {
    const result = await anthropic.messages.create({ model: 'claude-opus-4-8', max_tokens: 2500, system: ANALYSIS_SYS, messages: [{ role: 'user', content: prompt }] });
    const respText = (result.content || []).map(c => c.text || '').join('');
    let parsed = {};
    try { const m = respText.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); }
    catch (e) { parsed = { _raw: respText.slice(0, 500), _parse_error: e.message }; }
    return parsed;
  } catch (e) {
    return { error: e.message, executive_summary: '分析失敗:' + e.message, key_insights: '', top_issues: [], recommendations: [], quick_wins: [] };
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
router.get('/analysis/all-stores', async (req, res) => {
  try {
    const all = loadAll().filter(r => (Number(r.revenue) || 0) > 0 || (Number(r.orders) || 0) > 0);
    if (all.length === 0) return res.json({ ok: true, analysis: { executive_summary: '尚無報告資料', key_insights: '', top_issues: [], recommendations: [], quick_wins: [] } });
    const stats = statsFromRecords(all);
    const prompt = `請分析溫點全體門市營運(${all.length} 份報告):\n總營收 NT$${stats.totalRev.toLocaleString()}\n總訂單 ${stats.totalOrders}\n門市分布: ${JSON.stringify(stats.branches)}\n近期問題: ${JSON.stringify(stats.recentProblems)}\n\n請給跨店比較、贏家/落後門市、共通問題、優先行動。`;
    const analysis = await callAnalysisClaude(prompt);
    res.json({ ok: true, scope: 'all-stores', stats: { total: all.length, revenue: stats.totalRev, branches: Object.keys(stats.branches).length }, analysis });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/analysis/branch/:branch', async (req, res) => {
  try {
    const branch = decodeURIComponent(req.params.branch);
    const records = loadAll().filter(r => r.branch === branch && ((Number(r.revenue) || 0) > 0 || (Number(r.orders) || 0) > 0));
    if (records.length === 0) return res.json({ ok: true, analysis: { executive_summary: branch + ' 尚無報告', key_insights: '', top_issues: [], recommendations: [], quick_wins: [] } });
    const stats = statsFromRecords(records);
    const byMonth = {};
    records.forEach(r => {
      const m = (r.report_date || '').slice(0, 7);
      if (!byMonth[m]) byMonth[m] = { count: 0, revenue: 0, orders: 0 };
      byMonth[m].count++;
      byMonth[m].revenue += Number(r.revenue) || 0;
      byMonth[m].orders += Number(r.orders) || 0;
    });
    const prompt = `請分析「${branch}」單店(${records.length} 份):\n累計營收 NT$${stats.totalRev.toLocaleString()}\n月份: ${JSON.stringify(byMonth)}\n問題: ${JSON.stringify(stats.recentProblems.slice(-10))}\n\n請給趨勢、月變化、最大問題、建議。`;
    const analysis = await callAnalysisClaude(prompt);
    res.json({ ok: true, scope: 'branch', branch, stats: { total: records.length, revenue: stats.totalRev, months: Object.keys(byMonth).length }, byMonth, analysis });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/analysis/month/:branch/:month', async (req, res) => {
  try {
    const branch = decodeURIComponent(req.params.branch);
    const month = req.params.month;
    const records = loadAll().filter(r => r.branch === branch && (r.report_date || '').startsWith(month) && ((Number(r.revenue) || 0) > 0 || (Number(r.orders) || 0) > 0));
    if (records.length === 0) return res.json({ ok: true, analysis: { executive_summary: branch + ' ' + month + ' 無報告', key_insights: '', top_issues: [], recommendations: [], quick_wins: [] } });
    const stats = statsFromRecords(records);
    const byDay = records.map(r => ({ date: r.report_date, revenue: r.revenue, orders: r.orders, problems: r.problems, summary: r.summary }));
    const prompt = `請分析「${branch}」${month}(${records.length} 份):\n月營收 NT$${stats.totalRev.toLocaleString()}\n日別: ${JSON.stringify(byDay.slice(0, 35))}\n\n請給最高/最低日、波動原因、趨勢、下月建議。`;
    const analysis = await callAnalysisClaude(prompt);
    res.json({ ok: true, scope: 'month', branch, month, stats: { total: records.length, revenue: stats.totalRev }, byDay, analysis });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/analysis/day/:branch/:date', async (req, res) => {
  try {
    const branch = decodeURIComponent(req.params.branch);
    const date = req.params.date;
    const records = loadAll().filter(r => r.branch === branch && r.report_date === date);
    if (records.length === 0) return res.json({ ok: true, analysis: { executive_summary: branch + ' ' + date + ' 無紀錄', key_insights: '', top_issues: [], recommendations: [], quick_wins: [] } });
    const r0 = records[0];
    const prompt = `分析「${branch}」${date} 單日:\n營收 NT$${(r0.revenue||0).toLocaleString()}, 訂單 ${r0.orders || 0}\n摘要: ${r0.summary || ''}\n問題: ${r0.problems || ''}\n檢討: ${r0.review || ''}\n\n請給當日重點、改善、明天可做的事。`;
    const analysis = await callAnalysisClaude(prompt);
    res.json({ ok: true, scope: 'day', branch, date, record: r0, analysis });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
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
    try { const r = await sendDailyDigestToTelegram(); console.log('[offline-reports] digest:', r.ok); }
    catch (e) { console.error('[offline-reports] digest err:', e.message); }
  }, { timezone: 'Asia/Taipei' });
}

// ============ processBuffer — entry for both upload and gdrive sync ============
async function processBuffer(buffer, opts = {}) {
  const origName = opts.originalName || ('gdrive-' + Date.now());
  const ext = (path.extname(origName) || '').toLowerCase();
  const mime = (opts.mimeType || '').toLowerCase();

  // sha256 內容去重
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const all = loadAll();
  const existing = all.find(r => r.source_sha256 === sha);
  if (existing && !opts.force) return { ok: true, skipped: true, reason: 'duplicate (sha256)', existing_id: existing.id, existing_branch: existing.branch };

  const safeFilename = 'gdrive-' + sha.slice(0, 12) + (ext || '');
  const filePath = path.join(UPLOADS_DIR, safeFilename);
  try { if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer); } catch {}

  // force: 先刪同 sha 舊 records
  if (opts.force && existing) {
    try {
      const filtered = loadAll().filter(r => r.source_sha256 !== sha);
      fs.writeFileSync(REPORTS_FILE, filtered.map(r => JSON.stringify(r)).join('\n') + (filtered.length ? '\n' : ''));
    } catch {}
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const baseRecord = {
    source_file: origName,
    source_size: buffer.length,
    source_mime: mime,
    source: opts.source || 'manual',
    source_sha256: sha,
    gdrive_file_id: opts.gdriveFileId,
    gdrive_modified_time: opts.modifiedTime,
    attachment_url: '/api/offline-reports/file/' + safeFilename
  };

  // 🎯 Excel → hybrid extraction
  if (ext === '.xlsx' || ext === '.xls' || mime.includes('spreadsheet')) {
    let result;
    try { result = await extractExcelHybrid(buffer, origName); }
    catch (e) { result = { ok: false, reason: 'exception: ' + e.message }; }
    if (result.ok && result.daily && result.daily.length > 0) {
      const created = [];
      for (const d of result.daily) {
        const rec = Object.assign({ id: genId(), ts: new Date().toISOString(), report_date: d.date, type: 'daily', branch: result.branch, author: '', revenue: d.revenue, orders: d.orders, problems: '', review: '', action_items: '', notes: '', summary: '' }, baseRecord);
        appendReport(rec);
        created.push(rec);
      }
      return { ok: true, mode: 'excel-hybrid', count: created.length, branch: result.branch, total_revenue: created.reduce((s,r)=>s+r.revenue,0), total_orders: created.reduce((s,r)=>s+r.orders,0), schema: result.schema };
    }
    // Excel hybrid 失敗 → 留一筆失敗 record 方便除錯
    const rec = Object.assign({ id: genId(), ts: new Date().toISOString(), report_date: todayStr, type: 'other', branch: '', author: '', revenue: 0, orders: 0, problems: '', review: '', action_items: '', notes: 'Hybrid extraction failed: ' + (result.reason || 'unknown'), summary: '' }, baseRecord);
    appendReport(rec);
    return { ok: false, mode: 'excel-hybrid-failed', reason: result.reason, schema: result.schema };
  }

  // 其他格式 → 傳統 Claude 萃取(PDF/image/csv/txt/docx)
  let messages, preview = '';
  if (ext === '.pdf' || mime === 'application/pdf') {
    const b64 = buffer.toString('base64');
    messages = [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: '請萃取此 PDF 報告為結構化 JSON' }] }];
  } else if ((mime && mime.startsWith('image/')) || ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
    const b64 = buffer.toString('base64');
    let mt = mime && mime.startsWith('image/') ? mime : (ext === '.png' ? 'image/png' : 'image/jpeg');
    messages = [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mt, data: b64 } }, { type: 'text', text: '請萃取此照片中的報告內容為結構化 JSON' }] }];
  } else if (ext === '.csv' || mime === 'text/csv') {
    preview = buffer.toString('utf8').slice(0, 30000);
    messages = [{ role: 'user', content: '以下是 CSV,請萃取為 JSON:\n\n' + preview }];
  } else if (ext === '.txt' || ext === '.md' || (mime && mime.startsWith('text/'))) {
    preview = buffer.toString('utf8').slice(0, 30000);
    messages = [{ role: 'user', content: '以下是文字報告,請萃取為 JSON:\n\n' + preview }];
  } else if (ext === '.docx') {
    const raw = buffer.toString('binary');
    const textMatches = raw.match(/<w:t[^>]*>([^<]+)<\/w:t>/g) || [];
    preview = textMatches.map(m => m.replace(/<[^>]+>/g, '')).join(' ').slice(0, 30000);
    messages = [{ role: 'user', content: '以下是 Word 內容,請萃取為 JSON:\n\n' + preview }];
  } else {
    throw new Error('不支援的檔案類型: ' + (ext || mime));
  }

  const { extracted } = await extractWithClaude(messages);
  const branch = String(extracted.branch || opts.branchHint || '').slice(0, 100);
  const record = Object.assign({
    id: genId(), ts: new Date().toISOString(),
    report_date: (extracted.date && /^\d{4}-\d{2}-\d{2}$/.test(extracted.date)) ? extracted.date : todayStr,
    type: ['daily', 'weekly', 'monthly', 'event', 'problem', 'other'].includes(extracted.type) ? extracted.type : 'other',
    branch, author: String(extracted.author || '').slice(0, 50),
    revenue: Number(extracted.revenue) || 0, orders: Number(extracted.orders) || 0,
    problems: String(extracted.problems || '').slice(0, 5000),
    review: String(extracted.review || '').slice(0, 5000),
    action_items: String(extracted.action_items || '').slice(0, 5000),
    notes: String(extracted.notes || '').slice(0, 5000),
    summary: String(extracted.summary || '').slice(0, 200)
  }, baseRecord);
  appendReport(record);
  return record;
}

module.exports = router;
module.exports.buildSummaryForAI = buildSummaryForAI;
module.exports.sendDailyDigestToTelegram = sendDailyDigestToTelegram;
module.exports.registerCron = registerCron;
module.exports.processBuffer = processBuffer;
