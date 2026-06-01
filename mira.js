// ============================================================
// mira.js — MIRA 門市教育主管
// 產出 6 種門市教材：話術庫 / 加購腳本 / 新人訓練 / 成交SOP / 神秘客檢核 / 每日一技
// 資料來源：品牌核心風格 + SaleSmartly 客戶常問 + 使用者上傳知識庫 + 網路教育內容(Google News RSS)
// 每天 08:30 自我優化：回顧對話+知識庫，更新教學重點 playbook (存 persistent disk)
// 掛載：app.use('/api/mira', require('./mira'));  cron：require('./mira').registerCron(cron)
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch {}
const sm = (() => { try { return require('./salesmartly'); } catch { return null; } })();
const _scout = (() => { try { return require('./scout'); } catch { return null; } })();
function scoutTail() {
  try {
    const i = _scout && _scout.getMarketIntelligence && _scout.getMarketIntelligence();
    if (!i) return '';
    const wf = typeof i.weekly_focus === 'string' ? i.weekly_focus : JSON.stringify(i.weekly_focus || '');
    const acts = (i.action_items || []).slice(0, 5).map((a, n) => (n + 1) + '. ' + (a.title || a)).join('\n');
    return '\n\n=== SCOUT 全球市場調查 + 行動建議 (所有內容請優先參考這裡的市場洞察) ===\n本週重點：' + String(wf).slice(0, 320) + '\n行動建議：\n' + acts + '\n=== SCOUT 結束 ===';
  } catch { return ''; }
}


const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const KB_FILE = path.join(DATA_DIR, 'mira-kb.json');
const PLAYBOOK_FILE = path.join(DATA_DIR, 'mira-playbook.json');
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

let client = null;
function getClient() {
  if (client) return client;
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try { client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); } catch { client = null; }
  return client;
}
function ensureDir() { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }
function loadJSON(file, fb) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; } }
function saveJSON(file, o) { ensureDir(); try { fs.writeFileSync(file, JSON.stringify(o, null, 2)); return true; } catch { return false; } }

// ── 知識庫 (使用者上傳的 SOP / 教材 / 品牌規範) ──
function loadKB() { return loadJSON(KB_FILE, { docs: [] }); }
function addKB(title, text, source) {
  const kb = loadKB();
  const doc = { id: 'kb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), title: (title || '未命名').slice(0, 120), text: String(text || '').slice(0, 20000), source: source || 'upload', added_at: new Date().toISOString() };
  kb.docs.unshift(doc);
  if (kb.docs.length > 100) kb.docs = kb.docs.slice(0, 100);
  saveJSON(KB_FILE, kb);
  return doc;
}
function kbContextText(maxChars = 5000) {
  const kb = loadKB();
  if (!kb.docs.length) return '(使用者尚未上傳任何門市知識庫/SOP)';
  let out = '';
  for (const d of kb.docs) {
    const chunk = '【' + d.title + '】\n' + d.text + '\n\n';
    if (out.length + chunk.length > maxChars) break;
    out += chunk;
  }
  return out;
}

// ── 門市教學 playbook (每日優化累積) ──
function getPlaybook() {
  return loadJSON(PLAYBOOK_FILE, {
    focus_this_period: '(尚未優化。預設：韓系精品服務、不叫賣、雙主力組合推薦、送禮場景引導。)',
    top_customer_questions: [],
    staff_emphasis: [],
    learned_at: null,
  });
}

// ── 網路教育內容 (Google News RSS，免 API key，當輔助) ──
async function webEducationSnippets() {
  const queries = ['零售 門市 銷售技巧', '精品 服務 教育訓練', '門市 加購 話術'];
  const out = [];
  for (const q of queries) {
    try {
      const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=zh-TW&gl=TW&ceid=TW:zh-Hant';
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const xml = await r.text();
      const titles = [...xml.matchAll(/<title>(.*?)<\/title>/g)].map(m => m[1].replace(/<!\[CDATA\[|\]\]>/g, '')).slice(1, 4);
      titles.forEach(t => out.push('· ' + t));
    } catch {}
  }
  return out.length ? out.slice(0, 9).join('\n') : '(無網路結果，改用 Claude 知識 + 你的資料)';
}

// ── 內容類型定義 ──
const TYPES = {
  greeting: { label: '門市話術庫', ask: '產出分情境的門市店員話術：①迎賓開場 ②商品介紹(馬卡龍/費南雪雙主力) ③推薦組合 ④破解疑慮(嫌貴/送禮不知怎麼選/比較) ⑤臨門收單。每段給「情境→話術→為什麼」。' },
  upsell: { label: '加購腳本', ask: '產出門市加購腳本：列出 5-6 個加購時機(例:客人買 6 入時、挑禮盒時、提到送禮時)，每個給觸發訊號 + 自然不壓迫的加購話術 + 預期效果。涵蓋雙享禮盒、禮盒升級、季節限定搭配、企業/婚禮大單引導。' },
  training: { label: '新人教育訓練', ask: '產出新進店員上手教材：①產品知識(口味/保存期限/過敏原) ②品牌故事(韓系精品、台南起家、雙主力) ③門市 SOP 重點 ④常見客訴與處理。寫成可直接給新人讀的教材。' },
  sop: { label: '成交流程 SOP', ask: '產出門市成交流程 SOP：從客人進店到結帳離店的標準步驟，每步給(做什麼 + 該說的話術 + 要觀察的購買訊號 + 該避免的雷)。讓「會不會賣」變成可複製的流程。' },
  mystery: { label: '神秘客檢核表', ask: '產出神秘客檢核表(評分表)：分迎賓/專業度/商品推薦/加購/結帳體驗/環境 等面向，每項給評分標準(1-5分)與觀察重點，最後附「常見扣分點 + 改善建議」。註明:實際探訪需真人執行。' },
  daily: { label: '門市每日一技', ask: '產出 5 則「門市每日一技」(每天推一則給店員的小教材)：每則一個具體可立刻用的話術或加購技巧，30 秒讀完，附一句為什麼有效。' },
};
const STORES = ['台南本店', '新光西門 B2', '新光中港 B2', '新光南西 B2', '全門店'];

function miraPrompt(playbook) {
  return `你是 MIRA — 溫點 WarmPlace 的 AI 門市教育主管 (Retail Training Lead)。
你不是「教材小編」，你是帶過精品門市團隊、把「會不會賣」變成可複製系統的店長教練。
品牌：精品馬卡龍 + 費南雪韓系禮贈。禮盒 NT$480–2,280，主力 6 入 NT$880 / 12 入 NT$1,580。
四家門店：台南本店、新光西門 B2、新光中港 B2、新光南西 B2。百貨櫃點體驗 > 線上流量。

【品牌核心風格 (店員話術都要符合)】
韓系精品、溫柔得體、片刻儀式感。給選擇不壓迫。
禁用詞：超讚 / 必吃 / CP值 / 限時搶購 / 秒殺 / 親民。
偏好：細緻、致意、為一個人的偏愛、送禮的心意。

【你學到的本期教學重點 (每日優化累積，請優先納入)】
${JSON.stringify(playbook, null, 1).slice(0, 2000)}

【產出原則】
1. 全部要「可立刻拿給店員用」— 具體話術、具體步驟，不要空泛理論。
2. 話術要短、口語、有溫度，符合韓系精品語氣。
3. 緊扣雙主力(馬卡龍+費南雪)與送禮場景(婚禮喜餅/企業/犒賞自己)。
4. 參考客戶真實常問的問題 → 教店員怎麼答。
用繁體中文，HTML 片段輸出(<h4>/<p>/<ul>/<ol>/<table class="data">/<blockquote>)。`;
}

// ── 產出教材 ──
async function generate({ type = 'greeting', store = '全門店', brief = '' } = {}) {
  const c = getClient();
  if (!c) throw new Error('ANTHROPIC_API_KEY 未設');
  const t = TYPES[type] || TYPES.greeting;
  const playbook = getPlaybook();
  // 客戶常問
  let custQ = '';
  try { if (sm && sm.getCustomerInsights) { const r = await sm.getCustomerInsights({ days: 30 }); if (r && r.topics) custQ = r.topics.slice(0, 8).map(x => x.topic + '(' + x.count + '次)').join('、'); } } catch {}
  const web = await webEducationSnippets();
  const kb = kbContextText();
  const user = '請為【' + store + '】產出「' + t.label + '」。\n\n' + t.ask
    + (brief ? '\n\n額外要求：' + brief.slice(0, 400) : '')
    + '\n\n=== 客戶最常問的問題 (轉成店員該怎麼答) ===\n' + (custQ || '(無資料)')
    + '\n\n=== 使用者上傳的門市知識庫 / SOP (請優先遵循這裡的規範) ===\n' + kb
    + '\n\n=== 網路教育內容參考 (輔助) ===\n' + web + scoutTail();
  const r = await c.messages.create({ model: MODEL, max_tokens: 3500, system: miraPrompt(playbook), messages: [{ role: 'user', content: user }] });
  const html = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  try { const H = require('./history'); H.record({ fn:'MIRA', title: (t&&t.label?t.label:'門市教材') + (store?' · '+store:''), html, text: html.replace(/<[^>]+>/g,' ').slice(0,2000), meta:{ type, store } }); } catch(e) { console.error('[history mira]', e.message); }
  return { ok: true, type, type_label: t.label, store, html, used_kb_docs: loadKB().docs.length };
}

// ── 每日自我優化 ──
async function selfOptimize() {
  const c = getClient();
  if (!c) return { ok: false, error: 'no api key' };
  let custQ = [];
  try { if (sm && sm.getCustomerInsights) { const r = await sm.getCustomerInsights({ days: 7 }); if (r && r.topics) custQ = r.topics.slice(0, 10).map(x => ({ topic: x.topic, count: x.count })); } } catch {}
  const kb = kbContextText(3000);
  const prompt = '你是 MIRA 的自我優化引擎。根據以下「近 7 天客戶常問」+「門市知識庫」，更新本期門市教學重點。只回 JSON：\n'
    + '{\n  "focus_this_period": "本期門市最該加強的服務/銷售重點(2-3句，具體)",\n'
    + '  "staff_emphasis": ["店員本期要特別注意的 4-6 點(話術/加購/客訴)"]\n}\n\n'
    + '=== 客戶常問(近7天) ===\n' + JSON.stringify(custQ)
    + '\n\n=== 門市知識庫 ===\n' + kb;
  const r = await c.messages.create({ model: MODEL, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] });
  let text = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { focus_this_period: text.slice(0, 800), staff_emphasis: [] }; }
  parsed.top_customer_questions = custQ;
  parsed.learned_at = new Date().toISOString();
  saveJSON(PLAYBOOK_FILE, parsed);
  return { ok: true, learned_at: parsed.learned_at, questions: custQ.length };
}

// ───────────────────────── Routes ─────────────────────────
router.get('/types', (req, res) => res.json({ ok: true, types: Object.entries(TYPES).map(([k, v]) => ({ key: k, label: v.label })), stores: STORES }));

router.post('/generate', express.json({ limit: '256kb' }), async (req, res) => {
  try { res.json(await generate(req.body || {})); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 知識庫
router.get('/kb', (req, res) => { const kb = loadKB(); res.json({ ok: true, count: kb.docs.length, docs: kb.docs.map(d => ({ id: d.id, title: d.title, source: d.source, added_at: d.added_at, chars: (d.text || '').length })) }); });
router.post('/kb', express.json({ limit: '2mb' }), (req, res) => {
  const { title, text } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ ok: false, error: 'text 必填' });
  const doc = addKB(title, text, 'upload');
  res.json({ ok: true, doc: { id: doc.id, title: doc.title, chars: doc.text.length } });
});
router.delete('/kb/:id', (req, res) => {
  const kb = loadKB(); const before = kb.docs.length;
  kb.docs = kb.docs.filter(d => d.id !== req.params.id);
  saveJSON(KB_FILE, kb);
  res.json({ ok: true, removed: before - kb.docs.length });
});

router.get('/playbook', (req, res) => res.json({ ok: true, ...getPlaybook() }));
router.post('/optimize', async (req, res) => { try { res.json(await selfOptimize()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });

function registerCron(cron) {
  if (!cron || typeof cron.schedule !== 'function') return;
  const tz = process.env.TZ || 'Asia/Taipei';
  cron.schedule('30 8 * * *', async () => {
    console.log('[mira] 08:30 self-optimize starting...');
    try { const r = await selfOptimize(); console.log('[mira] self-optimize:', JSON.stringify(r)); }
    catch (e) { console.error('[mira] self-optimize failed:', e.message); }
  }, { timezone: tz });
  console.log('[mira] MIRA cron registered (daily 08:30 self-optimize)');
}

module.exports = router;
module.exports.registerCron = registerCron;
module.exports.selfOptimize = selfOptimize;
