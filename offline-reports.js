// offline-reports.js v6
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const ExcelJS = require('exceljs');

const router = express.Router();
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/var/data') ? '/var/data' : '/tmp/data');
const REPORTS_FILE = path.join(DATA_DIR, 'offline-reports.jsonl');
const TARGETS_FILE = path.join(DATA_DIR, 'branch-targets.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'offline-uploads');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}

const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 25 * 1024 * 1024 } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
router.use(express.json({ limit: '5mb' }));

function loadAll() {
  try {
    if (!fs.existsSync(REPORTS_FILE)) return [];
    return fs.readFileSync(REPORTS_FILE, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function appendReport(r) { fs.appendFileSync(REPORTS_FILE, JSON.stringify(r) + '\n'); return r; }
function genId() { return 'rpt_' + Math.random().toString(36).slice(2, 16); }
function loadTargets() { try { if (!fs.existsSync(TARGETS_FILE)) return {}; return JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8')); } catch { return {}; } }
function saveTargets(t) { fs.writeFileSync(TARGETS_FILE, JSON.stringify(t, null, 2)); }
function setTarget(branch, month, value) {
  const t = loadTargets();
  if (!t[branch]) t[branch] = {};
  if (value === null || value === undefined || value === '' || Number(value) <= 0) { delete t[branch][month]; if (Object.keys(t[branch]).length === 0) delete t[branch]; }
  else { t[branch][month] = Number(value); }
  saveTargets(t);
  return t;
}

const EXTRACT_SYS = "你是溫點 WarmPlace 烘焙坊的營運分析師。從上傳的報告/單據/照片中萃取結構化資料。只回傳純 JSON,絕對不要前綴後綴或 markdown。欄位:{\"date\":\"YYYY-MM-DD\",\"branch\":\"門市名\",\"author\":\"填寫人\",\"revenue\":數字,\"orders\":數字,\"problems\":\"問題點\\n問題點\",\"review\":\"檢討觀察\",\"action_items\":\"待辦\\n待辦\",\"notes\":\"備註\",\"type\":\"daily|weekly|event|problem|other\",\"summary\":\"一句話摘要15字內\"}";

async function extractWithClaude(messages) {
  const result = await anthropic.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 2048, system: EXTRACT_SYS, messages });
  const respText = (result.content || []).map(c => c.text || '').join('');
  let extracted = {};
  try { const m = respText.match(/\{[\s\S]*\}/); if (m) extracted = JSON.parse(m[0]); }
  catch (e) { extracted = { _raw: respText.slice(0, 500), _err: e.message }; }
  return { extracted };
}

router.post('/upload-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: '沒有檔案' });
    const filePath = req.file.path;
    const origName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
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
      const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(filePath);
      const rows = [];
      wb.eachSheet(sheet => { rows.push('=== ' + sheet.name + ' ==='); sheet.eachRow(row => { rows.push((row.values || []).slice(1).map(v => (v === null || v === undefined) ? '' : String(v)).join('\t')); }); });
      preview = rows.join('\n').slice(0, 30000);
      messages = [{ role: 'user', content: '以下是 Excel 報告內容,請萃取為結構化 JSON:\n\n' + preview }];
    } else if (ext === '.csv') { preview = fs.readFileSync(filePath, 'utf8').slice(0, 30000); messages = [{ role: 'user', content: '以下是 CSV 報告,請萃取為結構化 JSON:\n\n' + preview }]; }
    else if (ext === '.txt' || ext === '.md') { preview = fs.readFileSync(filePath, 'utf8').slice(0, 30000); messages = [{ role: 'user', content: '以下是報告文字,請萃取為結構化 JSON:\n\n' + preview }]; }
    else if (ext === '.docx') {
      try {
        const raw = fs.readFileSync(filePath).toString('binary');
        const textMatches = raw.match(/<w:t[^>]*>([^<]+)<\/w:t>/g) || [];
        preview = textMatches.map(m => m.replace(/<[^>]+>/g, '')).join(' ').slice(0, 30000);
        if (!preview) preview = '(docx 內容無法解析)';
        messages = [{ role: 'user', content: '以下是 Word 報告內容,請萃取為結構化 JSON:\n\n' + preview }];
      } catch (e) { return res.status(400).json({ ok: false, error: 'docx 讀取失敗: ' + e.message }); }
    } else { return res.status(400).json({ ok: false, error: '不支援的檔案類型' }); }

    const { extracted } = await extractWithClaude(messages);
    const record = {
      id: genId(), ts: new Date().toISOString(),
      report_date: (extracted.date && /^\d{4}-\d{2}-\d{2}$/.test(extracted.date)) ? extracted.date : new Date().toISOString().slice(0, 10),
      type: ['daily','weekly','event','problem','other'].includes(extracted.type) ? extracted.type : 'other',
      branch: String(extracted.branch || req.body.branch || '').slice(0, 100),
      author: String(extracted.author || req.body.author || '').slice(0, 50),
      revenue: Number(extracted.revenue) || 0, orders: Number(extracted.orders) || 0,
      problems: String(extracted.problems || '').slice(0, 5000),
      review: String(extracted.review || '').slice(0, 5000),
      action_items: String(extracted.action_items || '').slice(0, 5000),
      notes: String(extracted.notes || req.body.notes || '').slice(0, 5000),
      summary: String(extracted.summary || '').slice(0, 200),
      source_file: origName, source_size: req.file.size, source_mime: mime,
      attachment_url: '/api/offline-reports/file/' + path.basename(filePath)
    };
    appendReport(record);
    res.json({ ok: true, id: record.id, record, extracted });
  } catch (e) { console.error('[offline-reports] upload error', e); res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/submit', (req, res) => {
  try {
    const b = req.body || {};
    const record = { id: genId(), ts: new Date().toISOString(), report_date: b.report_date || new Date().toISOString().slice(0,10), type: b.type || 'other', branch: String(b.branch||'').slice(0,100), author: String(b.author||'').slice(0,50), revenue: Number(b.revenue)||0, orders: Number(b.orders)||0, problems: String(b.problems||'').slice(0,5000), review: String(b.review||'').slice(0,5000), action_items: String(b.action_items||'').slice(0,5000), notes: String(b.notes||'').slice(0,5000), summary: String(b.summary||'').slice(0,200), attachment_url: String(b.attachment_url||'').slice(0,500) };
    appendReport(record);
    res.json({ ok: true, id: record.id, record });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/list', (req, res) => { const limit = Math.min(Number(req.query.limit) || 50, 200); const all = loadAll().slice(-limit).reverse(); res.json({ ok: true, count: all.length, reports: all }); });
router.get('/report/:id', (req, res) => { const r = loadAll().find(x => x.id === req.params.id); if (!r) return res.status(404).json({ ok: false, error: 'not found' }); res.json({ ok: true, report: r }); });
router.get('/file/:name', (req, res) => { const safe = path.basename(req.params.name); const f = path.join(UPLOADS_DIR, safe); if (!fs.existsSync(f)) return res.status(404).send('not found'); res.sendFile(f); });
router.delete('/report/:id', (req, res) => { const all = loadAll(); const filtered = all.filter(x => x.id !== req.params.id); if (filtered.length === all.length) return res.status(404).json({ ok: false, error: 'not found' }); fs.writeFileSync(REPORTS_FILE, filtered.map(r => JSON.stringify(r)).join('\n') + (filtered.length ? '\n' : '')); res.json({ ok: true, removed: req.params.id }); });

router.get('/targets', (req, res) => { res.json({ ok: true, targets: loadTargets() }); });
router.post('/targets', (req, res) => {
  try { const { branch, month, target } = req.body || {}; if (!branch || !month) return res.status(400).json({ ok: false, error: 'branch + month required' }); if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ ok: false, error: 'month must be YYYY-MM' }); const updated = setTarget(branch, month, target); res.json({ ok: true, targets: updated }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// NEW: reanalyze - expand a report into per-day records by re-reading source file
const REANALYZE_SYS = "從原始 Excel/CSV 報告逐日萃取營收紀錄。只回傳純 JSON,不要 markdown。欄位:{\"daily\":[{\"date\":\"YYYY-MM-DD\",\"revenue\":數字,\"orders\":數字,\"notes\":\"當日備註30字內\"}]}。請列出所有抓到的日期,不要省略任何一天。若有月份標頭推斷該月起訖。";

router.post('/reanalyze/:id', async (req, res) => {
  try {
    const all = loadAll();
    const idx = all.findIndex(r => r.id === req.params.id);
    if (idx < 0) return res.status(404).json({ ok: false, error: '找不到報告' });
    const orig = all[idx];
    if (!orig.attachment_url) return res.status(400).json({ ok: false, error: '無原始檔可重新分析' });
    const fpath = path.join(UPLOADS_DIR, path.basename(orig.attachment_url));
    if (!fs.existsSync(fpath)) return res.status(400).json({ ok: false, error: '原始檔不存在' });
    const ext = (path.extname(orig.source_file || '') || '').toLowerCase();
    let content = '';
    if (ext === '.xlsx' || ext === '.xls') {
      const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(fpath);
      const rows = [];
      wb.eachSheet(sheet => { rows.push('=== ' + sheet.name + ' ==='); sheet.eachRow(row => { rows.push((row.values || []).slice(1).map(v => (v === null || v === undefined) ? '' : String(v)).join('\t')); }); });
      content = rows.join('\n').slice(0, 30000);
    } else if (ext === '.csv' || ext === '.txt' || ext === '.md') { content = fs.readFileSync(fpath, 'utf8').slice(0, 30000); }
    else { return res.status(400).json({ ok: false, error: '此檔案類型無法逐日展開: ' + ext }); }

    const result = await anthropic.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 4096, system: REANALYZE_SYS, messages: [{ role: 'user', content: '門市: ' + (orig.branch || '') + '\n原始檔: ' + (orig.source_file || '') + '\n\n內容:\n' + content }] });
    const respText = (result.content || []).map(c => c.text || '').join('');
    let parsed = {};
    try { const m = respText.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); }
    catch (e) { return res.status(500).json({ ok: false, error: '解析失敗: ' + e.message }); }
    const days = Array.isArray(parsed.daily) ? parsed.daily : [];
    if (days.length === 0) return res.status(400).json({ ok: false, error: 'Claude 沒有抽出任何日記錄' });

    all.splice(idx, 1);
    const newRecords = days.map((d, i) => ({
      id: genId(), ts: new Date().toISOString(),
      report_date: (d.date && /^\d{4}-\d{2}-\d{2}$/.test(d.date)) ? d.date : orig.report_date,
      type: 'daily', branch: orig.branch, author: orig.author || '',
      revenue: Number(d.revenue) || 0, orders: Number(d.orders) || 0,
      problems: '', review: '', action_items: '', notes: d.notes || '', summary: '',
      source_file: orig.source_file + ' [日 ' + (i + 1) + '/' + days.length + ']',
      source_size: orig.source_size, source_mime: orig.source_mime,
      attachment_url: orig.attachment_url, expanded_from: orig.id
    }));
    fs.writeFileSync(REPORTS_FILE, all.concat(newRecords).map(r => JSON.stringify(r)).join('\n') + '\n');
    res.json({ ok: true, expanded_to: days.length, sample: days.slice(0, 3) });
  } catch (e) { console.error('[offline-reports] reanalyze err', e); res.status(500).json({ ok: false, error: e.message }); }
});

function buildSummaryForAI() {
  const all = loadAll();
  const targets = loadTargets();
  const now = Date.now(); const day = 86400000;
  const d30 = all;
  const d7 = all.filter(r => (now - new Date(r.report_date).getTime()) <= 7 * day);
  const revenue_30 = d30.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
  const revenue_7 = d7.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
  const recent_problems = [];
  d30.slice(-20).reverse().forEach(r => { if (r.problems) r.problems.split('\n').filter(Boolean).slice(0, 4).forEach(p => { recent_problems.push({ branch: r.branch, date: r.report_date, p: p.trim() }); }); });
  const action_items = d30.slice(-10).reverse().filter(r => r.action_items).map(r => ({ branch: r.branch, date: r.report_date, items: r.action_items }));
  const trend = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(now - i * day).toISOString().slice(0, 10); const rev = all.filter(r => r.report_date === d).reduce((s, r) => s + (Number(r.revenue) || 0), 0); trend.push({ date: d, revenue: rev }); }
  const branchMap = {};
  d30.forEach(r => {
    const b = r.branch || '(無門市)';
    if (!branchMap[b]) branchMap[b] = { branch: b, count: 0, revenue: 0, problems: 0, total_orders: 0, reports: [] };
    branchMap[b].count++;
    branchMap[b].revenue += Number(r.revenue) || 0;
    branchMap[b].total_orders += Number(r.orders) || 0;
    if (r.problems) branchMap[b].problems++;
    branchMap[b].reports.push({ id: r.id, date: r.report_date, type: r.type, revenue: r.revenue, orders: r.orders, summary: r.summary, problems: r.problems, review: r.review, action_items: r.action_items, notes: r.notes, source_file: r.source_file, attachment_url: r.attachment_url, author: r.author });
  });
  const by_branch = Object.values(branchMap).sort((a, b) => b.revenue - a.revenue);
  by_branch.forEach(br => {
    const mm = {};
    (br.reports || []).forEach(r => {
      const m = (r.date || '').slice(0, 7); if (!m) return;
      if (!mm[m]) mm[m] = { month: m, revenue: 0, orders: 0, count: 0, problems_count: 0 };
      mm[m].revenue += Number(r.revenue) || 0; mm[m].orders += Number(r.orders) || 0; mm[m].count++;
      if (r.problems) r.problems.split('\n').filter(Boolean).forEach(() => mm[m].problems_count++);
    });
    const sortedAsc = Object.values(mm).sort((a, b) => a.month.localeCompare(b.month));
    const branchTargets = targets[br.branch] || {};
    let prevRev = null;
    sortedAsc.forEach(m => {
      m.target = branchTargets[m.month] || 0;
      m.achievement_pct = m.target > 0 ? Math.round((m.revenue / m.target) * 1000) / 10 : null;
      m.avg_order_value = m.orders > 0 ? Math.round(m.revenue / m.orders) : 0;
      m.avg_per_report = m.count > 0 ? Math.round(m.revenue / m.count) : 0;
      m.delta_vs_prev = prevRev !== null ? (m.revenue - prevRev) : null;
      m.delta_pct_vs_prev = (prevRev !== null && prevRev > 0) ? Math.round(((m.revenue - prevRev) / prevRev) * 1000) / 10 : null;
      prevRev = m.revenue;
    });
    br.by_month = sortedAsc.slice().reverse();
    br.total_target = sortedAsc.reduce((s, m) => s + (m.target || 0), 0);
    br.overall_achievement_pct = br.total_target > 0 ? Math.round((br.revenue / br.total_target) * 1000) / 10 : null;
    br.avg_order_value = br.total_orders > 0 ? Math.round(br.revenue / br.total_orders) : 0;
  });
  const recent_reports_brief = all.slice(-5).reverse().map(r => ({ date: r.report_date, branch: r.branch, summary: r.summary || (r.review || '').slice(0, 80), revenue: r.revenue }));
  return { ok: true, generated_at: new Date().toISOString(), total_reports: all.length, recent_30: d30.length, recent_7: d7.length, revenue_30, revenue_7, problem_count: recent_problems.length, recent_problems: recent_problems.slice(0, 15), action_items, revenue_trend: trend, by_branch, recent_reports_brief };
}

router.get('/summary', (req, res) => { try { res.json(buildSummaryForAI()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });

const BRANCH_ANALYSIS_SYS = "你是溫點 WarmPlace 烘焙坊的資深營運顧問。針對單一門市的線下報告做深度分析。只回傳純 JSON,絕對不要 markdown 標記。欄位:{\"executive_summary\":\"3-5句執行摘要\",\"monthly_trend_analysis\":\"逐月評析(150字內)\",\"top_issues\":[{\"issue\":\"問題\",\"severity\":\"high|medium|low\",\"root_cause\":\"原因\"}],\"recommendations\":[{\"priority\":\"P1|P2|P3\",\"title\":\"標題\",\"detail\":\"做法\",\"expected_impact\":\"效益\"}],\"quick_wins\":[\"...\"],\"watch_outs\":[\"...\"]}";

router.get('/branch-analysis/:branch', async (req, res) => {
  try {
    const wantedBranch = decodeURIComponent(req.params.branch);
    const all = loadAll().filter(r => r.branch === wantedBranch);
    if (all.length === 0) return res.status(404).json({ ok: false, error: '無此門市報告' });
    const targets = loadTargets(); const branchTargets = targets[wantedBranch] || {};
    const byMonth = {};
    all.forEach(r => {
      const m = (r.report_date || '').slice(0, 7);
      if (!byMonth[m]) byMonth[m] = { month: m, revenue: 0, orders: 0, count: 0, problems: [], reviews: [], actions: [] };
      byMonth[m].revenue += Number(r.revenue) || 0; byMonth[m].orders += Number(r.orders) || 0; byMonth[m].count++;
      if (r.problems) r.problems.split('\n').filter(Boolean).forEach(p => byMonth[m].problems.push(p.trim()));
      if (r.review) byMonth[m].reviews.push(r.review.slice(0, 200));
      if (r.action_items) r.action_items.split('\n').filter(Boolean).forEach(a => byMonth[m].actions.push(a.trim()));
    });
    const monthList = Object.values(byMonth).sort((a, b) => b.month.localeCompare(a.month));
    monthList.forEach(m => { m.target = branchTargets[m.month] || 0; m.achievement_pct = m.target > 0 ? Math.round((m.revenue / m.target) * 1000) / 10 : null; });
    const totalRev = all.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
    const totalOrd = all.reduce((s, r) => s + (Number(r.orders) || 0), 0);
    const allProblems = all.flatMap(r => (r.problems || '').split('\n').filter(Boolean).map(p => p.trim()));
    const allActions = all.flatMap(r => (r.action_items || '').split('\n').filter(Boolean).map(a => a.trim()));
    const allReviews = all.map(r => r.review).filter(Boolean);
    const ctx = '門市:' + wantedBranch + '\n累計營收:NT$' + totalRev.toLocaleString() + ' / 訂單' + totalOrd + ' / ' + all.length + ' 份報告\n\n月份明細:\n' + monthList.map(m => '【' + m.month + '】營收 NT$' + m.revenue.toLocaleString() + (m.target > 0 ? ' / 目標 NT$' + m.target.toLocaleString() + ' = ' + m.achievement_pct + '%' : '') + ' / 訂單 ' + m.orders + ' / 報告 ' + m.count + ' / 問題 ' + m.problems.length).join('\n') + '\n\n所有問題:\n' + allProblems.map(p => '• ' + p).join('\n') + '\n\n檢討:\n' + allReviews.map(r => '• ' + r).join('\n') + '\n\n行動:\n' + allActions.map(a => '• ' + a).join('\n');
    const result = await anthropic.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 3000, system: BRANCH_ANALYSIS_SYS, messages: [{ role: 'user', content: ctx }] });
    const respText = (result.content || []).map(c => c.text || '').join('');
    let analysis = {};
    try { const m = respText.match(/\{[\s\S]*\}/); if (m) analysis = JSON.parse(m[0]); } catch (e) { analysis = { _raw: respText.slice(0, 500), _err: e.message }; }
    res.json({ ok: true, branch: wantedBranch, total_revenue: totalRev, total_orders: totalOrd, report_count: all.length, by_month: monthList, analysis });
  } catch (e) { console.error('[offline-reports] branch-analysis err', e); res.status(500).json({ ok: false, error: e.message }); }
});

const SOURCE_AGGREGATE_SYS = "你是會計總監。從原始報告(Excel)逐日萃取營收、按月份結算。只回傳純 JSON,不要 markdown。欄位:{\"months\":[{\"month\":\"YYYY-MM\",\"revenue\":數字,\"orders\":數字,\"days_with_data\":數字,\"best_day\":{\"date\":\"YYYY-MM-DD\",\"revenue\":數字},\"worst_day\":{\"date\":\"YYYY-MM-DD\",\"revenue\":數字},\"avg_daily_revenue\":數字,\"notes\":\"觀察30字\"}],\"total_revenue\":數字,\"total_orders\":數字,\"total_days\":數字,\"summary\":\"3-5句總結\",\"best_month\":{\"month\":\"YYYY-MM\",\"revenue\":數字},\"worst_month\":{\"month\":\"YYYY-MM\",\"revenue\":數字},\"key_findings\":[\"...\"]}";

router.get('/branch-source-aggregate/:branch', async (req, res) => {
  try {
    const wantedBranch = decodeURIComponent(req.params.branch);
    const all = loadAll().filter(r => r.branch === wantedBranch);
    if (all.length === 0) return res.status(404).json({ ok: false, error: '無此門市' });
    const blocks = [];
    for (const r of all) {
      let content = '';
      const fname = r.attachment_url ? path.basename(r.attachment_url) : null;
      const fpath = fname ? path.join(UPLOADS_DIR, fname) : null;
      if (fpath && fs.existsSync(fpath)) {
        const ext = (path.extname(r.source_file || '') || '').toLowerCase();
        try {
          if (ext === '.xlsx' || ext === '.xls') {
            const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(fpath);
            const rows = [];
            wb.eachSheet(sheet => { rows.push('=== ' + sheet.name + ' ==='); sheet.eachRow(row => { rows.push((row.values || []).slice(1).map(v => (v === null || v === undefined) ? '' : String(v)).join('\t')); }); });
            content = rows.join('\n').slice(0, 18000);
          } else if (ext === '.csv' || ext === '.txt' || ext === '.md') { content = fs.readFileSync(fpath, 'utf8').slice(0, 18000); }
        } catch (e) { content = '(讀檔錯: ' + e.message + ')'; }
      }
      blocks.push('=== ' + r.report_date + ' / ' + (r.source_file || '') + ' ===\n' + (content || '(無原始檔)'));
    }
    const ctx = '門市: ' + wantedBranch + '\n以下所有上傳報告原始內容:\n\n' + blocks.join('\n\n').slice(0, 80000);
    const result = await anthropic.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 4096, system: SOURCE_AGGREGATE_SYS, messages: [{ role: 'user', content: ctx }] });
    const respText = (result.content || []).map(c => c.text || '').join('');
    let aggregate = {};
    try { const m = respText.match(/\{[\s\S]*\}/); if (m) aggregate = JSON.parse(m[0]); } catch (e) { aggregate = { _raw: respText.slice(0, 500), _err: e.message }; }
    res.json({ ok: true, branch: wantedBranch, source_reports: all.length, aggregate });
  } catch (e) { console.error('[offline-reports] source-aggregate err', e); res.status(500).json({ ok: false, error: e.message }); }
});

async function sendDailyDigestToTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN; const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, error: 'no telegram env' };
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const yest = loadAll().filter(r => r.report_date === yesterday);
  if (yest.length === 0) return await tg(token, chatId, '📋 *線下報告早報* (' + yesterday + ')\n\n昨日無報告上傳。');
  const rev = yest.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
  let msg = '📋 *線下報告早報* (' + yesterday + ')\n\n📊 *' + yest.length + '* 份 / NT$' + rev.toLocaleString() + '\n';
  msg += yest.map(r => '🏪 ' + (r.branch || '(無)') + ' NT$' + (r.revenue || 0).toLocaleString()).join('\n');
  return await tg(token, chatId, msg);
}

async function tg(token, chatId, text) {
  try { const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }) }); const d = await r.json(); return { ok: !!d.ok, telegram: d }; }
  catch (e) { return { ok: false, error: e.message }; }
}

router.get('/send-digest', async (req, res) => { res.json(await sendDailyDigestToTelegram()); });

function registerCron(cron) {
  if (!cron) return;
  cron.schedule('0 8 * * *', async () => { try { const r = await sendDailyDigestToTelegram(); console.log('[offline-reports] daily digest:', r.ok); } catch (e) { console.error('[offline-reports] digest err:', e.message); } }, { timezone: 'Asia/Taipei' });
}

module.exports = router;
module.exports.buildSummaryForAI = buildSummaryForAI;
module.exports.sendDailyDigestToTelegram = sendDailyDigestToTelegram;
module.exports.registerCron = registerCron;
