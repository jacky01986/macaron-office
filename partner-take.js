// ============================================================
// partner-take.js — 員工互補刀
// ------------------------------------------------------------
// 主員工答完後,用 Haiku 快速判斷該找哪 1-2 個其他員工補刀
// (DEX 補真數字 / CAMILLE 補文案 / 其他補專業面向)
// 每個補刀 80-150 字,SSE 事件 "partner_take" 推給前端
// ============================================================

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
let _anthropic = null;
try {
  if (ANTHROPIC_KEY) {
    const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
    _anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
  }
} catch (e) { console.error('[partner-take init]', e.message); }

const FAST_MODEL = 'claude-haiku-4-5-20251001';

const HELPER_CATALOG = {
  dex:     { who: 'DEX',     emoji: '📊', when: '主答案有數字主張但缺出處,或缺競品/基準比較' },
  camille: { who: 'CAMILLE', emoji: '✒️', when: '主答案提到要寫文案但沒給具體範例(IG / FB / EDM)' },
  aria:    { who: 'ARIA',    emoji: '🎨', when: '主答案提到視覺/品牌設計但沒給方向' },
  nova:    { who: 'NOVA',    emoji: '💫', when: '主答案提到社群經營但缺操作節奏' },
  milo:    { who: 'MILO',    emoji: '🤝', when: '主答案提到網紅合作但沒給選角或腳本' },
  leon:    { who: 'LEON',    emoji: '🎯', when: '主答案提到廣告但缺執行細節(預算/受眾/A/B)' },
};

async function decideHelpers(mainEmployeeId, userQ, mainAnswer) {
  if (!_anthropic) return [];
  const candidates = Object.entries(HELPER_CATALOG)
    .filter(([id]) => id !== (mainEmployeeId || '').toLowerCase())
    .map(([id, v]) => `- ${id} (${v.who}): ${v.when}`)
    .join('\n');

  const sys = `你是補刀分派員。讀完「主員工答案」後,從候選員工中挑 0-2 個最有加分價值的補刀,不要為補而補。
候選:
${candidates}

只回 JSON,不要 markdown,不要解釋。格式:
{"helpers":[{"id":"dex","why":"主答案說西門客單最高但沒附最近 30 天客單"}]}

若主答案已自足、或話題太閒聊,helpers 就回空陣列 []。寧可不補也不要硬補。`;

  try {
    const r = await _anthropic.messages.create({
      model: FAST_MODEL,
      max_tokens: 400,
      system: sys,
      messages: [{
        role: 'user',
        content: `使用者問:\n${(userQ || '').slice(0, 500)}\n\n主員工 (${mainEmployeeId}) 答:\n${(mainAnswer || '').slice(0, 1800)}`,
      }],
    });
    const txt = r.content.map(b => b.text || '').join('');
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return [];
    const obj = JSON.parse(m[0]);
    return Array.isArray(obj.helpers) ? obj.helpers.slice(0, 2) : [];
  } catch (e) {
    console.error('[partner-take decide]', e.message);
    return [];
  }
}

async function runHelper(emp, userQ, mainAnswer, why) {
  if (!_anthropic || !emp) return null;
  const sys = `你是 ${emp.name}(${emp.role})。
主員工已經回答了使用者,你的任務是「補刀」— 用 80-150 字補主員工答案沒覆蓋的、屬於你專業的那一面。

規則:
- 不要打招呼、不要重複主員工的話
- 不要長篇,目標 100 字上下
- 用繁體中文
- 如果主員工已自足,就回「(主員工已涵蓋,我無補充)」一句話就好
- 對外文案要溫暖得體;對內報告要直接帶數字
- 不要寫 HTML 標籤,純文字段落

被指派補的角度:${why || '從你的專業面向補刀'}`;

  try {
    const r = await _anthropic.messages.create({
      model: FAST_MODEL,
      max_tokens: 350,
      system: sys,
      messages: [{
        role: 'user',
        content: `使用者原問題:\n${(userQ || '').slice(0, 400)}\n\n主員工答案:\n${(mainAnswer || '').slice(0, 1800)}\n\n請給 80-150 字補刀。`,
      }],
    });
    return r.content.map(b => b.text || '').join('').trim();
  } catch (e) {
    console.error('[partner-take run]', emp.name, e.message);
    return null;
  }
}

async function partnerTake({ EMPLOYEES, mainEmployeeId, userQuestion, mainAnswer, send }) {
  if (!_anthropic || !EMPLOYEES || !mainEmployeeId) return [];
  // 過短不補
  if (!mainAnswer || mainAnswer.length < 200) return [];

  const helpers = await decideHelpers(mainEmployeeId, userQuestion, mainAnswer);
  if (!helpers.length) return [];

  const takes = [];
  for (const h of helpers) {
    const id = (h.id || '').toLowerCase();
    const emp = EMPLOYEES[id];
    if (!emp) continue;
    const text = await runHelper(emp, userQuestion, mainAnswer, h.why);
    if (!text || /主員工已涵蓋/.test(text)) continue;
    const take = {
      employeeId: emp.id,
      name: emp.name,
      role: emp.role,
      emoji: emp.emoji,
      color: emp.color,
      text,
      why: h.why || '',
    };
    takes.push(take);
    if (typeof send === 'function') {
      try { send('partner_take', take); } catch (e) { /* ignore */ }
    }
  }
  return takes;
}

module.exports = { partnerTake };
