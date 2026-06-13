// ============================================================
// reels.js — RINA 短影音導演
// 吃 SCOUT 全球市場情報 → 產出「可立刻拍」的 Reels 行動建議
// 掛載方式 (server.js 加一行)：app.use('/api/reels', require('./reels'));
// ============================================================
const express = require('express');
const router = express.Router();

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch {}
const scout = (() => { try { return require('./scout'); } catch { return null; } })();

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';

let client = null;
function getClient() {
  if (client) return client;
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try { client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); }
  catch { client = null; }
  return client;
}

// ───────────────────────── RINA 人設 ─────────────────────────
const RINA_PROMPT = `你是 RINA — 溫點 WarmPlace 的 AI 短影音導演 (Reels Director)。
你不是「腳本小編」，你是操過數十支破百萬觀看精品甜點 Reels 的短影音導演。
品牌：溫點 WarmPlace，台灣精品馬卡龍 + 費南雪韓系禮贈品牌。
品牌色：深酒紅 #6D2E46、玫瑰金 #B08D57、象牙白 #FCF6F5。
四家門店：台南本店、新光西門 B2、新光中港 B2、新光南西 B2。

【你的鐵則】
1. Reels 的前 3 秒決定 90% 觀看率 — 開場必須是「畫面/動作/聲音」的鉤子，不是 logo、不是品牌名。
2. 一支 Reels 只講一個重點，15–30 秒，節奏要卡在音樂的節拍上。
3. 你拍的是「片刻儀式感」，不是叫賣。禁用：超讚 / 必吃 / CP值 / 限時搶購 / 秒殺。
4. 每支企劃都必須能對應到 SCOUT 的某個趨勢或內容角度 — 你是「市場調查後的行動建議」，不是憑空發想。

【每支 Reels 企劃的輸出格式 (HTML 片段，每支用 <h4> 編號開頭)】
<h4>🎬 Reels N：[一句話主題]</h4>
<p><strong>📊 對應趨勢：</strong>[引用 SCOUT 的哪個趨勢/角度，說明為什麼這支會紅]</p>
<p><strong>🪝 開場 3 秒鉤子：</strong>[具體畫面 + 字卡/旁白]</p>
<p><strong>🎞 分鏡腳本：</strong></p>
<ol>
<li>[0–3s] 畫面：... ｜字卡：... </li>
<li>[3–8s] 畫面：... ｜字卡：... </li>
<li>[8–15s] 畫面：... ｜字卡：... </li>
<li>[15–22s] 畫面：... ｜字卡：... </li>
</ol>
<p><strong>📷 拍攝企劃：</strong>場景 / 道具 / 光線 / 鏡位（具體可執行，例：俯拍 45 度、左上自然光、深酒紅絲絨墊布）</p>
<p><strong>🎵 節奏與配樂：</strong>BGM 方向（韓系 lo-fi / 輕快 city-pop…）+ 剪輯節奏（幾個切點、卡在哪個拍點）</p>
<p><strong>📣 CTA：</strong>[結尾引導，留白不轟炸]</p>

【禁止】
- 開場放 logo 或品牌名
- 「介紹我們的產品」這種空話
- 沒有秒數的分鏡
- 抄 SCOUT 原文不轉化成可拍的分鏡
用繁體中文。`;

// SCOUT 情報摘要（餵給 RINA）
function buildIntelText() {
  let intel = null;
  try { if (scout && scout.getMarketIntelligence) intel = scout.getMarketIntelligence(); } catch {}
  if (!intel) return { text: '(目前還沒有 SCOUT 市場情報，請先到「市場情報」跑一次 SCOUT + DISTILL)', has: false, run: null };
  const obj = {
    weekly_focus: intel.weekly_focus,
    trending_topics: intel.trending_topics,
    content_angles: intel.content_angles,
    new_techniques: intel.new_techniques,
  };
  return { text: JSON.stringify(obj).slice(0, 5000), has: true, run: intel.based_on_scout_run || intel.distilled_at || null };
}

// GET /api/reels/intel — 看目前可用的 SCOUT 情報（給前端顯示「依據」）
router.get('/intel', (req, res) => {
  const r = buildIntelText();
  res.json({ ok: true, has_intel: r.has, scout_run: r.run });
});

// POST /api/reels/generate { count?, brief? } — 產出 N 支 Reels 行動建議
router.post('/generate', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const c = getClient();
    if (!c) return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY 未設，RINA 不在線' });
    const count = Math.min(Math.max(Number((req.body && req.body.count) || 3), 1), 5);
    const userBrief = ((req.body && req.body.brief) || '').toString().slice(0, 600);
    const intel = buildIntelText();
    const user = '請根據以下「SCOUT 全球市場調查情報」，產出 ' + count + ' 支立刻可拍的 Reels 短影音企劃。'
      + '這是經過全球競品/趨勢調查後的「行動建議」，每一支都要明確對應上面情報的某個趨勢或角度。'
      + (userBrief ? '\n\n額外要求：' + userBrief : '')
      + '\n\n=== SCOUT 全球市場情報 ===\n' + intel.text
      + '\n\n嚴格依照你系統設定的輸出格式（每支含主題 / 對應趨勢 / 3秒鉤子 / 分鏡腳本含秒數 / 拍攝企劃 / 節奏配樂 / CTA）。';
    const r = await c.messages.create({
      model: MODEL,
      max_tokens: 3500,
      system: RINA_PROMPT,
      messages: [{ role: 'user', content: user }],
    });
    const html = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    try { const H = require('./history'); H.record({ fn:'RINA', title: 'Reels 企劃 · '+count+' 支' + (userBrief?' · '+userBrief.slice(0,40):''), html, text: html.replace(/<[^>]+>/g,' ').slice(0,2000), meta:{ count, scout_run: intel.run } }); } catch(e) { console.error('[history reels]', e.message); }
    res.json({ ok: true, html, count, based_on_scout: intel.has, scout_run: intel.run });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
