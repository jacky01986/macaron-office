// dashboard-range.js — 儀表板任意日期區間統計（給 teachers.html 右上角日期選擇器用）
// GET /api/dashboard/range?from=YYYY-MM-DD&to=YYYY-MM-DD&cmp=prev_period|prev_month|prev_year
//   本期   = from~to 每日營收加總（offline-reports.jsonl）
//   前期   = cmp 指定：prev_period 往前推等長天數 / prev_month 上月同日 / prev_year 去年同日
//   目標   = 區間落在各月的天數 ÷ 該月天數 × 該月目標（offline-targets.json，key = 門市|YYYY-MM）
//   Shopline / 客服進線 = 同區間
// 不帶 from/to 時預設本月 1 號到今天（台灣時間）。/api/dashboard/metrics 完全不動。
const fs = require('fs');
const pth = require('path');

function D() { return process.env.RENDER_DISK_MOUNT_PATH || '/var/data'; }
function twToday() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
function isYmd(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function toUtc(ymd) { return Date.parse(ymd + 'T00:00:00Z'); }
function fromUtc(ms) { return new Date(ms).toISOString().slice(0, 10); }
function addDays(ymd, n) { return fromUtc(toUtc(ymd) + n * 86400000); }
function daysBetween(a, b) { return Math.round((toUtc(b) - toUtc(a)) / 86400000) + 1; }
function daysInMonth(ym) { const y = +ym.slice(0, 4), m = +ym.slice(5, 7); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function shiftMonth(ymd, k) {
  const y = +ymd.slice(0, 4), m = +ymd.slice(5, 7), d = +ymd.slice(8, 10);
  const t = new Date(Date.UTC(y, m - 1 + k, 1));
  const ym = t.toISOString().slice(0, 7);
  return ym + '-' + String(Math.min(d, daysInMonth(ym))).padStart(2, '0');
}
function shiftYear(ymd, k) { return shiftMonth(ymd, 12 * k); }

function loadRecs() {
  const rf = pth.join(D(), 'offline-reports.jsonl');
  if (!fs.existsSync(rf)) return [];
  return fs.readFileSync(rf, 'utf8').trim().split(String.fromCharCode(10))
    .map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}
function loadTargets() {
  try { const tf = pth.join(D(), 'offline-targets.json'); return fs.existsSync(tf) ? JSON.parse(fs.readFileSync(tf, 'utf8')) : {}; }
  catch (e) { return {}; }
}
function recDate(r) { return String(r.report_date || r.date || '').slice(0, 10); }

// 區間內每月天數 → 目標按比例換算；月份沒目標就不算（全部沒目標回 null）
function proratedTarget(targets, branch, from, to) {
  let sum = 0, any = false;
  let cur = from.slice(0, 7) + '-01';
  while (cur <= to) {
    const ym = cur.slice(0, 7), dim = daysInMonth(ym);
    const mStart = ym + '-01', mEnd = ym + '-' + String(dim).padStart(2, '0');
    const a = from > mStart ? from : mStart, b = to < mEnd ? to : mEnd;
    const days = daysBetween(a, b);
    const t = targets[branch + '|' + ym];
    if (t && typeof t.target === 'number' && t.target > 0) { any = true; sum += t.target * days / dim; }
    cur = shiftMonth(mStart, 1);
  }
  return any ? Math.round(sum) : null;
}

function sumBranches(recs, from, to) {
  const out = {};
  recs.forEach(function (r) {
    const d = recDate(r); if (!d || d < from || d > to) return;
    const b = r.branch; if (!b) return;
    out[b] = out[b] || { revenue: 0, days: 0, last: null };
    out[b].revenue += Number(r.revenue) || 0;
    out[b].days++;
    if (!out[b].last || d > out[b].last) out[b].last = d;
  });
  return out;
}

function computeRange(opts) {
  const today = twToday();
  let from = isYmd(opts.from) ? opts.from : today.slice(0, 7) + '-01';
  let to = isYmd(opts.to) ? opts.to : today;
  if (to < from) { const t = from; from = to; to = t; }
  const cmp = ['prev_period', 'prev_month', 'prev_year'].indexOf(opts.cmp) >= 0 ? opts.cmp : 'prev_period';
  const len = daysBetween(from, to);
  let pFrom, pTo;
  if (cmp === 'prev_month') { pFrom = shiftMonth(from, -1); pTo = shiftMonth(to, -1); }
  else if (cmp === 'prev_year') { pFrom = shiftYear(from, -1); pTo = shiftYear(to, -1); }
  else { pTo = addDays(from, -1); pFrom = addDays(pTo, -(len - 1)); }

  const recs = loadRecs(), targets = loadTargets();
  const cur = sumBranches(recs, from, to), prev = sumBranches(recs, pFrom, pTo);
  // 門市清單：區間內有資料的 + 目標檔裡出現過的（避免整月沒填的店消失）
  const names = {};
  Object.keys(cur).forEach(function (b) { names[b] = 1; });
  Object.keys(prev).forEach(function (b) { names[b] = 1; });
  Object.keys(targets).forEach(function (k) { const b = k.split('|')[0]; if (b) names[b] = 1; });
  const lastAll = {};
  recs.forEach(function (r) { const d = recDate(r), b = r.branch; if (!b || !d) return; if (!lastAll[b] || d > lastAll[b]) lastAll[b] = d; });

  const by_branch = {};
  let sumCur = 0, sumPrev = 0, sumTarget = 0, anyTarget = false, maxLast = null;
  Object.keys(names).sort().forEach(function (b) {
    const c = cur[b] || { revenue: 0, days: 0, last: null };
    const p = prev[b] || { revenue: 0, days: 0, last: null };
    const tg = proratedTarget(targets, b, from, to);
    const o = {
      cur: Math.round(c.revenue), prev: Math.round(p.revenue),
      cur_days: c.days, prev_days: p.days,
      delta: Math.round(c.revenue - p.revenue),
      delta_pct: p.revenue ? Math.round((c.revenue / p.revenue - 1) * 1000) / 10 : null,
      target: tg, ach_pct: tg ? Math.round(c.revenue / tg * 1000) / 10 : null,
      last_date: lastAll[b] || null,
      last_in_range: c.last
    };
    by_branch[b] = o;
    sumCur += o.cur; sumPrev += o.prev; if (tg) { sumTarget += tg; anyTarget = true; }
    if (o.last_date && (!maxLast || o.last_date > maxLast)) maxLast = o.last_date;
  });
  return {
    from: from, to: to, days: len, cmp: cmp, prev_from: pFrom, prev_to: pTo,
    by_branch: by_branch,
    total: { cur: sumCur, prev: sumPrev, delta: sumCur - sumPrev, delta_pct: sumPrev ? Math.round((sumCur / sumPrev - 1) * 1000) / 10 : null, target: anyTarget ? sumTarget : null, ach_pct: anyTarget && sumTarget ? Math.round(sumCur / sumTarget * 1000) / 10 : null },
    last_date: maxLast
  };
}

function ssInbox(from, to) {
  const f = pth.join(D(), 'salesmartly-inbox.jsonl');
  const out = { inbox_range: 0, inbox_24h: 0, inbox_7d: 0 };
  if (!fs.existsSync(f)) return out;
  const a = toUtc(from) - 8 * 3600000, b = toUtc(to) + 86400000 - 8 * 3600000, now = Date.now();
  fs.readFileSync(f, 'utf8').trim().split(String.fromCharCode(10)).forEach(function (l) {
    if (!l) return;
    try { const t = JSON.parse(l).t || 0; if (t >= a && t < b) out.inbox_range++; if (now - t <= 86400000) out.inbox_24h++; if (now - t <= 604800000) out.inbox_7d++; } catch (e) {}
  });
  return out;
}

function register(app) {
  app.get('/api/dashboard/range', async function (req, res) {
    const out = { ok: true, updatedAt: new Date().toISOString() };
    try { out.range = computeRange({ from: req.query.from, to: req.query.to, cmp: req.query.cmp }); }
    catch (e) { out.rangeErr = e.message; }
    const from = out.range ? out.range.from : twToday().slice(0, 7) + '-01', to = out.range ? out.range.to : twToday();
    try { const sl = require('./shopline'); out.shopline = await sl.getOrdersSummary({ from: from, to: to }); } catch (e) { out.shoplineErr = e.message; }
    try { out.ss = ssInbox(from, to); } catch (e) { out.ssErr = e.message; }
    res.json(out);
  });
  console.log('[dashboard-range] mounted /api/dashboard/range');
}

module.exports = { register, computeRange, proratedTarget, _test: { shiftMonth, addDays, daysBetween } };
