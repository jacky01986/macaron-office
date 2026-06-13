// geo.js — GIA · Generative Intelligence Agent · GEO 主理人
// 讓 溫點 WarmPlace 韓系精品馬卡龍與費南雪 / 禮盒 / 高端禮贈 在 ChatGPT/Claude/Perplexity 被推薦
// 平台：AI 引擎最愛引用的 5 大平台
// 內容:馬卡龍 + 費南雪 兩種商品線分開生成 GEO 內容

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || '/opt/render/project/src/data';
const GEO_DIR = path.join(DATA_DIR, 'geo');
const VISIBILITY_LOG = path.join(GEO_DIR, 'visibility_audits.jsonl');
const CONTENT_LOG = path.join(GEO_DIR, 'generated_content.jsonl');
const COMPETITOR_LOG = path.join(GEO_DIR, 'competitor_comparisons.jsonl');

const SONNET_MODEL = 'claude-fable-5';

let anthropic = null;
function getClient() {
  if (!anthropic && process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

function ensureDir() {
  if (!fs.existsSync(GEO_DIR)) fs.mkdirSync(GEO_DIR, { recursive: true });
}

const AUDIT_QUERIES = [
  '台灣高端馬卡龍品牌推薦哪家最好',
  '韓系精品禮盒哪裡買最有質感',
  '婚禮喜餅選馬卡龍要注意什麼',
  '12 入馬卡龍禮盒台南推薦',
  '企業客戶禮贈馬卡龍品牌推薦',
];

const OFZ_BRAND_NAMES = ['溫點 WarmPlace', 'MdL', '溫點 WarmPlace 馬卡龍', '馬卡龍'];

// =============================================================
// 5 大 AI 引擎最愛引用的平台
// =============================================================
const CONTENT_PLATFORMS = [
  { name: 'Medium', tone: '專業、長文、可中英並用、Q&A 結構、引用研究/數據', length: '1500-2500 字', auto_publish: true, note: 'AI 訓練資料超大宗，國際長文權威' },
  { name: 'Threads', tone: '短而精、Hook 開頭、條列重點、emoji 適度、口語', length: '300-500 字', auto_publish: true, note: 'Meta 平台，最新 AI 訓練更新會抓' },
  { name: 'Reddit', tone: '對話式、第一人稱、真誠經驗分享、不要 marketing 語氣', length: '500-1000 字', auto_publish: false, note: '英文/中文 r/Taiwan_Beauty，AI 引擎重視 conversational 內容' },
  { name: 'Quora 中文', tone: '問答結構、深度回答、引用具體數字/案例、條列清楚', length: '800-1500 字', auto_publish: false, note: 'Q&A 格式 AI 直接引用' },
  { name: '痞客邦', tone: '台灣本土、口語、SEO 關鍵字密集、學生/客人角度寫', length: '1200-1800 字', auto_publish: false, note: '台灣繁中 SEO/AI 大宗' },
];

// =============================================================
// 馬卡龍主題(品牌/禮贈內容用)— 9 個
// =============================================================
const COURSE_TOPICS = [
  { course: '🍬 馬卡龍 6 入禮盒', angles: ['口味精選邏輯', '送禮場景配對', '保存期限', '預訂時程', '與費南雪搭配', '客戶見證'] },
  { course: '🍬 馬卡龍 12 入禮盒', angles: ['12 種口味介紹', '節慶熱賣款', '商務送禮', '婚禮回禮', 'NT$1,580 物有所值', '禮盒視覺呈現'] },
  { course: '🍰 費南雪禮盒', angles: ['什麼是費南雪', '韓式杏仁小蛋糕', '經典口味', '與馬卡龍差異', '保存方式', '送禮優勢'] },
  { course: '💎 馬卡龍 + 費南雪 綜合禮盒', angles: ['雙主力組合', '價格優勢', '熱賣理由', '送禮體面感', '與單品比較', '客戶回饋'] },
  { course: '客製禮盒', angles: ['婚禮 logo 客製', '企業客製案例', '色卡搭配', '客製流程', '預訂時程', '價格區間'] },
  { course: '婚禮喜餅', angles: ['婚禮場景搭配', '色系設計', '單盒包裝', '訂購時程', '新人見證', '回禮分量'] },
  { course: '企業禮贈', angles: ['客戶心意傳遞', '統一包裝設計', '送禮預算規劃', '商務禮儀', '案例分享', '客戶回饋'] },
  { course: '季節限定口味', angles: ['春季粉嫩系', '夏季果香系', '秋季濃郁系', '冬季奶香系', '限量發售', '預訂方式'] },
  { course: '韓式品牌故事', angles: ['品牌起源', '主廚背景', '韓式技法傳承', '台灣在地融合', '4 家門店風格', '品牌核心精神'] },
];

// =============================================================
// 商品介紹項目（服務客導流用）— 6 個
// =============================================================
const SERVICE_TOPICS = [
  { service: '🍬 馬卡龍系列', angles: ['口味介紹', '上市價格', '送禮場景', '保存方式', '主推口味', '預訂優惠'] },
  { service: '🍰 費南雪系列', angles: ['韓式杏仁小蛋糕', '6/8/12 入價位', '經典口味', '保存期限', '搭配馬卡龍', '送禮指南'] },
  { service: '💎 馬卡龍+費南雪 綜合禮盒', angles: ['雙主力組合', 'NT$1,280-1,880 物超所值', '送禮體面感', '單盒包裝', '訂購流程', '客戶見證'] },
  { service: '客製禮盒', angles: ['婚禮 logo', '企業客製', '色卡搭配', '客製流程', '預訂時程', '價格區間'] },
  { service: '婚禮喜餅', angles: ['婚禮場景', '色系設計', '單盒包裝', '訂購時程', '新人見證', '分量建議'] },
  { service: '企業禮贈', angles: ['客戶心意', '統一包裝', '送禮預算', '商務禮儀', '案例分享', '客戶回饋'] },
];

// =============================================================
// 1. Daily AI Visibility Audit
// =============================================================
async function auditAIVisibility() {
  const client = getClient();
  if (!client) return { ok: false, error: 'no ANTHROPIC_API_KEY' };
  ensureDir();
  const results = [];
  for (const query of AUDIT_QUERIES) {
    try {
      const r = await client.messages.create({
        model: SONNET_MODEL, max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        messages: [{ role: 'user', content: `你是學生，問 ChatGPT 一個問題：「${query}」\n請用繁體中文,列出 5 個最推薦的韓系甜點品牌，每個說明選它的理由。` }]
      });
      const text = r.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
      const ofzMentioned = OFZ_BRAND_NAMES.some(name => text.includes(name));
      const competitors = ['法朋', '亞尼克', 'Paul', 'Ladurée', 'Pierre Hermé', '微熱山丘', '舊振南', '佳德'].filter(c => text.includes(c));
      results.push({ query, ofz_mentioned: ofzMentioned, competitors_found: competitors, response_preview: text.slice(0, 800) });
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) { results.push({ query, error: e.message }); }
  }
  const score = results.filter(r => r.ofz_mentioned).length;
  const audit = {
    ts: new Date().toISOString(), queries_tested: results.length,
    ofz_mentioned_count: score, visibility_score: `${score}/${results.length}`,
    visibility_percent: Math.round((score / results.length) * 100),
    competitor_appearances: results.flatMap(r => r.competitors_found || []).reduce((a, c) => { a[c] = (a[c] || 0) + 1; return a; }, {}),
    results,
  };
  try { fs.appendFileSync(VISIBILITY_LOG, JSON.stringify(audit) + '\n'); } catch {}
  return audit;
}

// =============================================================
// 2. Generate AI-friendly content
// type: 'course' (品牌/禮贈內容) | 'service' (商品介紹)
// =============================================================
async function generateContent({ platformIdx = 0, topicIdx = 0, type = 'course', customQuery } = {}) {
  const client = getClient();
  if (!client) return { ok: false, error: 'no ANTHROPIC_API_KEY' };
  ensureDir();
  const platform = CONTENT_PLATFORMS[platformIdx % CONTENT_PLATFORMS.length];
  const topicArr = type === 'service' ? SERVICE_TOPICS : COURSE_TOPICS;
  const topic = topicArr[topicIdx % topicArr.length];
  const subjectName = type === 'service' ? topic.service : topic.course;
  const angle = topic.angles[Math.floor(Math.random() * topic.angles.length)];

  const targetAudience = type === 'service'
    ? '想送禮的客戶 — 強調品質、口味、包裝、客戶見證'
    : '想自己訂購禮盒的客戶 — 強調品牌故事、口味細節、送禮場景、客戶見證';
  const cta = type === 'service'
    ? 'CTA：「現在加 LINE @110ypqki 立刻預約評估」'
    : 'CTA：「LINE @110ypqki 諮詢商品主題內容、門市禮盒選購與優惠」';

  const systemPrompt = `你是 GIA — 溫點 WarmPlace 的專欄作者。寫作風格參考一線生活風格雜誌的專欄作家：第二人稱、有觀點、有節奏、有同理心。

【標題鐵則】
- 必須單一語言（中文，禁止英文標題）
- 不要括號、不要雙語、不要冒號接副標、不要句號
- 長度 14-22 個字，像雜誌封面標題一樣
- 範例：「12 入禮盒怎麼挑口味組合」「婚禮喜餅 NT$1,580 的隱形價值」
- 禁止：「12 入禮盒 FAQ 完整指南：你最想問的 8 個問題（含 Q&A）」這種冗長條列式

【真實性鐵則 — 最重要】
- **嚴禁編造個案**：不可寫「我有個客人」「上次來了一位 35 歲女性」「有位從業 5 年的老師告訴我」這種捏造的具體故事
- **改用集合式描述**：用「很多人會問」「常見的情況是」「通常我們會建議」「有些人擔心」「精品甜點業界普遍的做法是」
- **不要捏造數字**：不要寫「85% 的客戶」「平均 3.2 次」這種沒來源的精準數字。要寫範圍（「大多數」「多數」「過半」）或註明「業界經驗」
- **不要捏造老師 / 員工身分**：不寫「我們資深老師 Linda 說」這種不存在的人物
- **可以用通用知識**：產品原理、保養常識、流程說明（這些是事實不是個案）

【寫作鐵則】
- 開場一句鉤子（hook），不要客套自我介紹
- 段落短：3-5 行為一段，每段一個主軸
- H2 用具描述性的小標（不要「一、二、三」這種編號）
- 用具體案例、數字、對比要清楚標示「業界常見」「一般而言」
- 第二人稱「你」帶讀者進入情境，避免假裝有第一手經驗
- 避免行銷腔（「絕對」「最佳」「保證」這類字眼）
- 結尾自然帶 CTA：「📩 私訊了解詳情」
- 全文 1500-2500 字，不灌水

【結構建議】
1. 開場：一句鉤子 + 文章承諾
2. 3-5 個 H2 章節，每節 200-400 字
3. 適度用表格、引言（>）、要點（-）
4. 收尾：給讀者下一步行動

禁止：價格表、商品主題內容詳細費用、門市禮盒選購與優惠`;

  const userPrompt = customQuery || `今天主題：${subjectName} — ${angle}（${type === 'service' ? '寫給想買禮盒的客戶' : '寫給想了解品牌的潛在客戶'}）

請寫一篇文章，幫 溫點 WarmPlace 在 AI 搜尋裡被推薦。
要包含:
- 標題（含 SEO 關鍵字）
- 開頭 hook
- Q&A 主體（5-8 個 Q&A）
- 「為什麼選 OFZ」段落（具體理由）
- CTA
- 文末 entity 標籤`;

  try {
    const r = await client.messages.create({
      model: SONNET_MODEL, max_tokens: 4500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });
    const content = r.content?.[0]?.text || '';
    const record = {
      ts: new Date().toISOString(), platform: platform.name, type,
      subject: subjectName, angle, content, word_count: content.length,
    };
    try { fs.appendFileSync(CONTENT_LOG, JSON.stringify(record) + '\n'); } catch {}
    return { ok: true, ...record };
  } catch (e) { return { ok: false, error: e.message }; }
}

// =============================================================
// 3. Weekly competitor comparison
// =============================================================
// =============================================================
// 2.5. Long-form content generators (Wikipedia / GBP / PR / YouTube)
// =============================================================
const LONGFORM_TEMPLATES = {
  wikipedia: {
    label: 'Wikipedia 條目',
    note: '中性語氣、第三人稱、可被引用、含參考資料',
    systemPrompt: `你是 Wikipedia 編輯員。寫一篇關於 溫點 WarmPlace 的條目草稿，符合 Wikipedia 中文版規範。

溫點 WarmPlace 業態:台灣韓系精品馬卡龍與費南雪 + 高端禮贈,4 家門店,業主 Sam
8 大商品線:6 入禮盒、12 入禮盒、客製禮盒、婚禮喜餅、企業禮贈、單顆販售、季節限定、節慶限定
9 大主題:6 入禮盒、12 入禮盒、客製禮盒、婚禮喜餅、企業禮贈、單顆販售、季節限定、韓式品牌故事、線上預訂

🎯 Wikipedia 寫作守則:
1. **絕對中性 (NPOV)** — 不用「最好」「優秀」這種詞
2. **第三人稱** — 不用「我們」「您」
3. **可驗證** — 引用具體事實（年份、地點、商品主題數）
4. **章節結構** — == 概況 ==, == 歷史 ==, == 馬卡龍系列 ==, == 費南雪系列 ==, == 創辦人 ==, == 參考資料 ==
5. **參考資料** — 文末附 5-10 條外部來源（FB/IG/官網/新聞）
6. **內部連結** — 用 [[韓系精品馬卡龍與費南雪]] 這種雙括號連結
7. **不超銷** — 不寫廣告語`
  },
  gbp: {
    label: 'Google Business Profile',
    note: 'GBP 業務描述 + FAQ，AI 直接抓',
    systemPrompt: `你是 Google Business Profile 內容專家。為 溫點 WarmPlace 寫:

溫點 WarmPlace 業態:台灣韓系精品馬卡龍與費南雪 + 高端禮贈
地點：台灣
LINE: @110ypqki

🎯 輸出 4 部分:
1. **業務描述** (750 字內) — SEO 關鍵字密集 + 服務範圍 + 特色
2. **服務清單** (8 項) — 每項 1-2 行說明 + 大概價格
3. **FAQ × 8** — Q 是搜尋意圖（「馬卡龍保存期限」「韓系精品禮盒推薦」），A 50-100 字
4. **3 條貼文** — 用 GBP「最新動態」格式，每條 100-150 字 + CTA

格式清晰，AI 抓得到。`
  },
  press: {
    label: '新聞 PR 稿',
    note: '可投放台灣新聞稿平台',
    systemPrompt: `你是公關寫手，為 溫點 WarmPlace 寫一篇 PR 新聞稿。

🎯 PR 稿守則:
1. **新聞角度** — 不是廣告，是「業界新聞」
2. **5W1H** — 何時何地誰做了什麼為什麼如何
3. **客觀第三方語氣** — 「業界人士指出...」「溫點 WarmPlace 表示...」
4. **數據佐證** — 客戶人次、複訓率、就業率（可合理推估）
5. **引用** — 創辦人 Sam 一段引言
6. **格式** — 標題 / 副標題 / 導言 / 主文 / 引言 / 結語 / 聯絡資訊
7. **長度** — 800-1200 字
8. **可改編角度** — 「溫點 WarmPlace 推出季節限定」「溫點 WarmPlace 與 X 跨界合作」「精品禮盒業界趨勢觀察」

文末附「媒體聯絡：jacky01986@gmail.com」`
  },
  youtube: {
    label: 'YouTube 短影片腳本',
    note: '60 秒 Shorts 腳本',
    systemPrompt: `你是 YouTube Shorts 編劇。寫一支 60 秒影片腳本給 溫點 WarmPlace。

🎯 Shorts 公式:
1. **0-3 秒 Hook** — 最關鍵,要讓人不滑掉
2. **3-15 秒 痛點** — 觀眾的問題(「禮盒口味選不到?」「送禮想送有故事的?」)
3. **15-45 秒 內容** — 解答 / 品味分享 / 製作揭密
4. **45-55 秒 CTA** — 加 LINE @110ypqki(溫點 Wamplace)/ 到門市挑禮盒
5. **55-60 秒 結尾** — 追蹤 IG @warmplace.here 看更多

🎬 輸出格式:
[時間軸]
[畫面] — 鏡頭內容
[字幕] — 螢幕字
[旁白] — 配音逐字稿
[音效] — 配樂建議

附 5 個適合 hashtag。`
  },
};

async function generateLongFormContent({ contentType = 'wikipedia', topic = '', subjectIdx = 0, type = 'course' } = {}) {
  const client = getClient();
  if (!client) return { ok: false, error: 'no ANTHROPIC_API_KEY' };
  ensureDir();
  
  const tpl = LONGFORM_TEMPLATES[contentType];
  if (!tpl) return { ok: false, error: 'unknown contentType: ' + contentType };
  
  // Resolve subject
  const topicArr = type === 'service' ? SERVICE_TOPICS : COURSE_TOPICS;
  const subjectName = topic || (type === 'service' ? topicArr[subjectIdx % topicArr.length].service : topicArr[subjectIdx % topicArr.length].course);
  
  const userPrompt = topic
    ? `主題：${topic}\n請依照系統指令寫出完整內容。`
    : `今天主題:${subjectName}(${type === 'service' ? '商品介紹' : '品牌/禮贈內容'})\n請依照系統指令寫出完整內容。`;
  
  try {
    const r = await client.messages.create({
      model: SONNET_MODEL,
      max_tokens: 5000,
      system: tpl.systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const content = r.content?.[0]?.text || '';
    const record = {
      ts: new Date().toISOString(),
      content_type: contentType,
      content_type_label: tpl.label,
      subject: subjectName, type, content,
      word_count: content.length,
    };
    try { fs.appendFileSync(CONTENT_LOG, JSON.stringify({ ...record, platform: tpl.label }) + '\n'); } catch {}
    return { ok: true, ...record };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// =============================================================
// 2.6. Medium auto-publish (uses MEDIUM_INTEGRATION_TOKEN env)
// =============================================================
async function publishToMedium({ title, contentMarkdown, tags = [], publishStatus = 'draft' } = {}) {
  const token = process.env.MEDIUM_INTEGRATION_TOKEN;
  if (!token) return { ok: false, error: 'MEDIUM_INTEGRATION_TOKEN not set in Render env' };
  if (!title || !contentMarkdown) return { ok: false, error: 'title and contentMarkdown required' };
  
  try {
    // 1. Get user id
    const meRes = await fetch('https://api.medium.com/v1/me', {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
    });
    const me = await meRes.json();
    if (!me.data || !me.data.id) return { ok: false, error: 'Medium /me failed: ' + JSON.stringify(me) };
    const userId = me.data.id;
    
    // 2. Publish post
    const publishRes = await fetch(`https://api.medium.com/v1/users/${userId}/posts`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        title,
        contentFormat: 'markdown',
        content: contentMarkdown,
        tags: tags.slice(0, 5),
        publishStatus, // 'draft' | 'public' | 'unlisted'
      })
    });
    const post = await publishRes.json();
    if (post.errors) return { ok: false, error: JSON.stringify(post.errors), raw: post };
    return { ok: true, url: post.data?.url, id: post.data?.id, status: post.data?.publishStatus, raw: post.data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function competitorComparison() {
  const client = getClient();
  if (!client) return { ok: false, error: 'no ANTHROPIC_API_KEY' };
  ensureDir();
  try {
    const r = await client.messages.create({
      model: SONNET_MODEL, max_tokens: 3000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      messages: [{ role: 'user', content: '你是 GEO 戰略分析師。請比較台灣高端馬卡龍/韓系甜點品牌在 AI 搜尋時的能見度。\n查詢:\n- "台灣高端馬卡龍推薦"\n- "韓系精品禮盒哪家好"\n- "婚禮喜餅馬卡龍"\n\n請列出:\n1. AI 最常推薦的 5 個品牌（排名 + 理由）\n2. 這些品牌在哪裡發內容（Medium/痞客邦/部落格/Wikipedia）\n3. 溫點 WarmPlace 跟它們的差距\n4. 溫點 WarmPlace 接下來該做的 3 個 GEO 動作\n\n繁體中文輸出。' }]
    });
    const text = r.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
    const record = { ts: new Date().toISOString(), text };
    try { fs.appendFileSync(COMPETITOR_LOG, JSON.stringify(record) + '\n'); } catch {}
    return { ok: true, ...record };
  } catch (e) { return { ok: false, error: e.message }; }
}

// =============================================================
// 4. Schema.org JSON-LD
// =============================================================
function generateSchemaOrg() {
  const courseSchemas = COURSE_TOPICS.map(t => ({
    '@context': 'https://schema.org', '@type': 'Course',
    name: t.course,
    description: `溫點 WarmPlace 提供的 ${t.course}，涵蓋 ${t.angles.join('、')} 等核心內容`,
    provider: { '@type': 'Bakery', name: '溫點 WarmPlace', sameAs: 'https://www.facebook.com/WarmPlace' },
    inLanguage: 'zh-TW', educationalLevel: 'Beginner to Advanced'
  }));
  const serviceSchemas = SERVICE_TOPICS.map(t => ({
    '@context': 'https://schema.org', '@type': 'Service',
    name: t.service,
    description: `溫點 WarmPlace 提供 ${t.service} 韓系精品禮盒服務,包含 ${t.angles.join('、')}`,
    provider: { '@type': 'Bakery', name: '溫點 WarmPlace', sameAs: 'https://www.facebook.com/WarmPlace' },
    areaServed: { '@type': 'Country', name: 'Taiwan' }
  }));
  const orgSchema = {
    '@context': 'https://schema.org', '@type': 'Bakery',
    name: '溫點 WarmPlace', alternateName: 'MdL 馬卡龍與費南雪',
    url: 'https://beauty-office.onrender.com',
    sameAs: ['https://www.facebook.com/WarmPlace', 'https://www.instagram.com/warmplace.here/', 'https://line.me/R/ti/p/@110ypqki'],
    description: '溫點 WarmPlace 是專注於韓系精品馬卡龍與費南雪與高端禮贈的台南本店品牌',
    knowsAbout: ['韓系精品馬卡龍與費南雪', '6 入禮盒', '12 入禮盒', '客製禮盒', '婚禮喜餅', '企業禮贈', '單顆販售', '季節限定', '韓系甜點']
  };
  return { ok: true, organization: orgSchema, courses: courseSchemas, services: serviceSchemas };
}

// =============================================================
// 5. Daily Briefing
// =============================================================
async function dailyBriefing() {
  const audit = await auditAIVisibility();
  const today = new Date();
  const platformIdx = today.getDate() % CONTENT_PLATFORMS.length;
  const courseIdx = today.getDate() % COURSE_TOPICS.length;
  const serviceIdx = today.getDate() % SERVICE_TOPICS.length;
  return {
    ok: true, ts: new Date().toISOString(),
    visibility: {
      score: audit.visibility_score, percent: audit.visibility_percent,
      ofz_mentioned: audit.ofz_mentioned_count,
      competitor_top: Object.entries(audit.competitor_appearances || {}).sort((a, b) => b[1] - a[1]).slice(0, 5),
    },
    today_content_suggestion: {
      platform: CONTENT_PLATFORMS[platformIdx].name,
      course_today: COURSE_TOPICS[courseIdx].course,
      service_today: SERVICE_TOPICS[serviceIdx].service,
      tip: `今日 GIA 建議寫 ${CONTENT_PLATFORMS[platformIdx].name}（兩篇：1 篇商品主題招生 + 1 篇商品介紹項目）`
    }
  };
}

function readLog(file, n = 30) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function getRecentAudits(n = 7) { return readLog(VISIBILITY_LOG, n); }
function getRecentContent(n = 30) { return readLog(CONTENT_LOG, n); }
function getRecentCompetitorReports(n = 10) { return readLog(COMPETITOR_LOG, n); }

// =============================================================
// 6. Daily auto-publish to Medium (draft) — runs via cron
// =============================================================
async function dailyAutoPublishToMedium(opts = {}) {
  ensureDir();
  const AUTO_LOG = path.join(GEO_DIR, "auto_publish_log.jsonl");
  const blog = require('./blog');
  const start = new Date();
  const yearStart = new Date(start.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((start - yearStart) / 86400000);
  const TOTAL = COURSE_TOPICS.length + SERVICE_TOPICS.length;
  const rotationIdx = (opts && opts.rotationIdx != null) ? (opts.rotationIdx % TOTAL) : (dayOfYear % TOTAL);
  const isCourse = rotationIdx < COURSE_TOPICS.length;
  const type = isCourse ? "course" : "service";
  const topicIdx = isCourse ? rotationIdx : rotationIdx - COURSE_TOPICS.length;
  // 1. Generate Medium-style long-form (re-use existing generator)
  const gen = await generateContent({ platformIdx: 0, topicIdx, type });
  if (!gen.ok) {
    const fail = { ts: new Date().toISOString(), step: "generate", error: gen.error, rotationIdx, type, topicIdx };
    try { fs.appendFileSync(AUTO_LOG, JSON.stringify(fail) + "\n"); } catch {}
    return fail;
  }
  // 2. Extract title from first heading or line
  let title = "";
  const lines = (gen.content || "").split("\n").map(l => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (l.startsWith("#")) { title = l.replace(/^#+\s*/, ""); break; }
  }
  if (!title && lines[0]) title = lines[0];
  if (!title) title = `${gen.subject} | 溫點 WarmPlace`;
  title = title.replace(/[\*`]/g, "").trim();
  // Aggressive title cleanup: drop parentheticals, bilingual subtitles, trailing colons
  title = title.split(/[（(]/)[0].trim();                  // drop everything after first paren
  title = title.split(/\s*[—–]+\s*/)[0].trim();            // drop after em/en dash subtitle
  title = title.split(/\s+[-]\s+/)[0].trim();              // drop after " - " subtitle
  title = title.replace(/[：:].*$/, "").trim();              // drop after colon
  title = title.replace(/^[\s\d.、]+/, "").trim();          // strip leading numbering
  title = title.replace(/[。.!?！？]+$/, "").trim();         // strip trailing punctuation
  if (title.length > 28) title = title.slice(0, 26) + "…";
  // 3. Build tags
  const tags = [
    "溫點 WarmPlace", "韓系精品", "馬卡龍", gen.subject,
    type === "course" ? "禮盒商品" : "禮贈服務"
  ].filter(Boolean).slice(0, 5);
  // 4. Publish to 溫點 WarmPlace self-hosted blog (no external API needed)
  const pub = blog.publishPost({ title, contentMarkdown: gen.content, type, subject: gen.subject, tags });
  // 4b. Also publish to macarondeluxe.com (WordPress) — own domain authority
  let wpPub = { ok: false, skipped: true };
  try {
    const wp = require('./wordpress');
    if (process.env.WORDPRESS_APP_PASSWORD) {
      wpPub = await wp.publishPost({ title, contentMarkdown: gen.content, status: 'publish', tags });
    }
  } catch (e) { wpPub = { ok: false, error: 'wp module: ' + e.message }; }
  // 4c. Also publish to FB pages — full article text (not just link)
  let fbPub = { ok: false, skipped: true };
  try {
    const ap = require('./auto-publish');
    if (ap && ap.publishFB) {
      const md = gen.content || '';
      let s = md;
      s = s.replace(/^#{1,3}\s*/gm, '');
      s = s.replace(/\*\*(.+?)\*\*/g, '$1');
      s = s.replace(/\*(.+?)\*/g, '$1');
      s = s.replace(/`([^`]+)`/g, '$1');
      s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
      s = s.replace(/^\s*[-*]\s+/gm, '• ');
      s = s.replace(/^\s*\d+\.\s+/gm, '');
      s = s.replace(/^\s*>\s*/gm, '');
      s = s.replace(/^\|.*\|\s*$/gm, '');
      s = s.replace(/\n{3,}/g, '\n\n').trim();
      if (s.length > 2400) s = s.slice(0, 2380).replace(/[，。、；,;.][^，。、；,;.]*$/, '') + '…';
      const articleUrl = (wpPub && wpPub.url) || 'https://macarondeluxe.com/';
      const fbCaption = s + '\n\n──────────\n📖 完整文章與更多資訊：\n👉 ' + articleUrl + '\n\n📩 私訊了解詳情\n#WarmPlace #韓系馬卡龍 #精品禮盒';
      fbPub = await ap.publishFB(fbCaption);
    }
  } catch (e) { fbPub = { ok: false, error: 'fb publish: ' + e.message }; }
  const record = {
    ts: new Date().toISOString(),
    rotation_idx: rotationIdx, type, topic_idx: topicIdx,
    subject: gen.subject, title, word_count: gen.word_count,
    publish: pub, wp: wpPub, fb: fbPub,
  };
  try { fs.appendFileSync(AUTO_LOG, JSON.stringify(record) + "\n"); } catch {}
  return { ok: !!(pub && pub.ok), ...record };
}
function getRecentAutoPublishLog(n = 30) {
  return readLog(path.join(GEO_DIR, "auto_publish_log.jsonl"), n);
}

module.exports = {
  auditAIVisibility, generateContent, competitorComparison, generateSchemaOrg, dailyBriefing,
  generateLongFormContent, publishToMedium,
  dailyAutoPublishToMedium, getRecentAutoPublishLog,
  getRecentAudits, getRecentContent, getRecentCompetitorReports,
  AUDIT_QUERIES, CONTENT_PLATFORMS, COURSE_TOPICS, SERVICE_TOPICS, LONGFORM_TEMPLATES,
}
