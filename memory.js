// ============================================================
// memory.js — 集體記憶系統 (Team Memory)
// 讀過去 10 天 history → AI 消化 → team-memory.json
// → 注入所有員工 systemPrompt，全員學到老闆問過什麼、答過什麼
// 每天 04:00 自動合成（在 history 03:00 清舊紀錄之後）
// 掛載：app.use('/api/memory', require('./memory'))
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch {}

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const MEM_FILE = path.join(DATA_DIR, 'team-memory.json');
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';

let client = null;
function getClient() {
  if (client) return client;
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try { client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); } catch { client = null; }
  return client;
}

function ensureDir() { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }
function loadJSON(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function saveJSON(f, o) { ensureDir(); try { fs.writeFileSync(f, JSON.stringify(o, null, 2)); return true; } catch (e) { console.error('[memory] save', e.message); return false; } }

const MEMORY_PROMPT = `你是 溫點 WarmPlace 的「集體記憶整理員」。職責：把過去 10 天 Sam（老闆）跟 AI 員工之間的所有問答 / 對話 / 生成內容，消化成讓全體員工都能學到的「團隊記憶」。

你的工作：
1. 讀完所有對話與生成紀錄
2. 找出反覆出現的模式：常被問什麼、Sam 在意什麼、做過什麼決策、不喜歡什麼用詞
3. 提煉出「下次該怎麼做」的具體做法
4. 標出每位員工該特別記得的個性化備忘錄

【鐵則】
- 只寫對未來決策有用的洞察，不流水帳記錄
- 寫具體做法不寫抽象原則（壞例：「保持品牌一致」；好例：「禮盒文案禁用『限時搶購/超讚/必吃』」）
- 風格簡潔，每段 ≤ 3 行
- 如果某員工沒紀錄，就跳過該員工區段不要硬寫

【輸出格式 — 純文字，不要 markdown 圍欄】

# 團隊記憶（YYYY-MM-DD 更新）

## 老闆關心的重點
（5 條以內，每條 1 行）

## 已做的決策 / 已定的標準
（5 條以內）

## 文字風格觀察（給 NOVA / CAMILLE / SOLA）
（觀察到的偏好＋禁忌）

## 私訊 / 客服洞察（給 HANA）
（如有）

## 拍攝 / 影音洞察（給 RINA / DIRECTOR）
（如有）

## 門市教育洞察（給 MIRA）
（如有）

## 行銷專案洞察（給 JUNE）
（如有）

## 全員必須記得
（最高優先順序的 3 條提醒）`;

// 把 history items 整理成餵給 AI 的文字
function buildContext(items) {
  const byFn = {};
  for (const it of items) {
    const k = it.fn || 'OTHER';
    if (!byFn[k]) byFn[k] = [];
    byFn[k].push({
      ts: new Date(it.ts || Date.now()).toISOString().slice(0, 16),
      title: (it.title || '').slice(0, 120),
      text: (it.text || '').slice(0, 800),
    });
  }
  const out = [];
  for (const [fn, arr] of Object.entries(byFn)) {
    out.push('=== ' + fn + '（' + arr.length + ' 筆）===');
    for (const x of arr.slice(0, 30)) {
      out.push('[' + x.ts + '] ' + x.title);
      if (x.text) out.push(x.text);
      out.push('');
    }
  }
  return out.join('\n').slice(0, 28000);
}

async function synthesize() {
  const c = getClient();
  if (!c) throw new Error('ANTHROPIC_API_KEY 未設');
  // 讀 history
  let history = null;
  try { history = require('./history'); } catch {}
  if (!history) throw new Error('history 模組未載入');
  const items = history.list({ limit: 500 });
  if (!items.length) {
    const empty = { updated_at: new Date().toISOString(), digest: '（過去 10 天沒有任何對話紀錄，記憶為空。）', source_count: 0 };
    saveJSON(MEM_FILE, empty);
    return empty;
  }
  const ctx = buildContext(items);
  const r = await c.messages.create({
    model: MODEL,
    max_tokens: 2500,
    system: MEMORY_PROMPT,
    messages: [{ role: 'user', content: '請依以下過去 10 天的對話與生成紀錄，消化成團隊記憶。\n\n=== 紀錄開始 ===\n' + ctx + '\n=== 紀錄結束 ===\n\n直接輸出格式化團隊記憶（純文字）。' }],
  });
  const digest = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const obj = { updated_at: new Date().toISOString(), digest, source_count: items.length };
  saveJSON(MEM_FILE, obj);
  return obj;
}

function current() { return loadJSON(MEM_FILE, null); }

// 移除孤立 surrogate 半字 (防 Anthropic JSON 拒收)
function safeStr(s) { return String(s || '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, ''); }

// 給其他模組（employees.js）注入用，回傳乾淨的純文字尾段
function getMemoryTail() {
  try {
    const m = current();
    if (!m || !m.digest) return '';
    return '\n\n=== 團隊集體記憶（每天 04:00 自動更新，全員共用）===\n' + safeStr(String(m.digest).slice(0, 2500)) + '\n=== 團隊記憶結束 ===\n';
  } catch { return ''; }
}

// ── 路由 ──
router.get('/current', (req, res) => {
  const m = current();
  if (!m) return res.json({ ok: true, item: null, message: '尚未合成記憶，請按下「合成」或等明天 04:00 自動跑' });
  res.json({ ok: true, item: m });
});

router.post('/synthesize', async (req, res) => {
  try {
    const m = await synthesize();
    res.json({ ok: true, item: m });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/ping', (req, res) => res.json({ ok: true, model: MODEL, has_key: !!process.env.ANTHROPIC_API_KEY }));

// ── 每天 04:00 自動消化 ──
function registerCron(cron) {
  if (!cron || typeof cron.schedule !== 'function') return;
  const tz = process.env.TZ || 'Asia/Taipei';
  cron.schedule('0 4 * * *', async () => {
    try {
      const m = await synthesize();
      console.log('[memory] daily synthesize OK · sources=' + m.source_count + ' · digest=' + (m.digest || '').length + ' chars');
    } catch (e) { console.error('[memory] daily synthesize failed:', e.message); }
  }, { timezone: tz });
  console.log('[memory] cron registered (daily 04:00 team-memory synthesize)');
}

module.exports = router;
module.exports.synthesize = synthesize;
module.exports.current = current;
module.exports.getMemoryTail = getMemoryTail;
module.exports.registerCron = registerCron;
