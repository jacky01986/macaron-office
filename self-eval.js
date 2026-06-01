// ============================================================
// self-eval.js — 每晚 22:00 員工自我檢討
// 各員工讀自己最近 7 天的產出 → AI 找出最差 3 件 → 寫進 daily-lesson.json
// 隔天 systemPrompt 自動把這份「昨日教訓」注入，讓員工會「學」
// ============================================================
const fs = require('fs');
const path = require('path');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch {}

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const SELF_EVAL_DIR = path.join(DATA_DIR, 'self-eval');
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

function ensureDir() { try { if (!fs.existsSync(SELF_EVAL_DIR)) fs.mkdirSync(SELF_EVAL_DIR, { recursive: true }); } catch {} }

let _client = null;
function getClient() {
  if (_client) return _client;
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try { _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); } catch { _client = null; }
  return _client;
}

const EMP_LIST = ['NOVA','RINA','MIRA','JUNE','SOLA','HANA','DIRECTOR','CAMILLE','GIA','VICTOR','DEX'];

const EVAL_PROMPT = `你是 {EMP} 的「自我檢討教練」。職責：讀完 {EMP} 過去 7 天所有的產出，找出 3 件做得最差的，給具體改善建議。

【鐵則 — 評估標準】
🔴 沒具體數字/品名/時間
🔴 違反品牌鐵則（廣告話、課程詞、限時搶購/超讚/必吃、舊業態）
🔴 沒洞察「Sam 看了會說『這我也想得到』」
🔴 沒回到 Sam 真正的問題

【輸出格式 — 純文字、極簡，給明天的 {EMP} 自己看】

📅 {EMP} 的昨日教訓（{DATE}）

❌ 做差的 1：[一句話講錯在哪]
✅ 明天怎麼改：[具體做法，要含「不要寫 X，改寫 Y」]

❌ 做差的 2：...
✅ 明天怎麼改：...

❌ 做差的 3：...
✅ 明天怎麼改：...

⭐ 上週做得最好的一件：[一句話]
→ 為什麼好：[一句話]

【若紀錄少於 3 件】只寫「過去 7 天紀錄不足，無教訓可學。」一句即可。
`;

function buildContext(items) {
  return items.slice(0, 20).map((it, i) => {
    const ts = new Date(it.ts || Date.now()).toISOString().slice(0,10);
    return `[${i+1}] ${ts} · ${(it.title||'').slice(0,80)}\n${(it.text||'').slice(0,400)}`;
  }).join('\n---\n');
}

async function evalOne(emp) {
  const c = getClient();
  if (!c) return { error: 'ANTHROPIC_API_KEY 未設' };
  let history;
  try { history = require('./history'); } catch { return { error: 'history not loaded' }; }
  const all = history.list({ limit: 100, fn: emp });
  const sevenDaysAgo = Date.now() - 7 * 86400 * 1000;
  const items = all.filter(x => (x.ts||0) >= sevenDaysAgo);
  if (items.length === 0) {
    return { emp, items: 0, lesson: '過去 7 天紀錄不足，無教訓可學。' };
  }
  const ctx = buildContext(items);
  const today = new Date().toISOString().slice(0, 10);
  const prompt = EVAL_PROMPT.replace(/\{EMP\}/g, emp).replace(/\{DATE\}/g, today);
  const r = await c.messages.create({
    model: MODEL, max_tokens: 1500,
    system: prompt,
    messages: [{ role: 'user', content: '請看完以下 ' + emp + ' 過去 7 天的產出，找出 3 件做最差的，給明天的改善建議。\n\n' + ctx }],
  });
  const lesson = (r.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').trim();
  return { emp, items: items.length, lesson };
}

async function runAll() {
  ensureDir();
  const results = [];
  for (const emp of EMP_LIST) {
    try {
      const r = await evalOne(emp);
      results.push(r);
      // 寫進 disk — 每員工一個檔
      const f = path.join(SELF_EVAL_DIR, emp + '.json');
      fs.writeFileSync(f, JSON.stringify({ updated_at: new Date().toISOString(), ...r }, null, 2));
    } catch(e) {
      results.push({ emp, error: e.message });
    }
  }
  return results;
}

function getLessonFor(emp) {
  try {
    const f = path.join(SELF_EVAL_DIR, String(emp).toUpperCase() + '.json');
    if (!fs.existsSync(f)) return '';
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!j.lesson || /過去 7 天紀錄不足/.test(j.lesson)) return '';
    return '\n\n=== 📚 你的昨日教訓（自我檢討，今天先讀過再回答）===\n' + String(j.lesson).slice(0, 2000) + '\n=== 教訓結束 ===\n';
  } catch { return ''; }
}

function registerCron(cron) {
  if (!cron || typeof cron.schedule !== 'function') return;
  const tz = process.env.TZ || 'Asia/Taipei';
  cron.schedule('0 22 * * *', async () => {
    try {
      console.log('[self-eval] nightly run start');
      const r = await runAll();
      const summary = r.map(x => x.emp + ':' + (x.items||0) + (x.error ? ' ERR' : '')).join(' | ');
      console.log('[self-eval] done · ' + summary);
    } catch(e) { console.error('[self-eval] crash:', e.message); }
  }, { timezone: tz });
  console.log('[self-eval] cron registered (daily 22:00 全員 self-eval)');
}

module.exports = { runAll, evalOne, getLessonFor, registerCron, EMP_LIST };
