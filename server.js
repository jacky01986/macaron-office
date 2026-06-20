// ============================================================
// 溫點 WarmPlace · Virtual Office Server v2
// ------------------------------------------------------------
// 1. /api/employees           — 員工清單
// 2. /api/chat                — 一般單一員工 SSE 對話
// 3. /api/orchestrate         — 行銷總監模式：拆解 → 平行 → 統整
// 4. /api/reports             — 排程報告紀錄
// 5. node-cron 自動排程
// ============================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const Anthropic = require("@anthropic-ai/sdk").default;
const { EMPLOYEES } = require("./employees");
const meta = require("./meta");
let marketIntel = null; try { marketIntel = require("./market-intel"); } catch (e) { console.error("market-intel load:", e.message); }
const line = require("./line");
const customerProfiler = require('./customer-profiler');
const decisions = require('./decisions');
let geo = null; try { geo = require('./geo'); } catch (e) { console.error('geo module load fail:', e.message); }
let blog = null;
try { blog = require('./blog'); } catch (e) { console.error('[blog] load failed:', e.message); }
const google = require("./google");
const customers = require("./customers");
const alerts = require("./alerts");
const metaOverride = require("./meta-override");
metaOverride.applyOnStartup();
const autoPublish = require("./auto-publish");
const salesmartly = require("./salesmartly");
const metaCapi = require("./meta-capi");
const lineConv = (() => { try { return require('./line-conversion'); } catch { return null; } })();
const aiTeamContent = (() => { try { return require('./ai-team-content'); } catch { return null; } })();
const scout = (() => { try { return require('./scout'); } catch { return null; } })();
const __webhookHits = [];
const toolDefs = require("./tools");

// In-memory proposal storage (保留在記憶體就好，重啟失效 OK)
const PROPOSALS = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of PROPOSALS) if (now - v.createdAt > 30 * 60 * 1000) PROPOSALS.delete(k); }, 5 * 60 * 1000);
const multer = require("multer");

// Employees that benefit from Meta live data in their prompt
const META_AWARE_EMPLOYEES = new Set(["victor", "leon", "camille", "aria", "dex", "nova", "milo"]);

const FORMAT_ENFORCEMENT = `

---
【★ 輸出格式鐵則 (每一輪都必須遵守，包含第 2、3、4… 輪) ★】
每次回覆都必須用 HTML 片段（不要純文字）：
<h4>標題</h4>
<p>段落</p>
<ul><li>條列</li></ul>
<div class="tldr">⚡ TL;DR｜重點結論</div>
<table class="data"><thead><tr><th>項目</th><th>數字</th></tr></thead><tbody><tr><td>…</td><td>…</td></tr></tbody></table>
<strong>粗體</strong>、<em>斜體</em>、<code>代碼</code>、<blockquote>引述</blockquote>

禁止：純文字段落、Markdown (## / **), 只輸出 text 沒有 tags。
每次都要用 <div class="tldr"> 開頭總結，這個習慣不可省略。

如果對話進入第 2、3 輪以上，仍須保持上述 HTML 結構，不要因為是「繼續對話」就簡化。`;

async function maybeAugmentSystemPrompt(emp) {
  const _surrSafe = s => String(s||'').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,'');
  let baseSystem = _surrSafe(emp.systemPrompt + FORMAT_ENFORCEMENT);
  // ② 多輪記憶 + (2) 昨日教訓
  try {
    const H = require('./history');
    const fnMap = { victor:'VICTOR', leon:'CAMILLE', camille:'CAMILLE', aria:'CAMILLE', dex:'DEX', nova:'NOVA', milo:'CAMILLE', rina:'RINA', hana:'HANA', mira:'MIRA', june:'JUNE', sola:'SOLA', files:'FILES' };
    const fn = fnMap[(emp.id||'').toLowerCase()] || 'VICTOR';
    // (2) 昨日教訓 — 從 self-eval 注入
    try {
      const se = require('./self-eval');
      const tail = se.getLessonFor(fn);
      if (tail) baseSystem += tail;
    } catch {}
    const recent = H.list({ limit: 5, fn });
    if (recent && recent.length) {
      const safeStr2 = s => String(s||'').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,'');
      const lines = recent.map((r,i) => safeStr2('['+(i+1)+'] '+r.title+' — '+ (r.snippet||'').slice(0,120)));
      baseSystem += '\n\n=== 📚 你最近 5 次跟 Sam 的對話 (延續討論, 不要重複問已答過的) ===\n' + lines.join('\n') + '\n=== 記憶結束 ===\n';
    }
  } catch {}
  if (!META_AWARE_EMPLOYEES.has(emp.id) || !meta.tokenOk()) return baseSystem.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,'');
  try {
    const metaBlock = await meta.buildCoachDataBlock();
    const googleBlock = google.tokenOk() ? await google.buildCoachDataBlock() : null;
    if (!metaBlock && !googleBlock) return baseSystem;
    let extra = "";
    if (metaBlock) {
      extra += "\n\n---\n[📡 COACHING DATA · Meta 即時數據快照]\n" +
        "以下是從 Meta Graph API 即時抓取的真實數據，請在教練建議與分析時優先引用這些數字：\n\n" +
        metaBlock + "\n\n(資料來源：Meta Graph API)";
    }
    if (googleBlock) {
      extra += "\n\n---\n[📊 COACHING DATA · Google Ads 即時數據快照]\n" +
        googleBlock + "\n\n(資料來源：Google Ads API)";
    }
    const finalSafe = (baseSystem + extra).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,'');
  return finalSafe;
  } catch (e) {
    console.warn(`[meta coaching-data] ${emp.id}:`, e.message);
    return baseSystem;
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5-20250929";
const DIRECTOR_MODEL = process.env.CLAUDE_DIRECTOR_MODEL || MODEL;
const DATA_DIR = path.join(__dirname, "data");
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(REPORTS_FILE)) fs.writeFileSync(REPORTS_FILE, "[]", "utf8");

// LINE upload directory (T4.6)
const LINE_UPLOAD_DIR = path.join(DATA_DIR, "uploads");
if (!fs.existsSync(LINE_UPLOAD_DIR)) fs.mkdirSync(LINE_UPLOAD_DIR, { recursive: true });
const lineUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LINE_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || "").toLowerCase().slice(0, 5);
    const safeExt = /\.(jpg|jpeg|png|gif|webp)$/i.test(ext) ? ext : ".jpg";
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2,10)}${safeExt}`);
  },
});
const lineUpload = multer({
  storage: lineUploadStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error("only images allowed"));
    cb(null, true);
  },
});

app.use(cors());

// ============================================================
// /api/line/webhook — LINE 訊息接收端（要 raw body 驗 signature）
// 必須放在 express.json() middleware 之前
// ============================================================
app.post('/api/line/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['x-line-signature'];
    const rawBody = req.body.toString('utf8');
    if (!line.verifySignature(rawBody, signature)) {
      console.warn('[LINE webhook] signature mismatch');
      return res.status(401).send('invalid signature');
    }
    // 先回 200 讓 LINE 不要重試
    res.status(200).send('ok');
    let payload;
    try { payload = JSON.parse(rawBody); } catch (e) { return; }
    for (const event of (payload.events || [])) {
      // decisions.js: 給決策建議流程一次攔截機會
      try { const _dr = await decisions.handleLineMessage(event); if (_dr) continue; } catch(e) { console.error("decisions handler:", e.message); }
      handleLineEvent(event).catch(err => console.error('[LINE event]', err));
    }
  }
);

app.use(express.json({ limit: "1mb" }));

// ============================================================
// /api/telegram/webhook — Telegram bot 對話入口
// ------------------------------------------------------------
// 接 @A12target_bot 訊息 → VICTOR 自動路由 → 員工答 → 回 Telegram
// 安全:只認 process.env.TELEGRAM_CHAT_ID
// Webhook URL 設定:在 BotFather 對 bot 設
//   https://macaron-office.onrender.com/api/telegram/webhook
// ============================================================
app.post('/api/telegram/webhook', async (req, res) => {
  // 立刻回 200 給 Telegram(避免 retry),處理在背景
  res.json({ ok: true });
  try {
    const { handleWebhook } = require('./telegram-chat');
    await handleWebhook({
      payload: req.body,
      EMPLOYEES,
      maybeAugmentSystemPrompt,
    });
  } catch (e) {
    console.error('[telegram webhook]', e.message);
  }
});

// 工具端點:檢查 Telegram 設定狀態
app.get('/api/telegram/status', (req, res) => {
  res.json({
    token_set: !!process.env.TELEGRAM_BOT_TOKEN,
    chat_id_set: !!process.env.TELEGRAM_CHAT_ID,
    webhook_url: `https://${req.get('host')}/api/telegram/webhook`,
    setup_hint: '到 BotFather → /setwebhook → 把上面那個 webhook_url 貼進去',
  });
});

// ============================================================
// GET / — 注入全站導覽列到 index.html
// ============================================================
app.get('/', (req, res, next) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) return next();
    const navHtml = '';
    const injected = html.replace('</body>', navHtml + '</body>');
    res.type('html').send(injected);
  });
});


app.use(express.static(path.join(__dirname, "public")));

// Serve LINE uploaded images publicly (LINE CDN 會抓這個 URL)
app.use("/uploads", express.static(LINE_UPLOAD_DIR, { maxAge: "30d" }));

// === 自動生圖的靜態 serve (給 IG / FB 抓圖用) ===
const imageGen = (() => { try { return require('./image-gen'); } catch { return null; } })();
const AUTO_IMG_DIR = (imageGen && imageGen.IMG_DIR) || require('path').join(__dirname, 'data', 'auto-images');
try { require('fs').mkdirSync(AUTO_IMG_DIR, { recursive: true }); } catch {}
app.use("/uploads/auto-images", express.static(AUTO_IMG_DIR, { maxAge: "365d" }));

// POST /api/line/upload  上傳圖片檔給 LINE 用（multipart/form-data, field: file）
app.post("/api/line/upload", (req, res) => {
  lineUpload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: String(err.message || err) });
    if (!req.file) return res.status(400).json({ error: "no file" });
    const host = `${req.protocol}://${req.get("host")}`;
    const url = `${host}/uploads/${req.file.filename}`;
    res.json({ ok: true, url, filename: req.file.filename, size: req.file.size });
  });
});

let anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); try { const _enh = require("./ai-enhancements"); const _orig = anthropic.messages.create.bind(anthropic.messages); anthropic.messages.create = function(o) { try { return _enh.enhancedCreate(_orig, o); } catch (e) { console.error("[ai-enhancements] enhancedCreate err:", e.message); return _orig(o); } }; console.log("[ai-enhancements] enhancedCreate auto-injected: EVIDENCE_RULE + web_search tool + tool_use loop"); } catch (e) { console.error("[ai-enhancements] wrapper inject failed:", e.message); }
  console.log("[OK] Anthropic client initialized | worker:", MODEL, "| director:", DIRECTOR_MODEL);
} else {
  console.warn("[WARN] ANTHROPIC_API_KEY not set");
}

// ============================================================
// /api/employees
// ============================================================
app.get("/api/employees", (req, res) => {
  const list = Object.values(EMPLOYEES).map(e => ({
    id: e.id,
    name: e.name,
    role: e.role,
    roleEn: e.roleEn,
    emoji: e.emoji,
    bio: e.bio,
    color: e.color,
    isDirector: !!e.isDirector,
    quickTasks: e.quickTasks,
  }));
  res.json(list);
});

app.get("/api/employees/:id/prompt", (req, res) => {
  const emp = EMPLOYEES[req.params.id];
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  res.json({ systemPrompt: emp.systemPrompt });
});

// ============================================================
// SSE helpers
// ============================================================
function setupSSE(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  return (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================
// /api/meta/* — Stage 2 read-only Meta integration
// ============================================================
app.get("/api/meta/status", async (req, res) => {
  try {
    const status = await meta.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Direct Meta inbox reader — FB Messenger + IG DM conversations (bypass SaleSmartly)
app.get("/api/meta/inbox", async (req, res) => {
  try {
    const m = require("./meta");
    if (!m.getInbox) return res.status(500).json({ ok: false, error: "meta.getInbox not loaded" });
    const limit_conv = parseInt(req.query.limit || "10", 10);
    const limit_msg = parseInt(req.query.msg_limit || "8", 10);
    const r = await m.getInbox({ limit_conv, limit_msg });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// /api/meta/assets — 列出 user 所有 FB Pages / IG Business / Ad Accounts（for switcher）
app.get("/api/salesmartly/webhook/recent", (req, res) => { res.json({ count: __webhookHits.length, hits: __webhookHits.slice(-20) }); });

app.post("/api/salesmartly/webhook", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const rawBody = req.body || {};
    let parsedData = {};
    if (rawBody.data) {
      if (typeof rawBody.data === 'string') {
        try { parsedData = JSON.parse(rawBody.data); } catch (e) { parsedData = { _parse_error: e.message }; }
      } else if (typeof rawBody.data === 'object') {
        parsedData = rawBody.data;
      }
    }
    const chat_user_id = parsedData.chat_user_id || rawBody.chat_user_id || rawBody.user_id;
    const session_id = parsedData.session_id || parsedData.sequence_id || rawBody.session_id;
    const channel = parsedData.channel || parsedData.channel_id || rawBody.channel;
    const msg = parsedData.msg || parsedData.content || parsedData.text;
    const msg_type = parsedData.msg_type || rawBody.msg_type;
    const send_time = parsedData.send_time || parsedData.sequence_id;
    const evtType = rawBody.event || rawBody.event_type || rawBody.type || 'unknown';
    const evtTypeLower = String(evtType).toLowerCase();
    const isInbound = ['message', 'msg', 'new_session', 'session.start', 'customer_first_message', 'chat'].some(t => evtTypeLower.includes(t));
    
    try {
      const fs = require('fs');
      const path = require('path');
      const dataDir = path.join(__dirname, 'data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const logFile = path.join(dataDir, 'salesmartly_webhook_events.jsonl');
      const logLine = JSON.stringify({
        ts: new Date().toISOString(),
        event_type: evtType,
        chat_user_id, session_id, channel,
        msg_type, msg: msg ? String(msg).slice(0, 500) : null,
        send_time, is_inbound: isInbound,
        body_keys: Object.keys(rawBody),
        parsed_keys: Object.keys(parsedData),
        full_body: JSON.stringify(rawBody).slice(0, 3000)
      }) + '\n';
      fs.appendFileSync(logFile, logLine);
      // Trigger AI customer profile analysis (background, fire-and-forget)
      if (chat_user_id && msg && customerProfiler) {
        customerProfiler.updateProfile({ chat_user_id, msg, channel, user_name: parsedData.user_name || parsedData.name }).catch(e => console.error('[webhook] profiler:', e.message));
      }
    } catch (e) { console.error('[salesmartly-webhook] log:', e.message); }
    
    let capiResult = null;
    if (isInbound && chat_user_id && typeof metaCapi !== 'undefined' && metaCapi && metaCapi.sendLead) {
      try {
        capiResult = await metaCapi.sendLead({
          contact_id: chat_user_id,
          name: parsedData.user_name || parsedData.name,
          email: parsedData.email,
          phone: parsedData.phone,
          source_channel: channel || 'salesmartly',
          message_preview: msg
        });
      } catch (e) { console.error('[salesmartly-webhook] capi:', e.message); }
    }
    res.json({
      ok: true, processed: isInbound, event_type: evtType,
      extracted: { chat_user_id: chat_user_id ? String(chat_user_id).slice(0, 12) + '...' : null, msg_preview: msg ? String(msg).slice(0, 50) : null, channel, msg_type },
      capi: capiResult ? { ok: capiResult.ok } : null
    });
  } catch (e) {
    console.error('[salesmartly-webhook]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/salesmartly/debug", async (req, res) => {
  try {
    const r = await salesmartly.probeAll();
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/meta/assets", async (req, res) => {
    try {
      const result = await metaOverride.listAssets();
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

// /api/meta/switch — 切換目前使用中的粉絲頁/IG/廣告帳戶（session-level override）
let SESSION_OVERRIDE = { pageId: null, igId: null, adAccountId: null };
app.post("/api/meta/switch", express.json(), (req, res) => {
  const { pageId, igId, adAccountId } = req.body || {};
  if (pageId !== undefined) SESSION_OVERRIDE.pageId = pageId || null;
  if (igId !== undefined) SESSION_OVERRIDE.igId = igId || null;
  if (adAccountId !== undefined) SESSION_OVERRIDE.adAccountId = adAccountId || null;
  // Update process.env so meta.js picks up the new IDs for subsequent API calls
  if (SESSION_OVERRIDE.pageId) process.env.META_FB_PAGE_ID = SESSION_OVERRIDE.pageId;
  if (SESSION_OVERRIDE.igId) process.env.META_IG_USER_ID = SESSION_OVERRIDE.igId;
  if (SESSION_OVERRIDE.adAccountId) process.env.META_AD_ACCOUNT_ID = String(SESSION_OVERRIDE.adAccountId).replace(/^act_/, '');
  res.json({ ok: true, current: {
    pageId: process.env.META_FB_PAGE_ID,
    igId: process.env.META_IG_USER_ID,
    adAccountId: process.env.META_AD_ACCOUNT_ID,
    override: SESSION_OVERRIDE,
  } });
});

app.get("/api/meta/fb/posts", async (req, res) => {
  try {
    const posts = await meta.getFbPagePosts({ limit: Number(req.query.limit) || 10 });
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/meta/ig/media", async (req, res) => {
  try {
    const media = await meta.getIgMedia({ limit: Number(req.query.limit) || 10 });
    res.json(media);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/meta/ads/insights", async (req, res) => {
  try {
    const insights = await meta.getAdsInsights({ datePreset: req.query.preset || "last_7d" });
    res.json(insights);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/meta/ads/campaigns", async (req, res) => {
  try {
    const camps = await meta.getAdCampaigns({ limit: Number(req.query.limit) || 25 });
    res.json(camps);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ============================================================
// /api/optimize/* — Phase 1: 廣告半自動優化（提議 → 確認 → 執行）
// ============================================================
const ACTIONS_FILE = path.join(DATA_DIR, "actions.json");
if (!fs.existsSync(ACTIONS_FILE)) fs.writeFileSync(ACTIONS_FILE, "[]", "utf8");

function appendAction(record) {
  try {
    const arr = JSON.parse(fs.readFileSync(ACTIONS_FILE, "utf8"));
    arr.push({ ...record, id: Date.now() + Math.floor(Math.random() * 1000), createdAt: new Date().toISOString() });
    fs.writeFileSync(ACTIONS_FILE, JSON.stringify(arr.slice(-200), null, 2), "utf8");
  } catch (e) {
    console.error("[appendAction]", e);
  }
}

// GET /api/optimize/propose-pauses?preset=last_7d&roas=0.8&ctr=0.5&cpm=250&max=5
app.get("/api/optimize/propose-pauses", async (req, res) => {
  try {
    const preset = req.query.preset || "last_7d";
    const ads = await meta.getAdsWithInsights({ datePreset: preset, limit: 100 });
    const rules = {
      minAgeDays: Number(req.query.minAgeDays) || 3,
      minSpend: Number(req.query.minSpend) || 1000,
      roasThreshold: Number(req.query.roas) || 0.8,
      ctrThreshold: Number(req.query.ctr) || 0.5,
      cpmCeiling: Number(req.query.cpm) || 250,
      maxProposals: Number(req.query.max) || 5,
    };
    const proposals = meta.proposePausesFromAds(ads, rules);
    res.json({
      preset,
      rules,
      totalAdsScanned: ads.length,
      proposalCount: proposals.length,
      proposals,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[propose-pauses]", err);
    res.status(500).json({ error: String(err.message || err), graphError: err.graphError || null });
  }
});

// POST /api/optimize/execute-pause  body: {adId, adName, reason, confirmed: true}
app.post("/api/optimize/execute-pause", async (req, res) => {
  const { adId, adName, reason, confirmed } = req.body || {};
  if (!adId) return res.status(400).json({ error: "adId required" });
  if (confirmed !== true) return res.status(400).json({ error: "must include confirmed:true" });

  try {
    const result = await meta.pauseAd(adId);
    appendAction({
      type: "pause-ad",
      adId,
      adName: adName || null,
      reason: reason || null,
      success: true,
      result,
    });
    res.json({ ok: true, adId, result });
  } catch (err) {
    appendAction({
      type: "pause-ad",
      adId,
      adName: adName || null,
      reason: reason || null,
      success: false,
      error: String(err.message || err),
    });
    res.status(500).json({ error: String(err.message || err), graphError: err.graphError || null });
  }
});

// GET /api/optimize/actions — 歷史紀錄
app.get("/api/optimize/actions", (req, res) => {
  try {
    const arr = JSON.parse(fs.readFileSync(ACTIONS_FILE, "utf8"));
    res.json(arr.slice(-50).reverse());
  } catch (e) {
    res.json([]);
  }
});


// GET /api/optimize/propose-budget-changes?preset=last_7d&high=2.5&low=1.5&inc=20&dec=30&maxBudget=500
app.get("/api/optimize/propose-budget-changes", async (req, res) => {
  try {
    const preset = req.query.preset || "last_7d";
    const adsets = await meta.getAdSetsWithInsights({ datePreset: preset, limit: 100 });
    const rules = {
      minAgeDays: Number(req.query.minAgeDays) || 3,
      minSpend: Number(req.query.minSpend) || 1000,
      roasHighThreshold: Number(req.query.high) || 2.5,
      roasLowThreshold: Number(req.query.low) || 1.5,
      increasePercent: Number(req.query.inc) || 20,
      decreasePercent: Number(req.query.dec) || 30,
      maxDailyBudget: Number(req.query.maxBudget) || 500,
      minDailyBudget: Number(req.query.minBudget) || 100,
      maxProposals: Number(req.query.max) || 10,
    };
    const proposals = meta.proposeBudgetChangesFromAdSets(adsets, rules);
    res.json({
      preset,
      rules,
      totalAdSetsScanned: adsets.length,
      proposalCount: proposals.length,
      proposals,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[propose-budget-changes]", err);
    res.status(500).json({ error: String(err.message || err), graphError: err.graphError || null });
  }
});

// POST /api/optimize/execute-budget-change
// body: { adsetId, adsetName, newDailyBudget, oldDailyBudget, action, reason, confirmed:true }
app.post("/api/optimize/execute-budget-change", async (req, res) => {
  const { adsetId, adsetName, newDailyBudget, oldDailyBudget, action, reason, confirmed } = req.body || {};
  if (!adsetId) return res.status(400).json({ error: "adsetId required" });
  if (!Number.isFinite(newDailyBudget) || newDailyBudget < 100) return res.status(400).json({ error: "newDailyBudget must be >= 100" });
  if (confirmed !== true) return res.status(400).json({ error: "must include confirmed:true" });

  try {
    const result = await meta.updateAdSetBudget(adsetId, newDailyBudget);
    appendAction({
      type: "update-adset-budget",
      adsetId,
      adsetName: adsetName || null,
      oldDailyBudget: oldDailyBudget ?? null,
      newDailyBudget,
      action: action || null,
      reason: reason || null,
      success: true,
      result,
    });
    res.json({ ok: true, adsetId, newDailyBudget, result });
  } catch (err) {
    appendAction({
      type: "update-adset-budget",
      adsetId,
      adsetName: adsetName || null,
      oldDailyBudget: oldDailyBudget ?? null,
      newDailyBudget,
      action: action || null,
      reason: reason || null,
      success: false,
      error: String(err.message || err),
    });
    res.status(500).json({ error: String(err.message || err), graphError: err.graphError || null });
  }
});


// ============================================================
// /api/intel/* — T2: 競品情報（Meta Ad Library）
// ============================================================

// GET /api/intel/competitor-ads?brand=法朋&country=TW
app.get("/api/intel/competitor-ads", async (req, res) => {
  try {
    // Default to ALL major macaron competitors if no brand given
    const brand = req.query.brand || '法朋';
    const country = req.query.country || "TW";
    const limit = Number(req.query.limit) || 25;
    const data = await meta.searchAdsLibrary({ searchTerms: brand, country, limit });
    res.json(data);
  } catch (err) {
    console.error("[competitor-ads]", err);
    res.status(500).json({
      error: String(err.message || err),
      graphError: err.graphError || null,
      fallbackUrl: `https://www.facebook.com/ads/library/?ad_type=all&country=${req.query.country || "TW"}&q=${encodeURIComponent(req.query.brand || "")}`,
    });
  }
});

// GET /api/intel/competitor-scan?country=TW — 掃預設競品名單
app.get("/api/intel/competitor-scan", async (req, res) => {
  try {
    const country = req.query.country || "TW";
    const limit = Number(req.query.limit) || 10;
    const data = await meta.scanCompetitors({ country, limit });
    res.json(data);
  } catch (err) {
    console.error("[competitor-scan]", err);
    res.status(500).json({ error: String(err.message || err), graphError: err.graphError || null });
  }
});

// GET /api/intel/competitors — 返回預設競品名單
app.get("/api/intel/competitors", (req, res) => {
  res.json(meta.DEFAULT_COMPETITORS);
});


// ============================================================
// /api/social/* — T3: 社群自動發文（NOVA 寫 → 你確認 → 發）
// ============================================================
const DRAFTS_FILE = path.join(DATA_DIR, "drafts.json");
if (!fs.existsSync(DRAFTS_FILE)) fs.writeFileSync(DRAFTS_FILE, "[]", "utf8");

function loadDrafts() {
  try { return JSON.parse(fs.readFileSync(DRAFTS_FILE, "utf8")); } catch(e) { return []; }
}
function saveDrafts(arr) {
  fs.writeFileSync(DRAFTS_FILE, JSON.stringify(arr.slice(-100), null, 2), "utf8");
}

// POST /api/social/generate-draft  body: {brief, platform, count}
// 用 NOVA 生 count 份草稿
app.post("/api/social/generate-draft", async (req, res) => {
  const { brief, platform = "FB", count = 3 } = req.body || {};
  if (!brief || brief.trim().length < 5) return res.status(400).json({ error: "brief too short" });
  if (!anthropic) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const emp = EMPLOYEES["nova"];
  const platformTag = platform === "IG" ? "Instagram（短、重畫面感、hashtags）" : "Facebook（較長、可帶連結、故事感）";

  const userPrompt = `請針對下面的 brief，寫 ${count} 個不同風格的 ${platformTag} 貼文草稿。

Brief：${brief}

要求：
- 回傳 JSON 陣列格式：[{"style":"風格名","caption":"內容"}, ...]
- 每個草稿的 style 標題要不同（例如：情感型、功能型、好奇心型、情境型）
- caption 要符合 溫點 WarmPlace 品牌語調（精品、韓式、內斂、不農場標題）
- FB 貼文 150-300 字，IG 貼文 80-150 字 + 3-5 個 hashtag
- 直接回 JSON 陣列，不要任何前後綴或 markdown`;

  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: emp.systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const text = msg.content.map(b => b.text || "").join("").trim();
    // 嘗試抽取 JSON 陣列
    let drafts;
    try {
      const m = text.match(/\[[\s\S]*\]/);
      drafts = JSON.parse(m ? m[0] : text);
    } catch(e) {
      return res.status(500).json({ error: "Failed to parse NOVA response as JSON", raw: text.slice(0, 500) });
    }
    // 儲存 draft pack
    const record = {
      id: Date.now() + "_" + Math.floor(Math.random() * 1000),
      createdAt: new Date().toISOString(),
      brief,
      platform,
      drafts: drafts.map((d, i) => ({
        index: i,
        style: d.style || `版本${i+1}`,
        caption: d.caption || "",
      })),
      status: "pending",
    };
    const arr = loadDrafts();
    arr.push(record);
    saveDrafts(arr);
    try { const H = require('./history'); H.record({ fn:'NOVA', title: platform + ' 草稿 · ' + brief.slice(0,40), html: (record.drafts||[]).map(d=>'<h4>'+d.style+'</h4><p>'+String(d.caption).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])).replace(/\n/g,'<br>')+'</p>').join(''), text: (record.drafts||[]).map(d=>d.style+': '+d.caption).join(' / ').slice(0,2000), meta:{ platform, count, draftId: record.id } }); } catch(e) { console.error('[history nova]', e.message); }
    res.json(record);
  } catch (err) {
    console.error("[generate-draft]", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /api/social/drafts — 列出草稿
app.get("/api/social/drafts", (req, res) => {
  res.json(loadDrafts().slice(-30).reverse());
});

// POST /api/social/publish  body: {draftId, index, caption, platform, confirmed:true}
// draftId + index 是從草稿包選一個；caption 是你最終編輯過的版本
app.post("/api/social/publish", async (req, res) => {
  const { draftId, index, caption, platform, imageUrl, link, confirmed } = req.body || {};
  if (confirmed !== true) return res.status(400).json({ error: "must include confirmed:true" });
  if (!caption || caption.trim().length < 5) return res.status(400).json({ error: "caption too short" });

  try {
    let result;
    if (platform === "IG") {
      if (!imageUrl) return res.status(400).json({ error: "IG post requires imageUrl" });
      result = await meta.publishIgImagePost({ imageUrl, caption });
    } else {
      // FB: 如果有 imageUrl 就用 photos endpoint，否則用 feed
      if (imageUrl) {
        result = await meta.publishFbPhoto({ imageUrl, message: caption });
      } else {
        result = await meta.publishFbPost({ message: caption, link });
      }
    }

    // 更新 draft 狀態
    if (draftId) {
      const arr = loadDrafts();
      const rec = arr.find(r => r.id === draftId);
      if (rec) {
        rec.status = "published";
        rec.publishedAt = new Date().toISOString();
        rec.publishedIndex = index ?? null;
        rec.publishedPlatform = platform;
        rec.publishedResult = result;
        saveDrafts(arr);
      }
    }
    // 寫 action log
    appendAction({
      type: "social-publish",
      platform,
      draftId: draftId || null,
      captionPreview: caption.slice(0, 80),
      success: true,
      result,
    });
    res.json({ ok: true, platform, result });
  } catch (err) {
    console.error("[social-publish]", err);
    appendAction({
      type: "social-publish",
      platform,
      draftId: draftId || null,
      captionPreview: caption.slice(0, 80),
      success: false,
      error: String(err.message || err),
    });
    res.status(500).json({ error: String(err.message || err), graphError: err.graphError || null });
  }
});


// ============================================================
// /api/meta/token/* — Token 管理 (T10)
// ============================================================

app.get("/api/meta/token/status", async (req, res) => {
  try {
    const status = await meta.getTokenStatus();
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/meta/token/refresh", async (req, res) => {
  try {
    const result = await meta.refreshUserToken();
    // 更新記憶體中的 env (下次 API 呼叫就會用新 token)
    process.env.META_ACCESS_TOKEN = result.token;
    appendAction({ type: "meta-token-refresh", expiresAt: result.expiresAt });
    res.json({ ok: true, expiresAt: result.expiresAt, expiresIn: result.expiresIn, note: "新 token 已更新到記憶體。要永久保存請手動複製到 Render env vars 的 META_ACCESS_TOKEN。" });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/meta/token/pages", async (req, res) => {
  try {
    const pages = await meta.getLongLivedPageToken();
    // 不直接回傳 token 明碼（安全起見）
    const masked = pages.map(p => ({ id: p.id, name: p.name, tokenPreview: p.pageToken.slice(0, 20) + "...", tokenFull: p.pageToken }));
    res.json({ ok: true, pages: masked });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Lazy refresh：伺服器啟動後每 24 小時檢查一次，若 token 剩不到 10 天自動刷新
(async () => {
  const checkAndRefresh = async () => {
    try {
      if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) return;
      const status = await meta.getTokenStatus();
      if (status.needRefresh && status.daysLeft > 0) {
        const r = await meta.refreshUserToken();
        process.env.META_ACCESS_TOKEN = r.token;
        console.log(`[meta-token] auto-refreshed. expires ${r.expiresAt}`);
        appendAction({ type: "meta-token-auto-refresh", expiresAt: r.expiresAt });
      }
    } catch (e) {
      console.warn("[meta-token] auto-refresh error:", e.message);
    }
  };
  // 啟動後 30 秒先檢查一次，之後每 24 小時
  setTimeout(checkAndRefresh, 30 * 1000);
  setInterval(checkAndRefresh, 24 * 3600 * 1000);
})();

// ============================================================
// Tool executor — 跑 READ tool 動作
// ============================================================
async function executeReadTool(name, input) {
  switch (name) {
    case "get_meta_summary": {
      const preset = input.datePreset || "last_7d";
      return await meta.getAdsInsights({ datePreset: preset });
    }
    case "get_meta_campaigns": {
      const limit = input.limit || 25;
      return await meta.getAdCampaigns({ limit });
    }
    case "get_meta_ads": {
      const preset = input.datePreset || "last_7d";
      const limit = input.limit || 50;
      return (await meta.getAdsWithInsights({ datePreset: preset, limit })).slice(0, limit);
    }
    case "get_meta_adsets": {
      const preset = input.datePreset || "last_7d";
      return (await meta.getAdSetsWithInsights({ datePreset: preset, limit: 50 })).slice(0, 50);
    }
    case "scan_competitors": {
      const country = "TW";
      if (input.brand) return await meta.searchAdsLibrary({ searchTerms: input.brand, country, limit: 20 });
      return await meta.scanCompetitors({ country, limit: 10 });
    }
    case "list_line_messages": {
      const all = (function loadLm() { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "line-messages.json"), "utf8")); } catch(e) { return []; }})();
      const filtered = input.onlyPending ? all.filter(m => !m.replied) : all;
      return filtered.slice(0, input.limit || 30).map(m => ({ id: m.id, userName: m.userName, text: m.text, intent: m.intent, replied: m.replied, timestamp: m.timestamp }));
    }
    case "get_customer_profile": {
      const msgs = customers.loadMessages(DATA_DIR);
      const profs = customers.loadCustomerProfiles(DATA_DIR);
      const list = customers.aggregateCustomers(msgs, profs);
      const c = list.find(x => x.userId === input.userId);
      if (!c) return { error: "customer not found" };
      return { ...c, messages: c.messages.slice(0, 10) };
    }
    case "list_customers_in_segment": {
      const msgs = customers.loadMessages(DATA_DIR);
      const profs = customers.loadCustomerProfiles(DATA_DIR);
      const list = customers.aggregateCustomers(msgs, profs);
      const groups = customers.groupBySegment(list);
      return (groups[input.segment] || []).map(c => ({ userId: c.userId, userName: c.userName, frequency: c.frequency, recencyDays: c.recencyDays, monetary: c.monetary, tags: c.tags }));
    }
    case "get_google_summary": {
      if (!google.tokenOk()) return { error: "Google Ads 未設定" };
      return await google.getAccountSummary({ dateRange: input.dateRange || "LAST_7_DAYS" });
    }
    case "get_account_health": {
      const out = { timestamp: new Date().toISOString() };
      try { out.meta = await meta.getAdsInsights({ datePreset: "last_7d" }); } catch(e) { out.meta = { error: e.message }; }
      try {
        const msgs = customers.loadMessages(DATA_DIR);
        const list = customers.aggregateCustomers(msgs, customers.loadCustomerProfiles(DATA_DIR));
        const pending = (function() { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "line-messages.json"), "utf8")).filter(m => !m.replied).length; } catch(e){ return 0; }})();
        const groups = customers.groupBySegment(list);
        out.line = { totalCustomers: list.length, pending, vip: groups.vip.length, active: groups.active.length, new: groups.new.length, atrisk: groups.atrisk.length };
      } catch(e) { out.line = { error: e.message }; }
      try {
        if (google.tokenOk()) out.google = await google.getAccountSummary({ dateRange: "LAST_7_DAYS" });
        else out.google = { notConfigured: true };
      } catch(e) { out.google = { error: e.message }; }
      return out;
    }
    case "generate_docx": {
      try { const filesMod = require('./files'); return await filesMod.generateDocx(input || {}); } catch(e) { return { error: e.message }; }
    }
    case "generate_xlsx": {
      try { const filesMod = require('./files'); return await filesMod.generateXlsx(input || {}); } catch(e) { return { error: e.message }; }
    }
    case "generate_pdf": {
      try { const filesMod = require('./files'); return await filesMod.generatePdf(input || {}); } catch(e) { return { error: e.message }; }
    }
    case "generate_pptx": {
      try { const filesMod = require('./files'); return await filesMod.generatePptx(input || {}); } catch(e) { return { error: e.message }; }
    }
    case "fetch_conversation_detail": {
      try {
        const ss = require('./salesmartly');
        if (input.user_id) {
          if (ss && ss.listMessages) {
            const r = await ss.listMessages(input.user_id, { page_size: input.limit || 30 });
            return r;
          }
          return { error: 'salesmartly not available' };
        }
        // 沒給 user_id → 回最近 5 個有對話的客戶 + 各 5 則
        const msgs = customers.loadMessages(DATA_DIR);
        const list = customers.aggregateCustomers(msgs, customers.loadCustomerProfiles(DATA_DIR));
        const top5 = list.sort((a,b)=>(b.frequency||0)-(a.frequency||0)).slice(0,5);
        return top5.map(c => ({ userId: c.userId, userName: c.userName, lastMessages: (c.messages||[]).slice(0,5).map(m=>({ text:m.text, ts:m.timestamp, intent:m.intent, replied:m.replied, replyText:m.replyText })) }));
      } catch(e) { return { error: e.message }; }
    }
    case "get_offline_reports": { try { const o = require("./offline-reports"); return o.buildSummaryForAI(); } catch (e) { return { error: e.message }; } } case "get_shopline_brief": { try { const sp = require("./shopline-polling"); return await sp.buildTeamBrief(); } catch (e) { return { error: e.message }; } } case "get_meta_posts": {
      try {
        const lim = input.limit || 10;
        const plat = input.platform || 'both';
        const out = {};
        if (plat === 'fb' || plat === 'both') {
          try { out.fb = await meta.getFbPagePosts({ limit: lim }); } catch(e) { out.fb = { error: e.message }; }
        }
        if (plat === 'ig' || plat === 'both') {
          try { out.ig = await meta.getIgMedia({ limit: lim }); } catch(e) { out.ig = { error: e.message }; }
        }
        return out;
      } catch(e) { return { error: e.message }; }
    }
    case "delegate_to_employee": {
      try {
        const tgt = String(input.employee||'').toLowerCase();
        const subEmp = EMPLOYEES[tgt];
        if (!subEmp) return { error: '未知員工: ' + tgt + ' (可用: ' + Object.keys(EMPLOYEES).join(',') + ')' };
        const subSystem = await maybeAugmentSystemPrompt(subEmp);
        const r = await anthropic.messages.create({
          model: MODEL, max_tokens: 2000, system: subSystem,
          messages: [{ role: 'user', content: String(input.task||'').slice(0, 4000) }]
        });
        const txt = (r.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
        return { delegated_to: subEmp.name, output: txt.slice(0, 6000) };
      } catch(e) { return { error: e.message }; }
    }
    default:
      return { error: "unknown tool: " + name };
  }
}

// ============================================================
// /api/chat-agent — 支援 tool use loop，員工可以用工具
// ============================================================
const chatAgentHandler = async (req, res) => {
  const { employeeId, messages } = req.body || {};
  const emp = EMPLOYEES[employeeId];
  if (!emp) return res.status(400).json({ error: "Unknown employee" });
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: "messages required" });
  if (!anthropic) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const send = setupSSE(res);
  try {
    const system = await maybeAugmentSystemPrompt(emp);
    const tools = toolDefs.asAnthropicTools(emp.tools || []);
    let msgs = messages.map(m => ({ role: m.role === "ai" ? "assistant" : m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }));

    send("status", { text: `📥 ${emp.name} 收到任務，可用工具 ${tools.length} 個` });

    let safety = 0;
    while (safety++ < 8) {
      const resp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system,
        tools,
        messages: msgs,
      });

      const textBlocks = resp.content.filter(b => b.type === "text");
      const toolUses = resp.content.filter(b => b.type === "tool_use");

      // Stream text blocks
      for (const tb of textBlocks) send("delta", { text: tb.text });

      if (toolUses.length === 0 || resp.stop_reason !== "tool_use") {
        send("done", { ok: true, turns: safety });
        const fullText = textBlocks.map(b => b.text).join('\n');

        // ── 員工互補刀 (partner-take) ──
        let _partnerTakes = [];
        try {
          const { partnerTake } = require('./partner-take');
          const lastUserMsg = (messages || []).filter(m => m.role !== 'assistant' && m.role !== 'ai').slice(-1)[0];
          const userQ = lastUserMsg ? (typeof lastUserMsg.content === 'string' ? lastUserMsg.content : String(lastUserMsg.content)) : '';
          _partnerTakes = await partnerTake({ EMPLOYEES, mainEmployeeId: employeeId, userQuestion: userQ, mainAnswer: fullText, send });
          send('partner_done', { count: _partnerTakes.length });
        } catch (e) { console.error('[partner-take chat-agent]', e.message); }

        // 記錄到歷史
        try {
          const H = require('./history');
          const lastUser = (messages || []).filter(m => m.role !== 'assistant' && m.role !== 'ai').slice(-1)[0];
          const userText = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)) : '';
          const fnMap = { victor:'VICTOR', leon:'CAMILLE', camille:'CAMILLE', aria:'CAMILLE', dex:'DEX', nova:'NOVA', milo:'CAMILLE', rina:'RINA', hana:'HANA', mira:'MIRA', june:'JUNE', sola:'SOLA', files:'FILES' };
          const fn = fnMap[(employeeId||'').toLowerCase()] || 'VICTOR';
          H.record({
            fn,
            title: emp.name + ' 對話 · ' + userText.replace(/<[^>]+>/g,' ').slice(0,40),
            html: '<h4>你問：</h4><p style="white-space:pre-wrap">'+userText.replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))+'</p><h4>'+emp.name+' 回覆：</h4><div>'+fullText+'</div>',
            text: userText.slice(0,500) + ' → ' + fullText.replace(/<[^>]+>/g,' ').slice(0,1500),
            meta: { employeeId, source: 'chat-agent', turns: safety, partner_takes: _partnerTakes.map(t => ({ name: t.name, text: t.text })) }
          });
        } catch(e) { console.error('[history chat-agent]', e.message); }
        return res.end();
      }

      // Process tool uses
      msgs.push({ role: "assistant", content: resp.content });
      const toolResults = [];
      for (const tu of toolUses) {
        if (toolDefs.isWriteTool(tu.name)) {
          // WRITE：存 proposal、通知前端、暫停對話
          const proposalId = "p_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
          PROPOSALS.set(proposalId, {
            id: proposalId,
            employeeId,
            toolName: tu.name,
            toolInput: tu.input,
            messages: msgs,
            systemPrompt: system,
            tools,
            toolUseId: tu.id,
            createdAt: Date.now(),
          });
          send("proposal", {
            id: proposalId,
            tool: tu.name,
            description: toolDefs.TOOL_DEFINITIONS[tu.name].description,
            input: tu.input,
          });
          send("delta", { text: `\n\n⚠️ **想執行：${toolDefs.TOOL_DEFINITIONS[tu.name].description}**\n\n\`\`\`json\n${JSON.stringify(tu.input, null, 2)}\n\`\`\`\n\nProposal ID: \`${proposalId}\`\n\n半自動模式：請檢查上方提案，然後 POST /api/proposals/${proposalId}/execute 確認執行。` });
          send("done", { ok: true, pending_proposal: true });
          return res.end();
        }
        // READ tool - execute
        send("tool_call", { tool: tu.name, input: tu.input });
          send("delta", { text: `\n🔍 [使用工具 ${tu.name}]` });
        try {
          const result = await executeReadTool(tu.name, tu.input || {});
          send("tool_result", { tool: tu.name, ok: true });
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 8000) });
        } catch (e) {
          send("tool_result", { tool: tu.name, ok: false, error: String(e.message || e) });
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify({ error: String(e.message || e) }) });
        }
      }
      msgs.push({ role: "user", content: toolResults });
    }
    send("error", { message: "tool loop exceeded 8 turns" });
    res.end();
  } catch (err) {
    console.error("[/api/chat-agent]", err);
    send("error", { message: String(err.message || err) });
    res.end();
  }
};

app.post("/api/chat-agent", chatAgentHandler);

// /api/chat — 若員工有 tools，自動走 agent 流程
const _originalChatHandler = async (req, res) => {
  const { employeeId, messages } = req.body || {};
  const emp = EMPLOYEES[employeeId];
  if (emp?.tools?.length > 0) return chatAgentHandler(req, res);
  if (!emp) return res.status(400).json({ error: "Unknown employee" });
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: "messages required" });
  const send = setupSSE(res);
  if (!anthropic) {
    send("status", { text: "🟡 Demo 模式（未設定 API Key）" });
    send("delta", { text: `<div class="tldr">⚡ Demo 模式</div><p>請設定 ANTHROPIC_API_KEY 後重新部署</p>` });
    send("done", { ok: true });
    return res.end();
  }
  try {
    send("status", { text: `📥 ${emp.name} 收到任務` });
    const liveSystem = await maybeAugmentSystemPrompt(emp);
    const stream = await anthropic.messages.stream({
      model: MODEL,
      max_tokens: 4096,
      system: liveSystem,
      messages: messages.map(m => ({ role: m.role === "ai" ? "assistant" : m.role, content: typeof m.content === "string" ? m.content : String(m.content) })),
    });
    let full = "";
    stream.on("text", (delta) => { full += delta; send("delta", { text: delta }); });
    stream.on("error", (err) => { send("error", { message: String(err.message || err) }); res.end(); });
    await stream.finalMessage();
    send("done", { ok: true, length: full.length });

    // ── 員工互補刀 (partner-take) ──
    let _partnerTakes = [];
    try {
      const { partnerTake } = require('./partner-take');
      const lastUserMsg = (messages || []).filter(m => m.role !== 'assistant' && m.role !== 'ai').slice(-1)[0];
      const userQ = lastUserMsg ? (typeof lastUserMsg.content === 'string' ? lastUserMsg.content : String(lastUserMsg.content)) : '';
      _partnerTakes = await partnerTake({ EMPLOYEES, mainEmployeeId: employeeId, userQuestion: userQ, mainAnswer: full, send });
      send('partner_done', { count: _partnerTakes.length });
    } catch (e) { console.error('[partner-take chat]', e.message); }

    // 記錄到歷史
    try {
      const H = require('./history');
      const lastUser = (messages || []).filter(m => m.role !== 'assistant' && m.role !== 'ai').slice(-1)[0];
      const userText = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)) : '';
      // 員工代號對應到 history FN
      const fnMap = { victor:'VICTOR', leon:'CAMILLE', camille:'CAMILLE', aria:'CAMILLE', dex:'DEX', nova:'NOVA', milo:'CAMILLE', rina:'RINA', hana:'HANA', mira:'MIRA', june:'JUNE', sola:'SOLA', files:'FILES' };
      const fn = fnMap[(employeeId||'').toLowerCase()] || 'VICTOR';
      H.record({
        fn,
        title: emp.name + ' 對話 · ' + userText.replace(/<[^>]+>/g,' ').slice(0,40),
        html: '<h4>你問：</h4><p style="white-space:pre-wrap">'+userText.replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))+'</p><h4>'+emp.name+' 回覆：</h4><div>'+full+'</div>',
        text: userText.slice(0,500) + ' → ' + (full.replace(/<[^>]+>/g,' ').slice(0,1500)),
        meta: { employeeId, source: 'dashboard', partner_takes: _partnerTakes.map(t => ({ name: t.name, text: t.text })) }
      });
    } catch(e) { console.error('[history chat]', e.message); }
    res.end();
  } catch (err) {
    console.error("[/api/chat]", err);
    send("error", { message: String(err.message || err) });
    res.end();
  }
};

// ============================================================
// /api/proposals/:id/execute — 使用者確認後真正執行 write 動作
// ============================================================
app.post("/api/proposals/:id/execute", async (req, res) => {
  const p = PROPOSALS.get(req.params.id);
  if (!p) return res.status(404).json({ error: "proposal not found or expired" });
  const { override } = req.body || {};
  const input = override || p.toolInput;

  try {
    let result;
    switch (p.toolName) {
      case "propose_pause_ads":
        result = [];
        for (const adId of (input.adIds || [])) {
          try { await meta.pauseAd(adId); result.push({ adId, ok: true }); }
          catch (e) { result.push({ adId, ok: false, error: String(e.message || e) }); }
        }
        appendAction({ type: "ads-pause", reason: input.reason, count: result.length });
        break;
      case "propose_budget_changes":
        result = [];
        for (const c of (input.changes || [])) {
          try { await meta.updateAdSetBudget(c.adSetId, c.newDaily); result.push({ adSetId: c.adSetId, ok: true }); }
          catch (e) { result.push({ adSetId: c.adSetId, ok: false, error: String(e.message || e) }); }
        }
        appendAction({ type: "budget-change", count: result.length });
        break;
      case "propose_fb_post":
        if (input.imageUrl) result = await meta.publishFbPhoto({ imageUrl: input.imageUrl, message: input.caption });
        else result = await meta.publishFbPost({ message: input.caption, link: input.link });
        appendAction({ type: "fb-post-agent", preview: (input.caption||"").slice(0, 60) });
        break;
      case "propose_ig_post":
        result = await meta.publishIgImagePost({ imageUrl: input.imageUrl, caption: input.caption });
        appendAction({ type: "ig-post-agent", preview: (input.caption||"").slice(0, 60) });
        break;
      case "propose_line_reply": {
        const arr = loadLineMessages();
        const rec = arr.find(r => r.id === input.messageId);
        if (!rec) { result = { error: "message not found" }; break; }
        const msgs = line.buildMessages({ text: input.text, imageUrl: input.imageUrl, linkUrl: input.linkUrl, linkLabel: input.linkLabel });
        const ageMin = (Date.now() - new Date(rec.timestamp).getTime()) / 60000;
        if (ageMin < 30 && rec.replyToken) result = await line.replyMessage(rec.replyToken, msgs);
        else result = await line.pushMessage(rec.userId, msgs);
        rec.replied = true; rec.replyText = input.text; rec.repliedAt = new Date().toISOString();
        saveLineMessages(arr);
        appendAction({ type: "line-reply-agent", preview: input.text.slice(0, 60) });
        break;
      }
      case "propose_segment_push": {
        const list = customers.aggregateCustomers(customers.loadMessages(DATA_DIR), customers.loadCustomerProfiles(DATA_DIR));
        const groups = customers.groupBySegment(list);
        const targets = groups[input.segment] || [];
        const msgs = line.buildMessages({ text: input.text, imageUrl: input.imageUrl, linkUrl: input.linkUrl, linkLabel: input.linkLabel });
        result = [];
        for (const c of targets) {
          try { await line.pushMessage(c.userId, msgs); result.push({ userId: c.userId, ok: true }); }
          catch(e) { result.push({ userId: c.userId, ok: false, error: String(e.message||e) }); }
        }
        appendAction({ type: "segment-push-agent", segment: input.segment, count: targets.length });
        break;
      }
      default:
        return res.status(400).json({ error: "unknown proposal tool: " + p.toolName });
    }
    // 繼續對話 - 把 tool 結果塞回去讓員工總結
    const updatedMsgs = [...p.messages, { role: "user", content: [{ type: "tool_result", tool_use_id: p.toolUseId, content: JSON.stringify(result).slice(0, 4000) }] }];
    const followup = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: p.systemPrompt,
      tools: p.tools,
      messages: updatedMsgs,
    });
    const summary = (followup.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    PROPOSALS.delete(req.params.id);
    res.json({ ok: true, result, summary });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/chat", _originalChatHandler);
// ============================================================
// /api/orchestrate — Marketing Director mode
// ------------------------------------------------------------
// Phase 1: Director plans (returns JSON: {plan, assignments})
// Phase 2: All assigned workers run in PARALLEL
// Phase 3: Director consolidates final deliverable
// ============================================================
app.post("/api/orchestrate", async (req, res) => {
  const { task } = req.body || {};
  if (!task || typeof task !== "string")
    return res.status(400).json({ error: "task required" });

  const send = setupSSE(res);
  const director = EMPLOYEES.victor;
  const workerIds = Object.keys(EMPLOYEES).filter(id => id !== "victor");
  const workers = workerIds.map(id => EMPLOYEES[id]);

  if (!anthropic) {
    send("error", { message: "尚未設定 ANTHROPIC_API_KEY" });
    return res.end();
  }

  try {
    // ───────── Phase 1: Director planning ─────────
    send("phase", { phase: "planning", text: `👑 ${director.name} 正在分析任務並規劃分工…` });

    const planningPrompt = `Sam 剛交付以下任務：

「${task}」

請你以行銷總監身份，先做策略性思考，然後決定要分派給哪些團隊成員平行執行。

可分派的成員（你不能派給自己）：
${workers.map(w => `- ${w.id} · ${w.name} · ${w.role}：${w.bio}`).join("\n")}

請以 JSON 格式回覆，外面用 \`\`\`json ... \`\`\` 包覆，結構如下：
{
  "strategy": "你的策略思考（2–3 句）",
  "assignments": [
    { "employeeId": "leon", "task": "請 LEON 具體要做什麼（1–3 句）" },
    { "employeeId": "camille", "task": "..." }
  ]
}

原則：
- 至少分派給 3 位、最多 6 位成員（根據任務複雜度）
- 每個分派任務要具體、可執行
- 不要重複指派相同範圍給多人
- employeeId 必須來自上面的清單`;

    const planResp = await anthropic.messages.create({
      model: DIRECTOR_MODEL,
      max_tokens: 4096,
      system: director.systemPrompt,
      messages: [{ role: "user", content: planningPrompt }],
    });
    const planText = planResp.content.map(b => b.text || "").join("");
    const jsonMatch = planText.match(/```json\s*([\s\S]*?)\s*```/) || planText.match(/(\{[\s\S]*\})/);
    let plan;
    try {
      plan = JSON.parse(jsonMatch ? jsonMatch[1] : planText);
    } catch (e) {
      send("error", { message: "總監規劃 JSON 解析失敗" });
      return res.end();
    }
    if (!Array.isArray(plan.assignments) || plan.assignments.length === 0) {
      send("error", { message: "總監未產生有效分派" });
      return res.end();
    }
    // Filter out invalid assignments
    plan.assignments = plan.assignments.filter(a => EMPLOYEES[a.employeeId] && a.employeeId !== "victor");

    send("plan", {
      strategy: plan.strategy || "",
      assignments: plan.assignments.map(a => ({
        employeeId: a.employeeId,
        employeeName: EMPLOYEES[a.employeeId].name,
        employeeRole: EMPLOYEES[a.employeeId].role,
        emoji: EMPLOYEES[a.employeeId].emoji,
        color: EMPLOYEES[a.employeeId].color,
        task: a.task,
      })),
    });

    // ───────── Phase 2: Parallel execution ─────────
    send("phase", { phase: "executing", text: `🚀 ${plan.assignments.length} 位專員同時開工…` });

    const workerOutputs = {};
    const runWorker = async (assignment) => {
      const emp = EMPLOYEES[assignment.employeeId];
      const empId = assignment.employeeId;
      send("worker_start", { employeeId: empId, employeeName: emp.name });
      try {
        const liveSystem = await maybeAugmentSystemPrompt(emp);
        const stream = await anthropic.messages.stream({
          model: MODEL,
          max_tokens: 4096,
          system: liveSystem,
          messages: [{
            role: "user",
            content: `行銷總監 VICTOR 已將以下任務分派給你：\n\n「${assignment.task}」\n\n背景：Sam 原本交付的任務是「${task}」。\n請聚焦於你被分派的範圍，產出可立即使用的內容。`
          }],
        });
        let full = "";
        stream.on("text", (delta) => {
          full += delta;
          send("worker_delta", { employeeId: empId, text: delta });
        });
        await stream.finalMessage();
        workerOutputs[empId] = full;
        send("worker_done", { employeeId: empId, length: full.length });
      } catch (err) {
        console.error(`[orchestrate worker ${empId}]`, err);
        workerOutputs[empId] = `<p>⚠️ ${emp.name} 執行失敗：${err.message}</p>`;
        send("worker_error", { employeeId: empId, message: String(err.message || err) });
      }
    };

    // PARALLEL execution
    await Promise.all(plan.assignments.map(runWorker));

    // ───────── Phase 3: Director consolidation ─────────
    send("phase", { phase: "consolidating", text: `👑 ${director.name} 正在統整全團隊成果…` });

    const consolidationParts = plan.assignments.map(a => {
      const emp = EMPLOYEES[a.employeeId];
      return `### ${emp.name} · ${emp.role}\n分派任務：${a.task}\n\n成果：\n${workerOutputs[a.employeeId] || "(無回應)"}`;
    }).join("\n\n---\n\n");

    const consolidationPrompt = `你剛剛將以下任務分派給專員平行執行：

【Sam 原始任務】
${task}

【你的策略】
${plan.strategy}

【各專員成果】
${consolidationParts}

請以行銷總監身份，將以上專員成果整合成一份給 Sam 的高層級決策報告。

**輸出結構（嚴格按順序）：**

① <div class="tldr">⚡ TL;DR｜一句話結論</div>

② <h4>🎯 整體策略</h4>
2–3 句說明本次行動的核心主軸。

③ <h4>📋 各專員重點摘要</h4>
每位專員只摘要 2–3 個核心要點（不要重複貼原文）。用 <ul><li> 排版。

④ <div class="action-box">
  <h4>✅ SAM 本週待辦清單</h4>
  <p style="font-size:13px;opacity:0.85;">以下是你「本人」必須親自做的事（專員已經做的不要列在這）：</p>
  <ol class="action-list">
    <li><strong>[DEADLINE]</strong> 具體行動描述（為何要做、需要多久、做完交給誰）</li>
    …
  </ol>
</div>
待辦項目 3–6 個，每項必須含截止日（例：4/18 前、本週五前），並標註需要多久（10 分鐘/半天/1 天）。

⑤ <div class="decision-box">
  <h4>🤔 需要你現在決策的事</h4>
  <p style="font-size:13px;opacity:0.85;">以下決策必須你本人拍板，專員無法代決：</p>
  <div class="decision">
    <div class="d-title"><strong>決策 1：</strong>（決策主題）</div>
    <div class="d-ctx">背景脈絡 1–2 句</div>
    <ul class="d-options">
      <li><strong>方案 A：</strong>描述｜<em>優點：…</em>｜<em>缺點：…</em></li>
      <li><strong>方案 B：</strong>描述｜<em>優點：…</em>｜<em>缺點：…</em></li>
      <li><strong>方案 C：</strong>描述｜<em>優點：…</em>｜<em>缺點：…</em></li>
    </ul>
    <div class="d-reco">👑 <strong>VICTOR 建議：</strong>方案 X，因為…</div>
  </div>
  （1–3 個決策）
</div>

⑥ <h4>📦 需要你提供的資源</h4>
<ul><li>預算／素材／授權／帳號權限等等，清楚列出，沒有就寫「無」</li></ul>

**規則：**
- 全程使用 HTML 排版，可用 <h4>、<p>、<ul><li>、<ol><li>、<strong>、<em>、<table class="data">、以及上述 class
- 字數 900–1500 字
- 待辦清單裡的事必須是 Sam 本人可執行的（例如：確認預算、聯絡 KOL、上傳素材、批准文案），絕對不要把專員已經做完的事列進去
- 決策請示必須提供具體選項，不要只問「要不要做」這種是非題`;

    const finalStream = await anthropic.messages.stream({
      model: DIRECTOR_MODEL,
      max_tokens: 4096,
      system: director.systemPrompt,
      messages: [{ role: "user", content: consolidationPrompt }],
    });
    let finalText = "";
    finalStream.on("text", (delta) => {
      finalText += delta;
      send("summary_delta", { text: delta });
    });
    await finalStream.finalMessage();

    send("done", { ok: true, totalWorkers: plan.assignments.length, summaryLength: finalText.length });
    // 記錄整個 orchestrate 對話
    try {
      const H = require('./history');
      H.record({
        fn: 'VICTOR',
        title: 'VICTOR 分派 · ' + String(task).slice(0,40),
        html: '<h4>你交付：</h4><p style="white-space:pre-wrap">'+String(task).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))+'</p><h4>VICTOR 統整（分派給 '+plan.assignments.length+' 位專員後）：</h4><div>'+finalText+'</div>',
        text: String(task).slice(0,500) + ' → ' + finalText.replace(/<[^>]+>/g,' ').slice(0,1500),
        meta: { source: 'orchestrate', workers: plan.assignments.length }
      });
    } catch(e) { console.error('[history orchestrate]', e.message); }
    res.end();
  } catch (err) {
    console.error("[/api/orchestrate]", err);
    send("error", { message: String(err.message || err) });
    res.end();
  }
});

// ============================================================
// Reports & cron
// ============================================================
app.get("/api/reports", (req, res) => {
  const reports = JSON.parse(fs.readFileSync(REPORTS_FILE, "utf8"));
  res.json(reports.slice(-20).reverse());
});

const CRON_TZ = "Asia/Taipei";
async function runScheduledTask(empId, prompt, label) {
  if (!anthropic) return;
  const emp = EMPLOYEES[empId];
  if (!emp) return;
  console.log(`[cron:${label}] running ${emp.name}…`);
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: emp.systemPrompt,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content.map(b => b.text || "").join("");
    const reports = JSON.parse(fs.readFileSync(REPORTS_FILE, "utf8"));
    reports.push({
      id: Date.now(),
      createdAt: new Date().toISOString(),
      employeeId: empId,
      employeeName: emp.name,
      label, prompt, output: text,
    });
    fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2), "utf8");
    console.log(`[cron:${label}] ✅ done`);
  } catch (err) {
    console.error(`[cron:${label}]`, err);
  }
}

// === 自動發文相關 API ===
app.post('/api/auto-publish/run-now', async (req, res) => {
  try {
    const r = await autoPublish.generateAndQueueDrafts();
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post('/api/auto-publish/process-decisions', async (req, res) => {
  try {
    const r = await autoPublish.processDecidedDrafts();
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.get('/api/auto-publish/drafts', (req, res) => {
  try {
    const state = autoPublish.loadDrafts();
    res.json(state);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.get('/api/image-gen/recent', (req, res) => {
  try {
    const n = parseInt(req.query.n) || 20;
    res.json({ ok: true, images: imageGen ? imageGen.listRecent(n) : [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post('/api/image-gen/test', express.json(), async (req, res) => {
  if (!imageGen) return res.status(500).json({ ok: false, error: 'image-gen module missing' });
  try {
    const r = await imageGen.generateImage({
      caption: req.body.caption || '',
      brief: req.body.brief || '韓系精品馬卡龍 12 入禮盒',
      platform: req.body.platform || 'IG',
      slug: req.body.slug || 'test'
    });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// === 手動上傳圖片給某個草稿 ===
const imgUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { try { require('fs').mkdirSync(AUTO_IMG_DIR, { recursive: true }); } catch {} cb(null, AUTO_IMG_DIR); },
    filename: (req, file, cb) => {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const ext = (file.originalname.split('.').pop() || 'png').toLowerCase();
      cb(null, `manual-${ts}.${ext}`);
    }
  }),
  limits: { fileSize: 12 * 1024 * 1024 } // 12 MB
});
app.post('/api/auto-publish/upload-image/:draftId', imgUpload.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'no file uploaded' });
    const draftId = req.params.draftId;
    const state = autoPublish.loadDrafts();
    const draft = (state.drafts || []).find(d => d.id === draftId);
    if (!draft) return res.status(404).json({ ok: false, error: 'draft not found' });
    const filename = req.file.filename;
    const publicUrl = (process.env.SITE_URL || 'https://macaron-office.onrender.com').replace(/\/$/, '') + '/uploads/auto-images/' + filename;
    draft.image_url = publicUrl;
    draft.image_filename = filename;
    draft.image_source = 'manual';
    delete draft.image_error;
    require('fs').writeFileSync(require('path').join(__dirname, 'data', 'auto-drafts.json'), JSON.stringify(state, null, 2));
    res.json({ ok: true, draftId, image_url: publicUrl, filename });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// === 清空所有 pending 草稿 (標記為 dismissed,不會再被自動發) ===
app.post('/api/auto-publish/clear-pending', express.json(), async (req, res) => {
  try {
    const ap = require('./auto-publish');
    if (!ap.clearPendingDrafts) return res.status(500).json({ ok: false, error: 'clearPendingDrafts not available' });
    const r = ap.clearPendingDrafts();
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// === 手動將草稿標記為 approved (繞過 LINE 1ok 流程) ===
app.post('/api/auto-publish/approve/:draftId', express.json(), async (req, res) => {
  try {
    const draftId = req.params.draftId;
    const state = autoPublish.loadDrafts();
    const draft = (state.drafts || []).find(d => d.id === draftId);
    if (!draft) return res.status(404).json({ ok: false, error: 'draft not found' });
    if (draft.status === 'published') return res.json({ ok: true, already: true });
    if (draft.platform === 'IG' && !draft.image_url) return res.status(400).json({ ok: false, error: 'IG 草稿需要先上傳圖片' });
    // 直接發
    if (draft.platform === 'FB') {
      const r = await autoPublish.publishFB(draft.caption);
      draft.status = 'published';
      draft.published_at = new Date().toISOString();
      draft.publish_id = r.id;
    } else if (draft.platform === 'IG') {
      const r = await autoPublish.publishIG(draft.caption, draft.image_url);
      draft.status = 'published';
      draft.published_at = new Date().toISOString();
      draft.publish_id = r.id;
    }
    require('fs').writeFileSync(require('path').join(__dirname, 'data', 'auto-drafts.json'), JSON.stringify(state, null, 2));
    res.json({ ok: true, draft });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// === 刪掉某個草稿 ===
app.post('/api/auto-publish/delete/:draftId', (req, res) => {
  try {
    const draftId = req.params.draftId;
    const state = autoPublish.loadDrafts();
    state.drafts = (state.drafts || []).filter(d => d.id !== draftId);
    require('fs').writeFileSync(require('path').join(__dirname, 'data', 'auto-drafts.json'), JSON.stringify(state, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

autoPublish.registerCronJobs(cron);
try { require('./closer').registerCron(cron); } catch (e) { console.error('[closer cron]', e.message); }
try { require('./mira').registerCron(cron); } catch (e) { console.error('[mira cron]', e.message); }
try { require('./june').registerCron(cron); } catch (e) { console.error('[june cron]', e.message); }
try { require('./history').registerCron(cron); } catch (e) { console.error('[history cron]', e.message); }
// ── (2) self-eval 每晚 22:00 ──
try {
  const selfEval = require('./self-eval');
  if (selfEval && selfEval.registerCron) selfEval.registerCron(cron);
} catch(e) { console.warn('[self-eval] init', e.message); }

try { require('./memory').registerCron(cron); } catch (e) { console.error('[memory cron]', e.message); }
if (scout && typeof scout.registerCronJobs === 'function') scout.registerCronJobs(cron);
if (aiTeamContent && typeof aiTeamContent.registerCronJobs === 'function') aiTeamContent.registerCronJobs(cron);
cron.schedule("0 9 * * 1", () => {
  runScheduledTask("victor",
    "請產出本週的《團隊週策略簡報》：本週主軸、各專員的重點任務、預算分配、風險預警、3 個需要 Sam 決策的問題。",
    "weekly-strategy-brief");
}, { timezone: CRON_TZ });

cron.schedule("0 17 * * 5", () => {
  runScheduledTask("dex",
    "請產出本週廣告成效報告。若無實際數據請使用模擬數據並標註。",
    "weekly-analytics-report");
}, { timezone: CRON_TZ });

// ============================================================
// 主動推播：每日 09:00 早安簡報 + 每 30 分鐘事件監控
// ============================================================
cron.schedule("0 9 * * *", async () => {
  console.log("[alerts] running daily briefing...");
  try {
    const result = await alerts.dailyBriefing({
      anthropic, model: MODEL, employees: EMPLOYEES, meta, customers, dataDir: DATA_DIR, line,
    });
    console.log("[alerts] daily briefing:", result.pushed && result.pushed.ok ? "pushed" : "skipped (" + (result.pushed && result.pushed.reason || result.reason) + ")");
  } catch (err) {
    console.error("[alerts daily]", err);
  }
}, { timezone: CRON_TZ });

cron.schedule("*/30 * * * *", async () => {
  try {
    const result = await alerts.eventMonitor({
      anthropic, model: MODEL, employees: EMPLOYEES, meta, customers, dataDir: DATA_DIR, line,
    });
    if (result.alerts && result.alerts.length > 0) {
      console.log(`[alerts event] ${result.alerts.length} alerts pushed`);
    }
  } catch (err) {
    console.error("[alerts event]", err);
  }
}, { timezone: CRON_TZ });

// 每天 09:00 (Asia/Taipei) 自動發 1 篇 Medium 草稿（GIA 自動輪流 9 馬卡龍主題 + 6 費南雪主題）
cron.schedule('0 9 * * *', async () => {
  console.log('[GIA] daily auto-publish starting...');
  try {
    if (geo && geo.dailyAutoPublishToMedium) {
      const r = await geo.dailyAutoPublishToMedium();
      console.log('[GIA] auto-publish done:', r && r.ok, r && r.title);
    }
  } catch (e) { console.error('[GIA] auto-publish error:', e.message); }
}, { timezone: 'Asia/Taipei' });

// 每天 15:00 自動發第二篇
cron.schedule('0 15 * * *', async () => {
  console.log('[GIA] afternoon auto-publish starting...');
  try {
    if (geo && geo.dailyAutoPublishToMedium) {
      const r = await geo.dailyAutoPublishToMedium();
      console.log('[GIA] afternoon done:', r && r.ok, r && r.title);
    }
  } catch (e) { console.error('[GIA] afternoon error:', e.message); }
}, { timezone: 'Asia/Taipei' });

// 每天 08:30 VICTOR LINE 早報 — 直接打 LINE API

// =========================================
// 每週四 09:30 LEON 自我改進週報
// =========================================
cron.schedule('30 9 * * 4', async () => {
  console.log('[LEON brain] weekly run starting...');
  try {
    const brain = require('./leon-brain');
    const meta = (() => { try { return require('./meta'); } catch { return null; } })();
    if (!meta) { console.error('[LEON brain] meta module missing'); return; }
    const report = await brain.weeklyRun(meta);
    const msg = brain.formatForTelegram(report);
    // Push to Telegram admin
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChat = process.env.TELEGRAM_CHAT_ID;
    if (tgToken && tgChat) {
      await fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChat, text: msg })
      });
    }
    console.log('[LEON brain] done. Suggestions:', (report.suggestions || []).length);
  } catch (e) { console.error('[LEON brain] cron error:', e.message); }
}, { timezone: 'Asia/Taipei' });


// Mon-Fri 09:30 各員工輪流自我改進（VICTOR/CAMILLE/DEX/NOVA）
// LEON 已在週四上面有自己的 cron
cron.schedule('30 9 * * 1', async () => { runEmpBrain('victor', 'Monday 戰略總監'); }, { timezone: 'Asia/Taipei' });
cron.schedule('30 9 * * 2', async () => { runEmpBrain('camille', 'Tuesday 文案企劃'); }, { timezone: 'Asia/Taipei' });
cron.schedule('30 9 * * 3', async () => { runEmpBrain('dex', 'Wednesday 數據分析'); }, { timezone: 'Asia/Taipei' });
cron.schedule('30 9 * * 5', async () => { runEmpBrain('nova', 'Friday 品牌經理'); }, { timezone: 'Asia/Taipei' });

async function runEmpBrain(key, label) {
  console.log('[ai-brain ' + label + '] starting...');
  try {
    const brain = require('./ai-brain');
    const report = await brain.weeklyRun(key);
    const msg = brain.formatForTelegram(key, report);
    const tgToken = process.env.TELEGRAM_BOT_TOKEN, tgChat = process.env.TELEGRAM_CHAT_ID;
    if (tgToken && tgChat) {
      await fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChat, text: msg })
      });
    }
  } catch (e) { console.error('[ai-brain ' + label + '] error:', e.message); }
}

// 每 4 小時掃 CPL，超 NT$500 警報，超 NT$800 自動暫停
// ⚙️ 2026-05 Sam 要求關閉 Telegram CPL 警示。預設關閉。
//    想重新打開就設環境變數 CPL_WATCHDOG=on
if ((process.env.CPL_WATCHDOG || 'off').toLowerCase() === 'on') {
  cron.schedule('0 */4 * * *', async () => {
    try { const w = require('./cpl-watchdog'); await w.checkAndAlert(); }
    catch (e) { console.error('[cpl-watchdog cron]', e.message); }
  }, { timezone: 'Asia/Taipei' });
  console.log('[cpl-watchdog] cron registered (every 4h)');
} else {
  console.log('[cpl-watchdog] DISABLED (set CPL_WATCHDOG=on to re-enable)');
}

cron.schedule('30 8 * * *', async () => {
  console.log('[VICTOR] morning briefing cron firing...');
  try {
    const adminId = process.env.ADMIN_LINE_USER_ID;
    const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) && !(adminId && lineToken)) { console.warn('[VICTOR] no notification channel configured'); return; }
    let parts = ['🌅 溫點 WarmPlace 早安簡報 ' + new Date().toLocaleDateString('zh-TW')];
    try {
      const r = await fetch('https://macaron-office.onrender.com/api/roas/today').then(x => x.json());
      if (r && r.ok) parts.push('\n💰 過去 7 天: 詢問 ' + r.lead_count + ' · 新好友 ' + r.new_followers + (r.ad_spend ? ' · 廣告 NT$' + r.ad_spend : ''));
    } catch {}
    parts.push('\n📝 GIA 今日 9:00 + 15:00 各發 1 篇文章到 ofzbeautyacademy.com');
    parts.push('\n— VICTOR · 溫點 WarmPlace 行銷總監');
    const text = parts.join('');
    // Try Telegram first (free, no monthly limit), fall back to LINE
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChatId = process.env.TELEGRAM_CHAT_ID;
    let resp;
    if (tgToken && tgChatId) {
      resp = await fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChatId, text, parse_mode: 'HTML' })
      });
    } else {
      resp = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + lineToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: adminId, messages: [{ type: 'text', text }] })
      });
    }
    console.log('[VICTOR] LINE push status:', resp.status);
  } catch (e) { console.error('[VICTOR] error:', e.message); }
}, { timezone: 'Asia/Taipei' });



// ============================================================
// /api/line/* — LINE 客服 + 廣播 (T4.5)
// ============================================================
const LINE_MESSAGES_FILE = path.join(DATA_DIR, "line-messages.json");
if (!fs.existsSync(LINE_MESSAGES_FILE)) fs.writeFileSync(LINE_MESSAGES_FILE, "[]", "utf8");

function loadLineMessages() {
  try { return JSON.parse(fs.readFileSync(LINE_MESSAGES_FILE, "utf8")); } catch (e) { return []; }
}
function saveLineMessages(arr) {
  fs.writeFileSync(LINE_MESSAGES_FILE, JSON.stringify(arr.slice(-500), null, 2), "utf8");
}

async function handleLineEvent(event) {
  // 目前先處理文字訊息；圖片、貼圖可以之後擴充
  if (event.type !== "message") return;
  if (event.message.type !== "text") return;

  const userId = event.source && event.source.userId;
  const text = event.message.text;
  const replyToken = event.replyToken;
  const timestamp = new Date(event.timestamp).toISOString();

  let profile = null;
  if (userId) {
    try { profile = await line.getUserProfile(userId); } catch (e) {}
  }

  // /whoami — 回傳你的 LINE userId（拿去設 Render ADMIN_LINE_USER_ID env var）
  if (text.trim() === "/whoami" || text.trim() === "/me" || text.trim() === "/id") {
    if (userId) {
      try {
        await line.replyMessage(replyToken, [{
          type: "text",
          text: `👤 你的 LINE User ID：\n\n${userId}\n\n複製整段 → Render env var 設成 ADMIN_LINE_USER_ID`,
        }]);
      } catch (e) {}
    }
    return;
  }

  // 偵測 admin 註冊指令：使用者在 LINE Bot 對話傳「/admin」就把 userId 存起來
  if (text.trim() === "/admin" || text.trim() === "/admin註冊") {
    if (userId) {
      alerts.registerAdminFromLine(DATA_DIR, userId, profile && profile.displayName);
      try {
        await line.replyMessage(replyToken, [{
          type: "text",
          text: `✅ 已註冊為 admin！\n\n你的 LINE User ID：\n${userId}\n\n（這串 ID 也請複製貼到 Render env var「ADMIN_LINE_USER_ID」)\n\n你會收到：\n📊 每日早上 09:00 早安簡報\n⚠️ 廣告/客戶/預算 即時警示\n\n第一份簡報明天早上見。先傳「/admin test」可以馬上跑一份測試簡報。`,
        }]);
      } catch (e) {}
    }
    return;
  }

  // admin 手動觸發測試簡報
  if (text.trim() === "/admin test" || text.trim() === "/admin 測試") {
    const adminData = alerts.loadAdmin(DATA_DIR);
    if (!adminData.lineUserId || adminData.lineUserId !== userId) {
      try { await line.replyMessage(replyToken, [{ type: "text", text: "⚠️ 你不是 admin，請先傳 /admin 註冊" }]); } catch (e) {}
      return;
    }
    try { await line.replyMessage(replyToken, [{ type: "text", text: "🔄 正在跑早安簡報，30 秒內傳給你..." }]); } catch (e) {}
    alerts.dailyBriefing({ anthropic, model: MODEL, employees: EMPLOYEES, meta, customers, dataDir: DATA_DIR, line }).catch(err => console.error("[alerts test]", err));
    return;
  }

  // 偵測 admin 決策回覆「1ok / 1no / 1?」
  const decisionMatch = text.trim().match(/^([1-3])\s*(ok|no|\?)$/i);
  if (decisionMatch && userId) {
    const adminData = alerts.loadAdmin(DATA_DIR);
    if (adminData.lineUserId === userId) {
      const decisionNum = decisionMatch[1];
      const action = decisionMatch[2].toLowerCase();
      const actionLabel = action === "ok" ? "✅ 同意" : action === "no" ? "❌ 拒絕" : "🤔 要討論";
      try {
        const actionsFile = path.join(DATA_DIR, "actions.json");
        const arr = JSON.parse(fs.readFileSync(actionsFile, "utf8"));
        arr.push({
          id: Date.now(),
          type: "admin-decision",
          decisionNum,
          action,
          actionLabel,
          createdAt: new Date().toISOString(),
        });
        fs.writeFileSync(actionsFile, JSON.stringify(arr.slice(-200), null, 2), "utf8");
      } catch (e) { console.error("[admin-decision log]", e); }
      let replyText;
      if (action === "ok") {
        replyText = `${actionLabel} 決策 ${decisionNum}\n\n已記錄。VICTOR 會在下一份簡報納入這個答案，相關的執行（廣告調整、文案發佈、客人回覆）請到 https://macaron-office.onrender.com 找對應員工完成。`;
      } else if (action === "no") {
        replyText = `${actionLabel} 決策 ${decisionNum}\n\n已記錄為拒絕。VICTOR 明天會用新角度想對策。`;
      } else {
        replyText = `${actionLabel} 決策 ${decisionNum}\n\n打開 https://macaron-office.onrender.com 找 VICTOR 開始討論`;
      }
      try { await line.replyMessage(replyToken, [{ type: "text", text: replyText }]); } catch (e) {}
      return;
    }
  }

  // 用 Claude 分類意圖 + 寫草稿
  let classification = null;
  let draft = null;
  if (anthropic) {
    try {
      const sysPrompt = `你是 溫點 WarmPlace 的客服助理。
會收到客人的 LINE 訊息，請做兩件事並輸出 JSON：
1. 意圖分類：price / pickup / storage / gifting / complaint / product / other
2. 建議的回覆草稿（精品語調、直接切入、不囉嗦）

品牌資訊（用來回答）：
- 4 家門店：台南本店、新光西門 B2、新光中港 B2、新光南西 B2
- 主力商品：6 入禮盒 NT$880 / 12 入禮盒 NT$1,580 / 客製禮盒 NT$1,580-2,280 / 單顆 NT$80-100
- 保存期限:常溫 6 小時、冷藏 3 天、冷凍 7 天(建議盡早食用)
- 不含防腐劑，每日現做

輸出格式：
{"intent": "...", "draft": "..."}

直接回 JSON，不要前後綴、不要 markdown。`;
      const msg = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: sysPrompt,
        messages: [{ role: "user", content: text }],
      });
      const responseText = msg.content.map(b => b.text || "").join("").trim();
      const m = responseText.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        classification = parsed.intent || null;
        draft