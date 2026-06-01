// ============================================================
// history.js — 歷史紀錄通用模組
// 任何 AI 員工生成內容後呼叫 history.record({fn,title,html,text,meta})
// 持久化到 /var/data/history.json (cap 500)
// 路由：app.use('/api/history', require('./history'))
// 提供 record(rec) 給其他模組直接呼叫
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'history.json');
const KEEP_DAYS = 10;  // 保留 10 天
const MS_DAY = 86400 * 1000;

function ensureDir() { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }
function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { items: [] }; } }
function save(obj) { ensureDir(); try { fs.writeFileSync(FILE, JSON.stringify(obj, null, 2)); return true; } catch (e) { console.error('[history] save failed', e.message); return false; } }
function genId() { return 'h_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// AI 員工 → 顯示資訊（icon + 顏色 + 中文名）
const FN = {
  NOVA:     { icon: '📱', label: 'NOVA · 社群草稿',     color: '#D88AA0' },
  RINA:     { icon: '🎬', label: 'RINA · 短影音',       color: '#A99BC5' },
  MIRA:     { icon: '🏪', label: 'MIRA · 門市教材',     color: '#9CB47A' },
  JUNE:     { icon: '📋', label: 'JUNE · 行銷專案',     color: '#B08D57' },
  SOLA:     { icon: '🛒', label: 'SOLA · 官網營運',     color: '#E8B280' },
  HANA:     { icon: '💬', label: 'HANA · 私訊草稿',     color: '#D4A574' },
  DIRECTOR: { icon: '📸', label: 'DIRECTOR · 拍攝示意', color: '#B07A47' },
  CAMILLE:  { icon: '✏️', label: 'CAMILLE · 內容',     color: '#C9A66B' },
  GIA:      { icon: '🌐', label: 'GIA · GEO 長文',     color: '#9E7A55' },
  VICTOR:   { icon: '👑', label: 'VICTOR · 總監決策',   color: '#6D2E46' },
  DEX:      { icon: '📊', label: 'DEX · 數據報表',     color: '#5C4A3A' },
  AUTO:     { icon: '🤖', label: '自動發文草稿',       color: '#7B6650' },
};

function purgeOld(s) {
  try {
    const cutoff = Date.now() - KEEP_DAYS * MS_DAY;
    s.items = (s.items || []).filter(x => (x.ts || 0) >= cutoff);
  } catch {}
}

function record(rec = {}) {
  try {
    const r = {
      id: genId(),
      ts: Date.now(),
      fn: String(rec.fn || 'NOVA').toUpperCase(),
      title: String(rec.title || '未命名').slice(0, 200),
      html: String(rec.html || '').slice(0, 60000),
      text: String(rec.text || '').slice(0, 8000),
      meta: rec.meta || {},
    };
    const s = load();
    s.items = s.items || [];
    s.items.unshift(r);
    purgeOld(s);
    save(s);
    return r;
  } catch (e) { console.error('[history] record failed', e.message); return null; }
}

function list({ limit = 50, fn = null } = {}) {
  const s = load();
  let items = (s.items || []);
  if (fn) items = items.filter(x => x.fn === String(fn).toUpperCase());
  return items.slice(0, Math.max(1, Math.min(limit, 1000))).map(x => ({
    id: x.id, ts: x.ts, fn: x.fn, title: x.title,
    icon: (FN[x.fn] || {}).icon || '📄',
    label: (FN[x.fn] || {}).label || x.fn,
    color: (FN[x.fn] || {}).color || '#B08D57',
    snippet: (x.text || '').slice(0, 80),
  }));
}

function get(id) {
  const s = load();
  const r = (s.items || []).find(x => x.id === id);
  if (!r) return null;
  const meta = FN[r.fn] || {};
  return { ...r, icon: meta.icon || '📄', label: meta.label || r.fn, color: meta.color || '#B08D57' };
}

// 路由
router.get('/list', (req, res) => {
  try {
    const limit = Number(req.query.limit) || 50;
    const fn = req.query.fn || null;
    res.json({ ok: true, items: list({ limit, fn }) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/functions', (req, res) => {
  res.json({ ok: true, functions: Object.entries(FN).map(([k, v]) => ({ key: k, ...v })) });
});

router.get('/:id', (req, res) => {
  const r = get(req.params.id);
  if (!r) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, item: r });
});

router.delete('/:id', (req, res) => {
  try {
    const s = load();
    const before = (s.items || []).length;
    s.items = (s.items || []).filter(x => x.id !== req.params.id);
    save(s);
    res.json({ ok: true, removed: before - s.items.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/clear', (req, res) => {
  save({ items: [] });
  res.json({ ok: true });
});

module.exports = router;
module.exports.record = record;
module.exports.list = list;
module.exports.get = get;
module.exports.FN = FN;

// 每天 03:00 自動清除超過 10 天的舊紀錄
function registerCron(cron) {
  if (!cron || typeof cron.schedule !== 'function') return;
  const tz = process.env.TZ || 'Asia/Taipei';
  cron.schedule('0 3 * * *', () => {
    try {
      const s = load();
      const before = (s.items || []).length;
      purgeOld(s);
      save(s);
      console.log('[history] daily purge: kept ' + s.items.length + ' (removed ' + (before - s.items.length) + ' > 10 days)');
    } catch (e) { console.error('[history] daily purge', e.message); }
  }, { timezone: tz });
  console.log('[history] cron registered (daily 03:00 purge > 10 days)');
}

module.exports.registerCron = registerCron;
module.exports.purgeOld = purgeOld;
