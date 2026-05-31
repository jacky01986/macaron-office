// ============================================================
// sola.js — SOLA 官網營運 (E-commerce Ops) v1
// 產電商內容：商品頁 / 活動頁 / 轉換優化 / 商品頁SEO / 官網更新文案
// 平台：SHOPLINE — v1 產文案，你複製貼到後台 (v2 再接 API 自動推)
// 全部讀 SCOUT 全球市場調查 + 行動建議 + 品牌核心風格
// 掛載：app.use('/api/sola', require('./sola'));
// ============================================================
const express = require('express');
const router = express.Router();

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch {}
const _scout = (() => { try { return require('./scout'); } catch { return null; } })();
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

let client = null;
function getClient() {
  if (client) return client;
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try { client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); } catch { client = null; }
  return client;
}

function scoutTail() {
  try {
    const i = _scout && _scout.getMarketIntelligence && _scout.getMarketIntelligence();
    if (!i) return { text: '(尚無 SCOUT 情報)', has: false, run: null };
    const wf = typeof i.weekly_focus === 'string' ? i.weekly_focus : JSON.stringify(i.weekly_focus || '');
    const acts = (i.action_items || []).slice(0, 5).map((a, n) => (n + 1) + '. ' + (a.title || a)).join('\n');
    const price = (i.pricing_recommendations || []).slice(0, 4).map(p => '· ' + (typeof p === 'string' ? p : (p.recommendation || p.note || JSON.stringify(p)))).join('\n');
    return { text: '本週重點：' + String(wf).slice(0, 320) + '\n行動建議：\n' + acts + (price ? '\n定價建議：\n' + price : ''), has: true, run: i.based_on_scout_run || i.distilled_at || null };
  } catch { return { text: '(讀取失敗)', has: false, run: null }; }
}

const TYPES = {
  product: { label: '商品頁文案', needProduct: true, ask: '產出一個「轉換導向」的商品頁文案：①吸睛標題 ②3-5 個賣點(感官+情境+信任) ③口味/規格描述 ④適合誰送/什麼場景 ⑤保存與配送資訊重點 ⑥強而不壓迫的 CTA。讓看的人想下單，不只是好看。' },
  landing: { label: '活動頁 / Landing', needProduct: false, ask: '產出一個檔期活動 Landing Page 的架構+文案：Hero 標語 → 痛點/情境 → 方案(主打商品) → 社會證明/信任 → 限定理由 → CTA。每段給標題+內文。配合 SCOUT 本週重點選主打。' },
  conversion: { label: '轉換流程優化建議', needProduct: false, ask: '當電商轉換顧問：列出官網購買流程(進站→商品頁→加入購物車→結帳)各環節常見的卡關點，並給溫點該怎麼優化(CTA 寫法、信任元素、FAQ 要回什麼、運費/取貨資訊怎麼擺、棄單挽回)，每點要具體可執行。' },
  seo: { label: '商品頁 SEO', needProduct: true, ask: '產出商品頁/活動頁的 SEO 包：①主關鍵字 1 + 長尾 3-5(含搜尋意圖) ②Meta Title(≤60字, 2版) ③Meta Description(≤155字, 2版) ④商品頁 H1/H2 建議 ⑤圖片 alt 建議。專注電商頁面，不做部落格。' },
  update: { label: '官網更新文案', needProduct: false, ask: '產出官網更新所需文案：新品上架公告、首頁 banner 標語(3版)、活動倒數文字、運送/取貨/退換貨說明的精煉版本。簡短、可直接貼上 SHOPLINE。' },
};

function solaPrompt(intelText) {
  return `你是 溫點 WarmPlace 的 AI 官網營運專員，代號 SOLA (E-commerce Ops)。
你不是文案小編，你是把「流量變成訂單」的電商轉換專家，懂商品頁心理學與 SEO。
品牌：精品馬卡龍 + 費南雪韓系禮贈。禮盒 NT$480–2,280，主力 6 入 NT$880 / 12 入 NT$1,580。官網平台：SHOPLINE。
四家門店：台南本店、新光西門/中港/南西 B2。

【品牌核心風格】韓系精品、溫柔得體、片刻儀式感、給選擇不壓迫。
禁用詞：超讚 / 必吃 / CP值 / 限時搶購 / 秒殺 / 親民。

【你給任何電商內容前，請優先參考 SCOUT 全球市場調查 + 行動建議】
${intelText}

【鐵則】
1. 所有文案以「轉換(下單)」為目標，不是只求好看 — 每段都要推進到下一步。
2. 緊扣雙主力(馬卡龍+費南雪)與送禮場景(婚禮喜餅/企業/犒賞自己)，呼應 SCOUT 本週重點。
3. SEO 專注電商頁面(商品頁/活動頁)，不重複 CAMILLE/GIA 的部落格。
4. 文案要能直接貼到 SHOPLINE，標清楚哪段放哪裡。
用繁體中文，HTML 片段輸出(<h4>/<p>/<ul>/<ol>/<table class="data">/<blockquote>)。`;
}

async function generate({ type = 'product', product = '', brief = '' } = {}) {
  const c = getClient();
  if (!c) throw new Error('ANTHROPIC_API_KEY 未設');
  const t = TYPES[type] || TYPES.product;
  const intel = scoutTail();
  const user = (t.needProduct ? '針對商品/禮盒：' + (product || '6 入馬卡龍禮盒 NT$880') + '\n\n' : '')
    + t.ask + (brief ? '\n\n額外要求：' + brief.slice(0, 400) : '');
  const r = await c.messages.create({ model: MODEL, max_tokens: 3200, system: solaPrompt(intel.text), messages: [{ role: 'user', content: user }] });
  const html = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { ok: true, type, type_label: t.label, product: t.needProduct ? (product || '6 入馬卡龍禮盒') : null, html, based_on_scout: intel.has, scout_run: intel.run };
}

router.get('/types', (req, res) => res.json({ ok: true, types: Object.entries(TYPES).map(([k, v]) => ({ key: k, label: v.label, needProduct: !!v.needProduct })) }));
router.post('/generate', express.json({ limit: '256kb' }), async (req, res) => {
  try { res.json(await generate(req.body || {})); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
