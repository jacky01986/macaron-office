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
  ['員購', '17vLnByZ5XBfwIF4Rh8guyy0wqJRI-gOe']
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
    const t = await sheetText(pair[1], token, 5000);
    parts.push('=== ' + pair[0] + ' ===' + String.fromCharCode(10) + t);
  }
  for (const pair of FOLDERS) {
    const files = await listFolder(pair[1], token, 1);
    const lines = files.map(function (f) { return f.name + ' | ' + (f.modifiedTime || ''); }).join(String.fromCharCode(10));
    parts.push('=== ' + pair[0] + '(資料夾清單) ===' + String.fromCharCode(10) + lines.slice(0, 3000));
  }
  return parts.join(String.fromCharCode(10) + String.fromCharCode(10));
}

async function run(anthropic) {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const today = now.toISOString().slice(0, 10);
  const ym = today.slice(0, 7);
  const bundle = await gather();
  const NLc = String.fromCharCode(10);
  const prompt = '以下是溫點 WarmPlace 的營運資料原始內容。今天是 ' + today + '。' + NLc +
    '請整理成「一行可讀字串」的扁平 JSON，鍵固定為：更新月份, 進行中檔期, 忘刷次數, 臨時請假人次, 備品最近叫貨, 效期報廢, 員購, 調貨。' + NLc +
    '規則：更新月份填 ' + ym + '；進行中檔期挑開始<=今天<=結束者，並註明7天內即將開始者；忘刷次數與臨時請假人次統計本月各店；備品最近叫貨列各店最近日期；調貨統計本月筆數。' + NLc +
    '資料不足一律標「未回填」或「無資料」，絕對不要編造數字。只輸出 JSON，不要任何其他文字。' + NLc + NLc + bundle;
  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }]
  });
  let txt = (msg.content || []).map(function (c) { return c.text || ''; }).join('').trim();
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('AI 回傳非 JSON');
  const obj = JSON.parse(txt.slice(s, e + 1));
  obj.syncedAt = new Date().toISOString();
  fs.writeFileSync(OUT(), JSON.stringify(obj, null, 2));
  return obj;
}

function register(app, cron, anthropic) {
  const express = require('express');
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
