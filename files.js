// ============================================================
// files.js — FILES 員工後端：產 Word / Excel / PDF / PowerPoint
// 全部存到 /var/data/exports/，回傳 /api/exports/<檔名> 下載 URL
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const EXPORT_DIR = path.join(DATA_DIR, 'exports');
// 字型優先順序：Docker build 預下載 → 持久 disk → 啟動時補抓
const CJK_FONT_DOCKER = '/app/fonts/NotoSansTC-Regular.ttf';
const CJK_FONT_DISK = (process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data')) + '/fonts/NotoSansTC-Regular.ttf';
function getCjkFontPath() {
  if (fs.existsSync(CJK_FONT_DOCKER)) return CJK_FONT_DOCKER;
  if (fs.existsSync(CJK_FONT_DISK)) return CJK_FONT_DISK;
  return null;
}
let _fontFetchPromise = null;
async function ensureCjkFont() {
  if (getCjkFontPath()) return getCjkFontPath();
  if (_fontFetchPromise) return _fontFetchPromise;
  _fontFetchPromise = (async () => {
    try {
      // 多個 fallback URL，從 CDN 抓 NotoSansTC 字型
      const urls = [
        'https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/TTF/TraditionalChinese/NotoSansCJKtc-Regular.ttf',
        'https://github.com/googlefonts/noto-cjk/raw/main/Sans/TTF/TraditionalChinese/NotoSansCJKtc-Regular.ttf',
        'https://fonts.gstatic.com/s/notosanstc/v36/-nF7OG829Oofr2wohFbTp9iFOSsLA_ZJ1g.ttf',
      ];
      const fontDir = path.dirname(CJK_FONT_DISK);
      try { fs.mkdirSync(fontDir, { recursive: true }); } catch {}
      for (const u of urls) {
        try {
          console.log('[files] fetching CJK font from ' + u);
          const r = await fetch(u);
          if (!r.ok) continue;
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length < 1024 * 100) continue; // <100KB 大概有問題
          fs.writeFileSync(CJK_FONT_DISK, buf);
          console.log('[files] CJK font saved ' + (buf.length / 1024).toFixed(0) + ' KB → ' + CJK_FONT_DISK);
          return CJK_FONT_DISK;
        } catch (e) { console.warn('[files] font url failed:', u, e.message); }
      }
      return null;
    } catch (e) { console.error('[files] ensureCjkFont:', e.message); return null; }
  })();
  return _fontFetchPromise;
}
// 服務啟動時就嘗試抓
setTimeout(() => { ensureCjkFont().catch(()=>{}); }, 2000);


function ensureDir() { try { if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true }); } catch {} }
function safeName(s) { return String(s || 'doc').replace(/[^一-龥\w\-_]/g, '_').slice(0, 60); }
function newFilename(base, ext) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6);
  return safeName(base) + '_' + stamp + '_' + rand + '.' + ext;
}
function publicUrl(filename) {
  const host = process.env.PUBLIC_URL || 'https://macaron-office.onrender.com';
  return host.replace(/\/$/, '') + '/api/exports/' + encodeURIComponent(filename);
}

// ─────────── 1. Word (.docx) ───────────
async function generateDocx({ title, sections }) {
  ensureDir();
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx');
  const children = [];
  if (title) children.push(new Paragraph({ text: String(title), heading: HeadingLevel.TITLE }));
  for (const sec of (sections || [])) {
    if (sec.heading) children.push(new Paragraph({ text: String(sec.heading), heading: HeadingLevel.HEADING_1 }));
    const body = String(sec.body || sec.text || '');
    for (const line of body.split('\n')) {
      children.push(new Paragraph({ children: [new TextRun({ text: line || ' ', font: 'Microsoft JhengHei' })] }));
    }
    children.push(new Paragraph({ text: '' }));
  }
  const doc = new Document({ creator: '溫點 WarmPlace AI', title: title || '文件', sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  const filename = newFilename(title || 'document', 'docx');
  fs.writeFileSync(path.join(EXPORT_DIR, filename), buf);
  return { ok: true, filename, url: publicUrl(filename), bytes: buf.length };
}

// ─────────── 2. Excel (.xlsx) ───────────
async function generateXlsx({ title, sheets }) {
  ensureDir();
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = '溫點 WarmPlace AI';
  wb.created = new Date();
  const list = sheets && sheets.length ? sheets : [{ name: '工作表 1', headers: ['欄位'], rows: [['（空）']] }];
  for (const s of list) {
    const ws = wb.addWorksheet(safeName(s.name || '工作表').slice(0, 28));
    const headers = s.headers || [];
    if (headers.length) {
      ws.addRow(headers);
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFCF6F5' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6D2E46' } };
    }
    for (const r of (s.rows || [])) ws.addRow(r);
    // 自動寬度
    ws.columns.forEach((col, i) => {
      let max = (headers[i] || '').length;
      (s.rows || []).forEach(r => { const v = String(r[i] ?? ''); if (v.length > max) max = v.length; });
      col.width = Math.min(60, Math.max(12, max + 2));
    });
  }
  const filename = newFilename(title || 'workbook', 'xlsx');
  await wb.xlsx.writeFile(path.join(EXPORT_DIR, filename));
  const stat = fs.statSync(path.join(EXPORT_DIR, filename));
  return { ok: true, filename, url: publicUrl(filename), bytes: stat.size };
}

// ─────────── 3. PDF (.pdf) ───────────
async function generatePdf({ title, sections }) {
  ensureDir();
  // 嘗試確保 CJK 字型存在
  let fontPath = getCjkFontPath();
  if (!fontPath) {
    try { fontPath = await ensureCjkFont(); } catch {}
  }
  if (!fontPath) {
    // CJK 字型不可用 — 回 error 讓 FILES 改用 Word
    return { ok: false, error: 'PDF 中文字型不可用 (Render 環境字型抓取失敗)。請改用 generate_docx 產 Word，或讓 Sam 用 Word 另存 PDF。', fallback_suggested: 'generate_docx' };
  }
  const PDFDocument = require('pdfkit');
  const filename = newFilename(title || 'document', 'pdf');
  const outPath = path.join(EXPORT_DIR, filename);
  try {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 50, left: 60, right: 60 }, info: { Title: title || '文件', Author: '溫點 WarmPlace AI' } });
    doc.registerFont('cjk', fontPath);
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);
    if (title) {
      doc.font('cjk').fontSize(22).fillColor('#6D2E46').text(String(title), { align: 'left' });
      doc.moveDown(0.8);
    }
    for (const sec of (sections || [])) {
      if (sec.heading) {
        doc.font('cjk').fontSize(15).fillColor('#B08D57').text(String(sec.heading));
        doc.moveDown(0.4);
      }
      const body = String(sec.body || sec.text || '');
      doc.font('cjk').fontSize(11).fillColor('#1C1213').text(body, { align: 'left', lineGap: 4 });
      doc.moveDown(0.8);
    }
    if (!sections || !sections.length) {
      doc.font('cjk').fontSize(11).text('（無內容）');
    }
    doc.end();
    await new Promise((res, rej) => { stream.on('finish', res); stream.on('error', rej); });
    const stat = fs.statSync(outPath);
    if (stat.size < 500) {
      try { fs.unlinkSync(outPath); } catch {}
      return { ok: false, error: 'PDF 產出檔案異常小 ('+stat.size+' bytes)' };
    }
    return { ok: true, filename, url: publicUrl(filename), bytes: stat.size, cjk_font: true };
  } catch (e) {
    try { fs.unlinkSync(outPath); } catch {}
    return { ok: false, error: 'PDF 生成失敗：' + e.message + '。請改用 generate_docx。' };
  }
}

// ─────────── 4. PowerPoint (.pptx) ───────────
async function generatePptx({ title, slides }) {
  ensureDir();
  const PptxGenJS = require('pptxgenjs');
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE';
  pres.title = title || '簡報';
  pres.company = '溫點 WarmPlace';

  // 首頁
  if (title) {
    const cover = pres.addSlide();
    cover.background = { color: '6D2E46' };
    cover.addText(String(title), { x: 0.7, y: 2.2, w: 11.7, h: 1.5, fontSize: 44, color: 'FCF6F5', bold: true, fontFace: 'Microsoft JhengHei' });
    cover.addText('溫點 WarmPlace · AI 生成', { x: 0.7, y: 5.5, w: 11.7, h: 0.5, fontSize: 16, color: 'B08D57', fontFace: 'Microsoft JhengHei' });
  }

  for (const s of (slides || [])) {
    const sl = pres.addSlide();
    sl.background = { color: 'FCF6F5' };
    if (s.title) sl.addText(String(s.title), { x: 0.5, y: 0.4, w: 12.3, h: 0.9, fontSize: 28, color: '6D2E46', bold: true, fontFace: 'Microsoft JhengHei' });
    if (s.bullets && s.bullets.length) {
      sl.addText(s.bullets.map(b => ({ text: String(b), options: { bullet: true } })), { x: 0.7, y: 1.6, w: 11.7, h: 5.3, fontSize: 18, color: '1C1213', fontFace: 'Microsoft JhengHei', valign: 'top', paraSpaceAfter: 8 });
    } else if (s.body) {
      sl.addText(String(s.body), { x: 0.7, y: 1.6, w: 11.7, h: 5.3, fontSize: 16, color: '1C1213', fontFace: 'Microsoft JhengHei', valign: 'top' });
    }
    if (s.footer) sl.addText(String(s.footer), { x: 0.5, y: 7.0, w: 12.3, h: 0.4, fontSize: 10, color: '888888', fontFace: 'Microsoft JhengHei', italic: true });
  }
  if (!slides || !slides.length) {
    const sl = pres.addSlide();
    sl.addText('（無內容）', { x: 1, y: 3, fontSize: 24 });
  }

  const filename = newFilename(title || 'slides', 'pptx');
  const outPath = path.join(EXPORT_DIR, filename);
  await pres.writeFile({ fileName: outPath });
  const stat = fs.statSync(outPath);
  return { ok: true, filename, url: publicUrl(filename), bytes: stat.size };
}

// ─────────── 路由：下載 ───────────
router.get('/:filename', (req, res) => {
  const name = String(req.params.filename || '').replace(/[\/\\.]{2,}/g, '');
  const p = path.join(EXPORT_DIR, name);
  if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: 'not found' });
  res.download(p, name);
});
router.get('/', (req, res) => {
  ensureDir();
  try {
    const items = fs.readdirSync(EXPORT_DIR)
      .map(f => ({ name: f, size: fs.statSync(path.join(EXPORT_DIR, f)).size, mtime: fs.statSync(path.join(EXPORT_DIR, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime).slice(0, 50);
    res.json({ ok: true, items });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
module.exports.generateDocx = generateDocx;
module.exports.generateXlsx = generateXlsx;
module.exports.generatePdf = generatePdf;
module.exports.generatePptx = generatePptx;
