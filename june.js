// ============================================================
// june.js — JUNE 行銷專案總管 (Marketing PM)
// 讀 SCOUT 全球市場調查 + DISTILL 行動建議 → 排成可執行專案(時程/負責人/相依)
// 專案看板：任務 todo/doing/done 追蹤，自動標出落後
// 每天 09:10 檢視：標落後 + 重新對齊 SCOUT 重點 (存 persistent disk)
// 掛載：app.use('/api/june', require('./june'));  cron：require('./june').registerCron(cron)
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch {}
const scout = (() => { try { return require('./scout'); } catch { return null; } })();

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const BOARD_FILE = path.join(DATA_DIR, 'june-board.json');
const MODEL = process.env.CLAUDE_MODEL || 'claude-fable-5';

const TEAM = 'VICTOR(總監/決策)、LEON(廣告投放)、CAMILLE(文案/SEO)、ARIA(視覺)、DEX(數據)、NOVA(社群/公關)、MILO(KOL)、RINA(短影音)、HANA(私訊成交)、MIRA(門市教育)、Sam(老闆/拍板)、店長(門市執行)';

let client = null;
function getClient() {
  if (client) return client;
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try { client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); } catch { client = null; }
  return client;
}
function ensureDir() { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }
function loadJSON(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function saveJSON(f, o) { ensureDir(); try { fs.writeFileSync(f, JSON.stringify(o, null, 2)); return true; } catch { return false; } }

// ── SCOUT 行動建議摘要 (JUNE 的依據) ──
function scoutIntel() {
  let intel = null;
  try { if (scout && scout.getMarketIntelligence) intel = scout.getMarketIntelligence(); } catch {}
  if (!intel) return { has: false, text: '(尚無 SCOUT 市場情報，請先到市場情報跑 SCOUT + DISTILL)', run: null };
  const obj = {
    weekly_focus: intel.weekly_focus,
    action_items: intel.action_items,
    trending_topics: intel.trending_topics,
    pricing_recommendations: intel.pricing_recommendations,
    threats_to_watch: intel.threats_to_watch,
  };
  return { has: true, text: JSON.stringify(obj).slice(0, 5500), run: intel.based_on_scout_run || intel.distilled_at || null, action_items: intel.action_items || [] };
}

function junePrompt() {
  return `你是 溫點 WarmPlace 的 AI 行銷專案總管，代號 JUNE (Marketing PM)。
你不是排程小編，你是把「策略」變成「可被執行、可被追蹤的專案」的資深 PM。
品牌：精品馬卡龍 + 費南雪韓系禮贈，4 家門店(台南本店、新光西門/中港/南西 B2)，月預算 NT$60,000。

【鐵則 — 你的專案一律源自市場調查，禁止憑空發想】
1. 每個專案/任務都要對應 SCOUT 全球市場調查或 DISTILL 行動建議的某一條，並寫出「依據」。
2. 你只負責規劃與追蹤，不親自寫文案/投廣告 — 指派給對的人。
3. 百貨櫃點(新光三越四櫃)有檔期節奏，行銷要對齊。
4. 每件任務都要：負責人 + 起訖時間(用 Day N 相對天)+ 相依關係 + 交付物 + 完成定義。
5. 標出「需要 Sam 拍板的決策點」與「風險」。

【可指派的團隊】${TEAM}

【輸出格式 (HTML 片段)】
<div class="tldr">⚡ 一句話：這個專案要達成什麼、源自哪條市場洞察</div>
<h4>🎯 目標與成功指標</h4> (可量化 KPI)
<h4>🗓 專案時程</h4> <table class="data"> 欄位：階段、任務、負責人、Day N 起訖、相依、交付物
<h4>🚩 里程碑</h4>
<h4>❓ 需要 Sam 拍板</h4> (1-3 個二選一)
<h4>⚠️ 風險與備案</h4>
<h4>📌 對應的市場依據</h4> (明確引用 SCOUT/DISTILL 哪幾條)
用繁體中文，不要客套話。`;
}

// ── 產專案計畫 (源自 SCOUT) ──
async function generatePlan({ goal = '', weeks = 4 } = {}) {
  const c = getClient();
  if (!c) throw new Error('ANTHROPIC_API_KEY 未設');
  const intel = scoutIntel();
  const user = '請規劃一個 ' + weeks + ' 週的行銷專案。'
    + (goal ? '\n\n專案目標/主題：' + goal.slice(0, 500) : '\n\n沒有指定主題 — 請從下面 SCOUT 行動建議中挑「最該先做、最能帶業績」的一個，排成完整專案。')
    + '\n\n=== SCOUT 全球市場調查 + DISTILL 行動建議 (你的規劃依據，務必對應) ===\n' + intel.text
    + '\n\n嚴格依照你系統設定的輸出格式，每個任務都要有負責人、Day N 起訖、相依、交付物，並在最後明確標出對應哪幾條市場依據。';
  const r = await c.messages.create({ model: MODEL, max_tokens: 3500, system: junePrompt(), messages: [{ role: 'user', content: user }] });
  const html = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  try { const H = require('./history'); H.record({ fn:'JUNE', title: '專案規劃 · '+weeks+' 週' + (goal?' · '+goal.slice(0,50):''), html, text: html.replace(/<[^>]+>/g,' ').slice(0,2000), meta:{ weeks, scout_run: intel.run } }); } catch(e) { console.error('[history june]', e.message); }
  return { ok: true, weeks, goal: goal || '(由 JUNE 從 SCOUT 行動建議挑選)', html, based_on_scout: intel.has, scout_run: intel.run };
}

// ── 任務看板 (時程控管) ──
function loadBoard() { return loadJSON(BOARD_FILE, { tasks: [] }); }
function todayStr() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })).toISOString().slice(0, 10); }
function annotate(t) {
  const overdue = t.status !== 'done' && t.due && t.due < todayStr();
  return { ...t, overdue: !!overdue };
}

router.get('/scout-actions', (req, res) => {
  const intel = scoutIntel();
  res.json({ ok: true, has_intel: intel.has, scout_run: intel.run, action_items: intel.action_items || [] });
});

router.post('/plan', express.json({ limit: '256kb' }), async (req, res) => {
  try { res.json(await generatePlan(req.body || {})); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/board', (req, res) => {
  const b = loadBoard();
  const tasks = (b.tasks || []).map(annotate).sort((a, b2) => (a.due || '9999').localeCompare(b2.due || '9999'));
  const counts = { todo: 0, doing: 0, done: 0, overdue: 0 };
  tasks.forEach(t => { counts[t.status] = (counts[t.status] || 0) + 1; if (t.overdue) counts.overdue++; });
  res.json({ ok: true, counts, tasks });
});

router.post('/task', express.json(), (req, res) => {
  const { title, owner, due, project } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ ok: false, error: 'title 必填' });
  const b = loadBoard();
  const t = { id: 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4), title: String(title).slice(0, 200), owner: owner || '', due: due || '', project: project || '', status: 'todo', created_at: new Date().toISOString() };
  b.tasks.unshift(t);
  if (b.tasks.length > 300) b.tasks = b.tasks.slice(0, 300);
  saveJSON(BOARD_FILE, b);
  res.json({ ok: true, task: t });
});

router.post('/task/:id/status', express.json(), (req, res) => {
  const status = (req.body || {}).status;
  if (!['todo', 'doing', 'done'].includes(status)) return res.status(400).json({ ok: false, error: 'status 須為 todo/doing/done' });
  const b = loadBoard();
  const t = b.tasks.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ ok: false, error: 'task not found' });
  t.status = status; t.updated_at = new Date().toISOString();
  saveJSON(BOARD_FILE, b);
  res.json({ ok: true, task: annotate(t) });
});

router.delete('/task/:id', (req, res) => {
  const b = loadBoard(); const before = b.tasks.length;
  b.tasks = b.tasks.filter(x => x.id !== req.params.id);
  saveJSON(BOARD_FILE, b);
  res.json({ ok: true, removed: before - b.tasks.length });
});

// 每天 09:10 檢視落後 (log；看板即時也會標)
function registerCron(cron) {
  if (!cron || typeof cron.schedule !== 'function') return;
  const tz = process.env.TZ || 'Asia/Taipei';
  cron.schedule('10 9 * * *', () => {
    try {
      const b = loadBoard();
      const overdue = (b.tasks || []).filter(t => t.status !== 'done' && t.due && t.due < todayStr());
      console.log('[june] daily check — overdue tasks: ' + overdue.length);
    } catch (e) { console.error('[june] daily check', e.message); }
  }, { timezone: tz });
  console.log('[june] JUNE cron registered (daily 09:10 overdue check)');
}

module.exports = router;
module.exports.registerCron = registerCron;
