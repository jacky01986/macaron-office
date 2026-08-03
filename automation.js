// automation.js — 自動化主控 (feature flags / kill switch)
// 所有自動化 cron / 發送前先 require('./automation').isEnabled('key') 檢查。
// 主開關 master 關掉 = 全部停。單一 key 未設定時預設沿用 registry 的 default(不破壞現有行為)。
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'automation_settings.json');

const REGISTRY = [
  { key: 'master',          label: '主開關（關掉 = 全部自動化停）', desc: '總煞車。關掉後所有自動化一律不執行。', default: true },
  { key: 'auto_publish',    label: 'FB / IG 自動發文（每天 09:00 / 19:00）', desc: 'FB 產完直接貼粉專；IG 產草稿等你核准。', default: true },
  { key: 'geo_publish',     label: 'GEO 長文自動發布', desc: '每天把 GEO 長文發到自架 blog / FB。', default: true },
  { key: 'shopline_digest', label: 'Shopline 每日早報（Telegram）', desc: '每天 09:00 推昨日訂單 / 營收到 Telegram。', default: true },
  { key: 'auto_reply_flows',label: '自動回覆流程（FB / IG 私訊）', desc: '關鍵字觸發的私訊自動回覆流程。', default: true },
];

function ensureDir(){ try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }

function load(){
  ensureDir();
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  const out = {};
  for (const it of REGISTRY) out[it.key] = (saved[it.key] === undefined) ? it.default : !!saved[it.key];
  for (const k of Object.keys(saved)) if (out[k] === undefined) out[k] = !!saved[k];
  return out;
}

function save(patch){
  ensureDir();
  const merged = { ...load(), ...patch };
  try { fs.writeFileSync(FILE, JSON.stringify(merged, null, 2)); } catch (e) { console.error('[automation] save', e.message); }
  return merged;
}

// 給其他模組 / cron 開工前檢查
function isEnabled(key){
  const s = load();
  if (s.master === false) return false;
  if (key === undefined) return s.master !== false;
  return s[key] !== false;
}

router.get('/settings', (req, res) => {
  res.json({ ok: true, registry: REGISTRY, settings: load() });
});

router.post('/settings', express.json(), (req, res) => {
  const body = req.body || {};
  const patch = {};
  for (const it of REGISTRY) if (typeof body[it.key] === 'boolean') patch[it.key] = body[it.key];
  if (body.key && typeof body.value === 'boolean') patch[body.key] = body.value;
  if (Object.keys(patch).length === 0) return res.status(400).json({ ok: false, error: 'no boolean settings provided' });
  res.json({ ok: true, settings: save(patch) });
});

module.exports = router;
module.exports.isEnabled = isEnabled;
module.exports.load = load;
module.exports.REGISTRY = REGISTRY;
