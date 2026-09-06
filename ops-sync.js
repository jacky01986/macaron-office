// ops-sync.js — 伺服器端營運數字同步（每日）
// 取代原本跑在本機的排程：讀 Drive 營運檔 → AI 判讀 → 寫入 ops-latest.json
const fs = require('fs');
const pth = require('path');
const gd = require('./gdrive-sync');

const D = () => process.env.RENDER_DISK_MOUNT_PATH || '/var/data';
const OUT = () => pth.join(D(), 'ops-latest.json');

const SHEETS = [
  ['活動檔期', '1QSmOsz4djcnWsvua6DLX3oVFs43sr6t8'],
  ['忘刷紀錄', '1kD7VxVhgTgeqXKYTi021AorR9g2O9mVr'],
  ['備品叫貨', '1h7wRPTNVSQEz5tS4XpNdXvrPa74jLT3S'],
  ['效期報廢', '1M_ycd2kX7BWsH9kMFOE-0ldIQYr7UioE'],
  ['員購', '17vLnByZ5XBfwIF4Rh8guyy0wqJRI-gOe'],
  ['特殊訂單', '1dZz8QkE3xudl8d1C5cY9HrZgY85MPtWfO66unUIGDXw']
];
const FOLDERS = [
  ['臨時請假', '1YrqWQ7fbsFpJrUVKSGHa0_MtL_BzNAAM'],
  ['調貨', '1RjFuFR4kMeKRJT02FxyksQ_y-5aoc550']
];

async function listFolder(id, token, depth) {
  const q = encodeURIComponent("'" + id + "' in parents and trashed=false");
  const f = encodeURIComponent('files(id,name,mimeType,modifiedTime)');
  const url = 'https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=' + f + '&pageSize=300';
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return [];
  const j = await r.json();
  let out = [];
  for (const it of (j.files || [])) {
    if (it.mimeType === 'application/vnd.google-apps.folder' && depth > 0) {
      const kids = await listFolder(it.id, token, depth - 1);
      out = out.concat(kids.map(function (k) { return { name: it.name + '/' + k.name, modifiedTime: k.modifiedTime }; }));
    } else {
      out.push({ name: it.name, modifiedTime: it.modifiedTime });
    }
  }
  return out;
}

async function sheetText(fileId, token, limit) {
  try {
    const _mu = 'https://www.googleapis.com/drive/v3/files/' + fileId + '?fields=mimeType';
    const _mr = await fetch(_mu, { headers: { Authorization: 'Bearer ' + token } });
    const _meta = _mr.ok ? await _mr.json() : {};
    if (_meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
      const _eu = 'https://www.googleapis.com/drive/v3/files/' + fileId + '/export?mimeType=text%2Fcsv';
      const _er = await fetch(_eu, { headers: { Authorization: 'Bearer ' + token } });
      if (!_er.ok) throw new Error('export HTTP ' + _er.status);
      const _csv = await _er.text();
      const _lim = limit || 5000;
      if (_csv.length <= _lim) return _csv;
      const _head = _csv.slice(0, _csv.indexOf(String.fromCharCode(10)) + 1);
      return _head + _csv.slice(_csv.length - _lim);
    }
    const _u = 'https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media&supportsAllDrives=true';
    const _r = await fetch(_u, { headers: { Authorization: 'Bearer ' + token } });
    if (!_r.ok) throw new Error('HTTP ' + _r.status);
    const buf = Buffer.from(await _r.arrayBuffer());
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    let txt = '';
    wb.eachSheet(function (ws) {
      txt += '# ' + ws.name + String.fromCharCode(10);
      ws.eachRow(function (row) {
        const vals = (row.values || []).slice(1).map(function (v) {
          if (v === null || v === undefined) return '';
          if (typeof v === 'object') return String(v.text || v.result || v.formula || '');
          return String(v);
        });
        if (vals.join('').trim()) txt += vals.join(',') + String.fromCharCode(10);
      });
    });
    return txt.slice(0, limit || 5000);
  } catch (e) { return '(讀取失敗:' + e.message + ')'; }
}

async function gather() {
  const token = await gd.getAccessToken();
  const parts = [];
  for (const pair of SHEETS) {
    const t = await sheetText(pair[1], token, pair[0] === '特殊訂單' ? 9000 : 5000);
    parts.push('=== ' + pair[0] + ' ===' + String.fromCharCode(10) + t);
  }
  for (const pair of FOLDERS) {
    const files = await listFolder(pair[1], token, 1);
    const lines = files.map(function (f) { return f.name + ' | ' + (f.modifiedTime || ''); }).join(String.fromCharCode(10));
    parts.push('=== ' + pair[0] + '(資料夾清單) ===' + String.fromCharCode(10) + lines.slice(0, 3000));
  }
  return parts.join(String.fromCharCode(10) + String.fromCharCode(10));
}

const SO_ID = '1dZz8QkE3xudl8d1C5cY9HrZgY85MPtWfO66unUIGDXw';
const SO_OUT = () => pth.join(D(), 'ops-special-orders.json');

function parseCsv(t) {
  const rows = []; let row = [], cur = '', q = false;
  const CR = String.fromCharCode(13), LF = String.fromCharCode(10);
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else { q = false; } }
      else { cur += c; }
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === CR) { }
      else if (c === LF) { row.push(cur); cur = ''; rows.push(row); row = []; }
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function pickIdx(head, names) {
  for (const n of names) { const i = head.findIndex(function (h) { return (h || '').trim() === n; }); if (i >= 0) return i; }
  for (const n of names) { const i = head.findIndex(function (h) { return (h || '').indexOf(n) >= 0; }); if (i >= 0) return i; }
  return -1;
}

function dnum(s) {
  const m = String(s || '').match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (!m) return 0;
  return (+m[1]) * 10000 + (+m[2]) * 100 + (+m[3]);
}

async function buildSpecialOrders(token) {
  const url = 'https://www.googleapis.com/drive/v3/files/' + SO_ID + '/export?mimeType=text%2Fcsv';
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('export HTTP ' + r.status);
  const rows = parseCsv(await r.text());
  if (!rows.length) return [];
  let hi = 0;
  for (let i = 0; i < Math.min(rows.length, 5); i++) { if ((rows[i] || []).join('').indexOf('到貨') >= 0) { hi = i; break; } }
  const head = rows[hi].map(function (h) { return (h || '').trim(); });
  const iDate = pickIdx(head, ['到貨日期', '到貨']);
  const iPri = pickIdx(head, ['優先順序', '優先']);
  const iItem = pickIdx(head, ['訂單']);
  const iCat = pickIdx(head, ['類別']);
  const iQty = pickIdx(head, ['需求數量', '數量']);
  const iPay = pickIdx(head, ['狀態']);
  const iAmt = pickIdx(head, ['費用', '金額']);
  const iWho = pickIdx(head, ['聯絡窗口', '窗口']);
  const iBill = pickIdx(head, ['開單與否']);
  const iMethod = pickIdx(head, ['付款方式']);
  const out = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r2 = rows[i]; if (!r2 || !r2.join('').trim()) continue;
    const g = function (ix) { return ix >= 0 ? String(r2[ix] || '').replace(/\s+/g, ' ').trim() : ''; };
    const date = g(iDate); if (!date && !g(iItem)) continue;
    out.push({ d: date, s: dnum(date), pri: g(iPri), item: g(iItem), cat: g(iCat), qty: g(iQty), pay: g(iPay), amt: g(iAmt), who: g(iWho).slice(0, 24), bill: g(iBill), method: g(iMethod) });
  }
  const _t = new Date(Date.now() + 8 * 3600 * 1000);
  const _today = (+_t.toISOString().slice(0, 4)) * 10000 + (+_t.toISOString().slice(5, 7)) * 100 + (+_t.toISOString().slice(8, 10));
  out.sort(function (a, b) {
    if (a.s === 0 && b.s === 0) return 0;
    if (a.s === 0) return 1;
    if (b.s === 0) return -1;
    const af = a.s >= _today, bf = b.s >= _today;
    if (af && bf) return a.s - b.s;
    if (af && !bf) return -1;
    if (!af && bf) return 1;
    return b.s - a.s;
  });
  const res = out.slice(0, 300);
  const _now = new Date(Date.now() + 8 * 3600 * 1000);
  const _ym = (+_now.toISOString().slice(0, 4)) * 10000 + (+_now.toISOString().slice(5, 7)) * 100;
  let _mt = 0, _mc = 0;
  res.forEach(function (r3) {
    if (r3.s >= _ym && r3.s < _ym + 100) {
      const n = parseInt(String(r3.amt || '').replace(/[^0-9]/g, ''), 10);
      if (!isNaN(n)) { _mt += n; }
      _mc++;
    }
  });
  fs.writeFileSync(SO_OUT(), JSON.stringify({ updatedAt: new Date().toISOString(), count: res.length, monthTotal: _mt, monthCount: _mc, rows: res }, null, 1));
  return res;
}

async function run(anthropic) {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const today = now.toISOString().slice(0, 10);
  const ym = today.slice(0, 7);
  const bundle = await gather();
  const NLc = String.fromCharCode(10);
  const prompt = '以下是溫點 WarmPlace 的營運資料原始內容。今天是 ' + today + '。' + NLc +
    '請整理成「一行可讀字串」的扁平 JSON，鍵固定為：更新月份, 進行中檔期, 忘刷次數, 臨時請假人次, 備品最近叫貨, 效期報廢, 員購, 調貨, 特殊訂單_待付款, 特殊訂單_近7天出貨, 特殊訂單_本月合計。特殊訂單三欄請從「特殊訂單」資料判讀：待付款＝狀態為待付款的筆數與金額合計；近7天出貨＝到貨日期在今天起7天內的訂單（列客戶或品項與日期，最多3筆）；本月合計＝本月到貨的筆數與金額合計。' + NLc +
    '規則：更新月份填 ' + ym + '；進行中檔期挑開始<=今天<=結束者，並註明7天內即將開始者；忘刷次數與臨時請假人次統計本月各店；備品最近叫貨列各店最近日期；調貨統計本月筆數。' + NLc +
    '輸出規則（很重要）：每個欄位最多 40 字，不要長篇解釋。若本月沒有可用資料，該欄位直接輸出「沒有填寫」；若知道最後有資料的月份，寫成「沒有填寫（最後更新 YYYY-MM）」。有資料才列出實際數字。絕對不要編造數字。只輸出 JSON，不要任何其他文字。' + NLc + NLc + bundle;
  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }]
  });
  let txt = (msg.content || []).map(function (c) { return c.text || ''; }).join('').trim();
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('AI 回傳非 JSON');
  const obj = JSON.parse(txt.slice(s, e + 1));
  try { await buildSpecialOrders(await gd.getAccessToken()); } catch (e) { console.error('[ops-sync] special-orders', e.message); }
  obj.syncedAt = new Date().toISOString();
  fs.writeFileSync(OUT(), JSON.stringify(obj, null, 2));
  return obj;
}

function register(app, cron, anthropic) {
  const express = require('express');
  app.get('/api/dashboard/special-orders', function (req, res) {
    try {
      const f = SO_OUT();
      if (!fs.existsSync(f)) return res.json({ ok: true, count: 0, monthTotal: 0, monthCount: 0, rows: [] });
      res.json(JSON.parse(fs.readFileSync(f, 'utf8')));
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.get('/api/ops/debug', async function (req, res) {
    if ((req.headers['x-report-token'] || '') !== (process.env.REPORT_TOKEN || '__none__')) return res.status(403).json({ error: 'forbidden' });
    const out = {};
    for (const p of SHEETS) { const t = await sheetText(p[1], await gd.getAccessToken(), 400); out[p[0]] = (t.indexOf('(讀取失敗') === 0) ? t.slice(0, 160) : ('ok len=' + t.length); }
    res.json(out);
  });
  app.post('/api/ops/sync-now', express.json(), async function (req, res) {
    if ((req.headers['x-report-token'] || '') !== (process.env.REPORT_TOKEN || '__none__')) return res.status(403).json({ error: 'forbidden' });
    try { const o = await run(anthropic); res.json({ ok: true, keys: Object.keys(o), syncedAt: o.syncedAt }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  try {
    cron.schedule('0 8 * * *', function () {
      run(anthropic).then(function (o) { console.log('[ops-sync] ok keys=' + Object.keys(o).length); })
        .catch(function (e) { console.error('[ops-sync] failed', e.message); });
    }, { timezone: 'Asia/Taipei' });
    console.log('[ops-sync] cron registered (daily 08:00 Asia/Taipei)');
  } catch (e) { console.error('[ops-sync] register failed', e.message); }
}

module.exports = { register, run, gather };
