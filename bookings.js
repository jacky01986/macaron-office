// bookings.js — 預約成交追蹤系統
// 記錄每筆預約 → 算每位老師真實 ROI（不只 CPL，是 LTV / 營收）

const fs = require('fs');
const path = require('path');
const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'bookings.jsonl');

function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }

function loadAll() {
  ensureDir();
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function append(record) {
  ensureDir();
  try { fs.appendFileSync(FILE, JSON.stringify(record) + '\n'); } catch {}
}

// 新增一筆預約
function addBooking({ customer_name, amount_ntd, service, teacher, source, notes }) {
  const record = {
    id: 'bk_' + Date.now(),
    ts: new Date().toISOString(),
    customer_name: customer_name || 'unknown',
    amount_ntd: parseFloat(amount_ntd) || 0,
    service: service || null,
    teacher: teacher || null,
    source: source || null,
    notes: notes || null
  };
  append(record);
  return record;
}

// 解析 Telegram 指令 /booked 客戶名 NT$1580 12入禮盒 台南店
function parseBookedCommand(text) {
  const m = text.match(/^\/booked\s+(.+)$/i);
  if (!m) return null;
  const args = m[1].trim().split(/\s+/);
  const result = { customer_name: args[0] };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (/^\$?NT\$?\d+/i.test(a) || /^\d{3,}$/.test(a)) {
      result.amount_ntd = parseInt(a.replace(/[^0-9]/g, ''));
    } else if (/^(6入|12入|單顆|禮盒|客製|婚禮|企業禮贈)/.test(a)) {
      result.service = a;
    } else if (/^(paisley|amanda|sinda|lilly|ofz)$/i.test(a)) {
      result.teacher = a.toLowerCase();
    } else {
      result.notes = (result.notes || '') + ' ' + a;
    }
  }
  return result;
}

// 統計：總營收、各老師營收、平均客單價、詢問→成交率
async function getStats(days) {
  days = days || 30;
  const cutoff = Date.now() - days * 86400000;
  const all = loadAll().filter(b => new Date(b.ts).getTime() >= cutoff);
  const total_revenue = all.reduce((s, b) => s + (b.amount_ntd || 0), 0);
  const total_bookings = all.length;
  const avg_ticket = total_bookings > 0 ? Math.round(total_revenue / total_bookings) : 0;
  // 各老師
  const by_teacher = {};
  for (const b of all) {
    const t = b.teacher || 'unknown';
    if (!by_teacher[t]) by_teacher[t] = { bookings: 0, revenue: 0, services: {} };
    by_teacher[t].bookings++;
    by_teacher[t].revenue += b.amount_ntd || 0;
    if (b.service) by_teacher[t].services[b.service] = (by_teacher[t].services[b.service] || 0) + 1;
  }
  // 真實 ROI（如果能拿到廣告花費）
  let teachersROI = {};
  try {
    const r = await fetch('http://localhost:' + (process.env.PORT || 10000) + '/api/teachers/summary?days=' + days).then(x => x.json());
    for (const [k, t] of Object.entries(r.teachers || {})) {
      const bks = by_teacher[k] || { bookings: 0, revenue: 0 };
      const spend = t.spend_ntd || 0;
      teachersROI[k] = {
        name: t.name, inquiries: t.lead_count, bookings: bks.bookings,
        revenue: bks.revenue, spend,
        conversion_rate: t.lead_count > 0 ? (bks.bookings / t.lead_count * 100).toFixed(1) + '%' : 'N/A',
        roas: spend > 0 ? (bks.revenue / spend).toFixed(2) : 'N/A',
        cost_per_booking: bks.bookings > 0 ? Math.round(spend / bks.bookings) : null
      };
    }
  } catch {}
  return { days_range: days, total_bookings, total_revenue, avg_ticket, by_teacher, teachers_roi: teachersROI };
}

function recent(n) {
  n = n || 20;
  return loadAll().slice(-n).reverse();
}

module.exports = { addBooking, parseBookedCommand, getStats, recent, loadAll };
