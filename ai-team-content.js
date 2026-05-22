// ai-team-content.js — OFZ AI 教研團隊（NORA + YUKI 第一波）
//
// 第一年訂閱內容用 AI 團隊產出，老闆只要每月拍 1 小時片 + 半小時 Q&A 直播
//
// 角色：
//   NORA  Opus 4.6   訂閱內容主編 — 每月 1 號規劃下個月主題
//   YUKI  Sonnet 4.6 教學腳本撰寫 — 每月 5 號寫完整課文 + 講師逐字稿
//   RIO   (M2 才接)  影片製作助理 — 拍攝腳本、shot list、字幕
//   MIKA  (M2 才接)  學員社群輔導 — 24/7 答疑 + 週話題
//
// cron:
//   每月 1 號 09:00 → NORA 規劃下月主題
//   每月 5 號 09:00 → YUKI 接手 NORA 主題 → 寫完整課文
//   產出存到 data/ai-content-monthly.json，並推 LINE 給老闆
//
// 環境變數：
//   ANTHROPIC_API_KEY（已設）
//   ADMIN_LINE_USER_ID（已設）
//   CLAUDE_DIRECTOR_MODEL（預設 claude-opus-4-6，NORA 用）
//   CLAUDE_MODEL（預設 claude-sonnet-4-6，YUKI 用）

const fs = require('fs');
const path = require('path');
let customerProfiler;
try { customerProfiler = require('./customer-profiler'); } catch (e) { customerProfiler = null; }

const DATA_DIR = path.join(__dirname, 'data');
const CONTENT_FILE = path.join(DATA_DIR, 'ai-content-monthly.json');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch {}

const decisions = (() => { try { return require('./decisions'); } catch { return null; } })();
const { BUSINESS_CONTEXT } = require('./business-context');
const scout = (() => { try { return require('./scout'); } catch { return null; } })();
const customers = (() => { try { return require('./customers'); } catch { return null; } })();
const lineConv = (() => { try { return require('./line-conversion'); } catch { return null; } })();

const NORA_MODEL = process.env.CLAUDE_DIRECTOR_MODEL || 'claude-opus-4-6';
const YUKI_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

// ============================================================
// File I/O
// ============================================================
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadContent() {
  ensureDir();
  if (!fs.existsSync(CONTENT_FILE)) return { months: {} };
  try { return JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8')); } catch { return { months: {} }; }
}
function saveContent(state) {
  ensureDir();
  fs.writeFileSync(CONTENT_FILE, JSON.stringify(state, null, 2));
}

function nextMonthKey() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function thisMonthKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

// ============================================================
// Claude client
// ============================================================
let client = null;
function getClient() {
  if (client) return client;
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try { client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); }
  catch { client = null; }
  return client;
}

async function callClaude(model, systemPrompt, userPrompt, maxTokens = 3000) {
  // Auto-inject customer profile insights (separated: service vs course) so all AI employees write based on real customers
  try {
    if (customerProfiler) {
      const svc = customerProfiler.formatInsightsForPrompt('service');
      const crs = customerProfiler.formatInsightsForPrompt('course');
      let extra = '';
      if (svc) extra += '\n\n' + svc;
      if (crs) extra += '\n\n' + crs;
      if (extra) systemPrompt = (systemPrompt || '') + '\n\n[OFZ 真實客人畫像快照 — 你寫的內容必須針對這些客人在問的問題、興趣的服務/課程設計]:' + extra;
    }
  } catch (e) {}

  const c = getClient();
  if (!c) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await c.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const block = res.content && res.content[0];
  if (block && block.type === 'text') return block.text.trim();
  throw new Error('Claude returned no text content');
}

// ============================================================
// 收集數據（給 NORA 看）
// ============================================================
async function gatherContext() {
  const ctx = { now: new Date().toISOString().slice(0, 10) };
  try {
    if (customers && typeof customers.getSegmentSnapshot === 'function') {
      ctx.customers = await customers.getSegmentSnapshot();
    }
  } catch {}
  try {
    if (lineConv && typeof lineConv.getMonthStats === 'function') {
      ctx.this_month_orders = lineConv.getMonthStats();
    }
  } catch {}
  try {
    if (decisions && typeof decisions.getAll === 'function') {
      const all = await decisions.getAll();
      ctx.recent_orders = (all.history || [])
        .filter(h => h.metadata?.type === 'order')
        .slice(-30);
    }
  } catch {}
    // Customer profile insights (separated by type: service vs course)
  try {
    if (customerProfiler) {
      ctx.customer_insights_service = customerProfiler.formatInsightsForPrompt('service') || '';
      ctx.customer_insights_course = customerProfiler.formatInsightsForPrompt('course') || '';
    }
  } catch (e) {}
  return ctx;
}

// ============================================================
// NORA — 訂閱內容主編
// ============================================================
async function noraPlanNextMonth(targetMonth) {
  const monthKey = (targetMonth || nextMonthKey());
  const ctx = await gatherContext();

  const prevMonths = loadContent().months;
  const recentThemes = Object.values(prevMonths)
    .slice(-6)
    .map(m => m.theme)
    .filter(Boolean);

  const sys = `${BUSINESS_CONTEXT}${scout ? '\n\n' + scout.getContextForOtherAgents() : ''}

你是 NORA — MACARON DE LUXE 訂閱內容主編。
你的任務是規劃 ${monthKey} 月的進修訂閱主題（給已經學完 Lv1 的學員）。

OFZ 的客戶結構：
- 禮贈客戶為主、自我犒賞客戶為輔
- 已學完 Lv1 想升級的舊生 = 訂閱主要受眾
- 訂閱方案 NT$ 1,999/月，含每月 1 個新技術短課 + 學員社群 + 月 1 次直播 Q&A

你要產出：
1. 主題（1 個明確的技術重點）
2. 為什麼這個月選這個（連到本月時節 / 最近成交數據 / 學員需求）
3. 4 個子主題（拆解技術點）
4. 學完後學員能做出什麼成果
5. 行銷 tagline 1 句（給 CAMILLE 寫推廣文用）

最近 6 個月主題（避免重複）：${recentThemes.length ? recentThemes.join('、') : '（首期）'}

輸出嚴格用 JSON 格式：
{"month":"${monthKey}","theme":"...","reasoning":"...","subtopics":["...","...","...","..."],"outcome":"...","tagline":"..."}`;

  const user = `本月數據參考：\n${JSON.stringify(ctx, null, 2).slice(0, 2000)}\n\n請規劃 ${monthKey} 主題。只回 JSON 不要其他文字。`;

  let out;
  try {
    out = await callClaude(NORA_MODEL, sys, user, 2000);
  } catch (e) {
    console.error('[NORA] Claude failed:', e.message);
    return { ok: false, error: e.message };
  }

  // Parse JSON (tolerant)
  let plan;
  try {
    const jsonMatch = out.match(/\{[\s\S]*\}/);
    plan = JSON.parse(jsonMatch ? jsonMatch[0] : out);
  } catch (e) {
    console.error('[NORA] JSON parse failed:', e.message, '\nRaw:', out.slice(0, 200));
    return { ok: false, error: 'JSON parse failed', raw: out };
  }

  // Save
  const state = loadContent();
  state.months[monthKey] = Object.assign(state.months[monthKey] || {}, {
    plan,
    plan_created_at: new Date().toISOString(),
    plan_by: 'NORA',
    status: 'planned',
  });
  saveContent(state);

  console.log('[NORA] planned ' + monthKey + ': ' + plan.theme);

  // Push to decisions for visibility
  if (decisions && decisions.addPending) {
    try {
      await decisions.addPending({
        title: '📚 ' + monthKey + ' 訂閱主題：' + plan.theme,
        recommendation: 'NORA 規劃完成。理由：' + (plan.reasoning || '').slice(0, 100) + '\nYUKI 將在本月 5 號接手寫腳本',
        source: 'ai-team-nora',
        metadata: { type: 'content-plan', month: monthKey, theme: plan.theme },
      });
    } catch {}
  }

  return { ok: true, month: monthKey, plan };
}

// ============================================================
// YUKI — 教學腳本撰寫
// ============================================================
async function yukiWriteLesson(targetKey) {
  const monthKey = (targetKey || thisMonthKey());
  const state = loadContent();
  const monthEntry = state.months[monthKey];

  if (!monthEntry || !monthEntry.plan) {
    console.warn('[YUKI] no plan for ' + monthKey + ', skip');
    return { ok: false, reason: 'no plan' };
  }
  if (monthEntry.lesson) {
    console.log('[YUKI] ' + monthKey + ' already has lesson, skip');
    return { ok: true, skipped: true };
  }

  const plan = monthEntry.plan;
  const sys = `${BUSINESS_CONTEXT}${scout ? '\n\n' + scout.getContextForOtherAgents() : ''}

你是 YUKI — MACARON DE LUXE 的教學腳本撰寫師。
你的任務是把 NORA 規劃的主題轉成完整教學腳本，給老闆照念拍片。

要求：
1. 課程時長假設 30 分鐘（拆 4-5 段）
2. 講師逐字稿要口語化、像在教好朋友（不要太正式）
3. 每段含：標題、講師逐字稿、要 demo 的動作 cue、學員筆記重點
4. 最後加：學員作業 + 評分標準

輸出嚴格用 JSON 格式：
{
  "title": "...",
  "duration_min": 30,
  "intro": "...",
  "sections": [
    { "title": "...", "lines": "（講師逐字稿，口語化）", "demo_cue": "...", "notes": "..." }
  ],
  "assignment": "...",
  "rubric": ["...", "..."]
}`;

  const user = `主題：${plan.theme}
理由：${plan.reasoning}
子主題：${(plan.subtopics || []).join('、')}
預期學員產出：${plan.outcome}

請寫完整教學腳本。只回 JSON 不要其他文字。`;

  let out;
  try {
    out = await callClaude(YUKI_MODEL, sys, user, 4000);
  } catch (e) {
    console.error('[YUKI] Claude failed:', e.message);
    return { ok: false, error: e.message };
  }

  let lesson;
  try {
    const jsonMatch = out.match(/\{[\s\S]*\}/);
    lesson = JSON.parse(jsonMatch ? jsonMatch[0] : out);
  } catch (e) {
    console.error('[YUKI] JSON parse failed:', e.message);
    return { ok: false, error: 'JSON parse failed', raw: out };
  }

  monthEntry.lesson = lesson;
  monthEntry.lesson_created_at = new Date().toISOString();
  monthEntry.lesson_by = 'YUKI';
  monthEntry.status = 'lesson-ready';
  saveContent(state);

  console.log('[YUKI] lesson ready for ' + monthKey + ': ' + lesson.title);

  if (decisions && decisions.addPending) {
    try {
      await decisions.addPending({
        title: '✏️ ' + monthKey + ' 教學腳本完成：' + lesson.title,
        recommendation: 'YUKI 已寫好 ' + (lesson.sections || []).length + ' 段腳本（含逐字稿）。建議本週找時間拍片。',
        source: 'ai-team-yuki',
        metadata: { type: 'content-lesson', month: monthKey, title: lesson.title },
      });
    } catch {}
  }

  return { ok: true, month: monthKey, lesson };
}

// ============================================================
// 查詢介面（給 dashboard / 早安簡報用）
// ============================================================
// === RIO 影片製作助理 — 把 YUKI 的逐字稿轉成可拍攝的影片腳本 ===
async function rioWriteShootingScript(monthKey) {
  const state = loadContent();
  const key = monthKey || thisMonthKey();
  const monthData = state.months && state.months[key];
  if (!monthData || (!monthData.lessons && !monthData.plan && !monthData.raw)) {
    return { ok: false, reason: 'no plan or lesson for ' + key + '. 先請 NORA 規劃或 YUKI 寫腳本' };
  }
  const lessons = monthData.lessons || monthData.raw || monthData.plan;
  const sys = BUSINESS_CONTEXT + (scout ? '\n\n' + scout.getContextForOtherAgents() : '') + '\n\n' + '你是 RIO，MACARON DE LUXE 的影片製作助理。專長：把講師逐字稿轉成可拍攝的影片腳本，包含每段時長、鏡位、運鏡、字幕重點、shot list、道具清單。攝影師看了就能直接拍。';
  const userReq = '依下列課程逐字稿，產每課拍攝腳本：\n1. 開場（前 10 秒抓眼球）\n2. 主體分段（時長 / 鏡位 / 運鏡 / 字幕重點）\n3. 結尾 CTA\n4. shot list 必需鏡頭清單\n5. 道具清單\n\n課程資料：\n' + JSON.stringify(lessons, null, 2);
  const text = await callClaude(YUKI_MODEL, sys, userReq, 4500);
  if (!text || typeof text !== 'string') return { ok: false, reason: 'no response' };
  state.months[key].shooting_script = {
    by: 'RIO', model: YUKI_MODEL,
    generated_at: new Date().toISOString(),
    content: text,
  };
  saveContent(state);
  try { decisions.addPending({ title: '🎬 RIO 拍攝腳本完成 ' + key, source: 'ai-team-rio', body: text.slice(0, 800) }); } catch (e) { console.error('[RIO] addPending failed:', e.message); }
  return { ok: true, month: key, length: text.length };
}

// === MIKA 學員社群輔導 — 答疑 + 週話題 ===
async function mikaAnswerStudent(question, studentName) {
  if (!question) return { ok: false, reason: 'question required' };
  const sys = BUSINESS_CONTEXT + (scout ? '\n\n' + scout.getContextForOtherAgents() : '') + '\n\n' + '你是 MIKA，MACARON DE LUXE 學員社群輔導員。溫暖、專業、耐心。回答美甲技術問題並鼓勵學員。如果問題超出範圍，引導他們看哪一堂課或請教老師。回答 200-400 字，給可實作的建議。';
  const userReq = (studentName ? '學員：' + studentName + '\n' : '') + '問題：' + question;
  const text = await callClaude(YUKI_MODEL, sys, userReq, 1500);
  if (!text || typeof text !== 'string') return { ok: false, reason: 'no response' };
  const state = loadContent();
  if (!state.qa) state.qa = [];
  const record = {
    id: 'qa_' + Date.now().toString(36),
    at: new Date().toISOString(),
    student: studentName || 'anonymous',
    question, answer: text, by: 'MIKA',
  };
  state.qa.unshift(record);
  if (state.qa.length > 200) state.qa = state.qa.slice(0, 200);
  saveContent(state);
  return { ok: true, record };
}

async function mikaWeeklyTopic() {
  const sys = BUSINESS_CONTEXT + (scout ? '\n\n' + scout.getContextForOtherAgents() : '') + '\n\n' + '你是 MIKA，MACARON DE LUXE 學員社群輔導。每週寫一個能引爆討論的話題，給學員社群（FB 社團 / LINE 群）。要實用、有爭議、能讓學員分享自己作品。';
  const userReq = '寫本週學員社群話題（200-300 字），含：\n1. 一句話勾起好奇\n2. 為什麼這個話題重要（背景）\n3. 引導留言的 3-5 個具體問題';
  const text = await callClaude(YUKI_MODEL, sys, userReq, 1500);
  if (!text || typeof text !== 'string') return { ok: false, reason: 'no response' };
  const state = loadContent();
  if (!state.weekly_topics) state.weekly_topics = [];
  const record = {
    id: 'topic_' + Date.now().toString(36),
    at: new Date().toISOString(),
    content: text, by: 'MIKA',
  };
  state.weekly_topics.unshift(record);
  if (state.weekly_topics.length > 52) state.weekly_topics = state.weekly_topics.slice(0, 52);
  saveContent(state);
  try { decisions.addPending({ title: '💬 MIKA 本週社群話題', source: 'ai-team-mika', body: text }); } catch (e) { console.error('[MIKA] addPending failed:', e.message); }
  return { ok: true, record };
}

function getMonth(monthKey) {
  const state = loadContent();
  return state.months[monthKey || thisMonthKey()] || null;
}

function listMonths() {
  const state = loadContent();
  return Object.keys(state.months).sort();
}

// ============================================================
// Cron 註冊
// ============================================================
function registerCronJobs(cron) {
  if (!cron || typeof cron.schedule !== 'function') return;
  const tz = process.env.TZ || 'Asia/Taipei';

  // NORA 每月 1 號 09:00 規劃下個月
  cron.schedule('0 9 1 * *', () => {
    noraPlanNextMonth().catch(e => console.error('[NORA cron]', e.message));
  }, { timezone: tz });

  // YUKI 每月 5 號 09:00 寫本月腳本
  cron.schedule('0 9 5 * *', () => {
    yukiWriteLesson().catch(e => console.error('[YUKI cron]', e.message));
  }, { timezone: tz });

  cron.schedule('0 9 7 * *', () => { rioWriteShootingScript().catch(e => console.error('[RIO cron]', e)); }, { timezone: 'Asia/Taipei' });
  cron.schedule('30 9 * * 1', () => { mikaWeeklyTopic().catch(e => console.error('[MIKA cron]', e)); }, { timezone: 'Asia/Taipei' });
  console.log('[ai-team] cron jobs registered (NORA monthly 1st 09:00, YUKI monthly 5th 09:00)');
}

module.exports = {
  rioWriteShootingScript,
  mikaAnswerStudent,
  mikaWeeklyTopic,
  noraPlanNextMonth,
  yukiWriteLesson,
  getMonth,
  listMonths,
  registerCronJobs,
};
