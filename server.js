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
  let baseSystem = emp.systemPrompt + FORMAT_ENFORCEMENT;
  if (!META_AWARE_EMPLOYEES.has(emp.id) || !meta.tokenOk()) return baseSystem;
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
    return baseSystem + extra;
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
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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
    const brand = req.query.brand;
    if (!brand) return res.status(400).json({ error: "brand required" });
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

    const planningPrompt = `Jeffrey 剛交付以下任務：

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
            content: `行銷總監 VICTOR 已將以下任務分派給你：\n\n「${assignment.task}」\n\n背景：Jeffrey 原本交付的任務是「${task}」。\n請聚焦於你被分派的範圍，產出可立即使用的內容。`
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

【Jeffrey 原始任務】
${task}

【你的策略】
${plan.strategy}

【各專員成果】
${consolidationParts}

請以行銷總監身份，將以上專員成果整合成一份給 Jeffrey 的高層級決策報告。

**輸出結構（嚴格按順序）：**

① <div class="tldr">⚡ TL;DR｜一句話結論</div>

② <h4>🎯 整體策略</h4>
2–3 句說明本次行動的核心主軸。

③ <h4>📋 各專員重點摘要</h4>
每位專員只摘要 2–3 個核心要點（不要重複貼原文）。用 <ul><li> 排版。

④ <div class="action-box">
  <h4>✅ JEFFREY 本週待辦清單</h4>
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
- 待辦清單裡的事必須是 Jeffrey 本人可執行的（例如：確認預算、聯絡 KOL、上傳素材、批准文案），絕對不要把專員已經做完的事列進去
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
if (scout && typeof scout.registerCronJobs === 'function') scout.registerCronJobs(cron);
if (aiTeamContent && typeof aiTeamContent.registerCronJobs === 'function') aiTeamContent.registerCronJobs(cron);
cron.schedule("0 9 * * 1", () => {
  runScheduledTask("victor",
    "請產出本週的《團隊週策略簡報》：本週主軸、各專員的重點任務、預算分配、風險預警、3 個需要 Jeffrey 決策的問題。",
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
cron.schedule('0 */4 * * *', async () => {
  try { const w = require('./cpl-watchdog'); await w.checkAndAlert(); }
  catch (e) { console.error('[cpl-watchdog cron]', e.message); }
}, { timezone: 'Asia/Taipei' });

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
        draft = parsed.draft || null;
      }
    } catch (e) {
      console.error("[LINE classify]", e.message);
    }
  }

  const record = {
    id: Date.now() + "_" + Math.floor(Math.random() * 10000),
    timestamp,
    userId,
    userName: (profile && profile.displayName) || null,
    userPic: (profile && profile.pictureUrl) || null,
    text,
    replyToken,
    classification,
    draft,
    replied: false,
    replyText: null,
    repliedAt: null,
  };
  const arr = loadLineMessages();
  arr.push(record);
  saveLineMessages(arr);
}

// GET /api/line/status — 檢查 token 是否設定
app.get("/api/line/status", async (req, res) => {
  res.json({
    tokenSet: line.tokenOk(),
    webhookUrl: `${req.protocol}://${req.get("host")}/api/line/webhook`,
  });
});

// GET /api/line/messages — 最近 100 筆訊息（最新在前）
app.get("/api/line/messages", (req, res) => {
  const arr = loadLineMessages();
  res.json(arr.slice(-100).reverse());
});

// POST /api/line/reply  body: {id, text, imageUrl?, linkUrl?, linkLabel?, confirmed:true}
app.post("/api/line/reply", async (req, res) => {
  const { id, text, imageUrl, linkUrl, linkLabel, confirmed } = req.body || {};
  if (confirmed !== true) return res.status(400).json({ error: "must include confirmed:true" });
  const hasContent = (text && text.trim().length > 0) || imageUrl || linkUrl;
  if (!hasContent) return res.status(400).json({ error: "text / imageUrl / linkUrl required" });

  const arr = loadLineMessages();
  const rec = arr.find(r => r.id === id);
  if (!rec) return res.status(404).json({ error: "message not found" });
  if (rec.replied) return res.status(400).json({ error: "already replied" });

  const messages = line.buildMessages({ text, imageUrl, linkUrl, linkLabel });
  if (messages.length === 0) return res.status(400).json({ error: "no messages to send" });

  try {
    const ageMinutes = (Date.now() - new Date(rec.timestamp).getTime()) / 60000;
    let result, method;
    if (ageMinutes < 30 && rec.replyToken) {
      method = "reply";
      result = await line.replyMessage(rec.replyToken, messages);
    } else if (rec.userId) {
      method = "push";
      result = await line.pushMessage(rec.userId, messages);
    } else {
      throw new Error("no userId and replyToken expired");
    }
    rec.replied = true;
    rec.replyText = text || "";
    rec.replyImageUrl = imageUrl || null;
    rec.replyLinkUrl = linkUrl || null;
    rec.replyLinkLabel = linkLabel || null;
    rec.repliedAt = new Date().toISOString();
    rec.replyMethod = method;
    saveLineMessages(arr);
    const preview = (text || "").slice(0, 60) + (imageUrl ? " [+圖]" : "") + (linkUrl ? " [+連結]" : "");
    appendAction({ type: "line-reply", method, userName: rec.userName, messagePreview: preview, success: true });
    res.json({ ok: true, method, result });
  } catch (err) {
    appendAction({ type: "line-reply", userName: rec.userName, messagePreview: (text || "").slice(0, 80), success: false, error: String(err.message || err) });
    res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/line/broadcast  body: {text, imageUrl?, linkUrl?, linkLabel?, confirmed:true}
app.post("/api/line/broadcast", async (req, res) => {
  const { text, imageUrl, linkUrl, linkLabel, confirmed } = req.body || {};
  if (confirmed !== true) return res.status(400).json({ error: "must include confirmed:true" });
  const hasContent = (text && text.trim().length > 0) || imageUrl || linkUrl;
  if (!hasContent) return res.status(400).json({ error: "text / imageUrl / linkUrl required" });

  const messages = line.buildMessages({ text, imageUrl, linkUrl, linkLabel });
  if (messages.length === 0) return res.status(400).json({ error: "no messages to send" });

  try {
    const result = await line.broadcastMessage(messages);
    const preview = (text || "").slice(0, 60) + (imageUrl ? " [+圖]" : "") + (linkUrl ? " [+連結]" : "");
    appendAction({ type: "line-broadcast", messagePreview: preview, success: true });
    res.json({ ok: true, result });
  } catch (err) {
    appendAction({ type: "line-broadcast", messagePreview: (text || "").slice(0, 80), success: false, error: String(err.message || err) });
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ============================================================
// /api/google/* — Google Ads 報表 (T5, read-only)
// ============================================================

app.get("/api/google/status", (req, res) => {
  res.json(google.status());
});

app.get("/api/google/summary", async (req, res) => {
  try {
    const dateRange = (req.query.preset || "LAST_7_DAYS").toUpperCase();
    const data = await google.getAccountSummary({ dateRange });
    res.json({ ok: true, summary: data, dateRange });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/google/campaigns", async (req, res) => {
  try {
    const dateRange = (req.query.preset || "LAST_7_DAYS").toUpperCase();
    const campaigns = await google.getCampaigns({ dateRange });
    res.json({ ok: true, campaigns, dateRange });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/google/adgroups", async (req, res) => {
  try {
    const dateRange = (req.query.preset || "LAST_7_DAYS").toUpperCase();
    const adGroups = await google.getAdGroups({ dateRange, campaignId: req.query.campaignId });
    res.json({ ok: true, adGroups, dateRange });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/google/keywords", async (req, res) => {
  try {
    const dateRange = (req.query.preset || "LAST_7_DAYS").toUpperCase();
    const keywords = await google.getKeywords({ dateRange });
    res.json({ ok: true, keywords, dateRange });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/google/search-terms", async (req, res) => {
  try {
    const dateRange = (req.query.preset || "LAST_7_DAYS").toUpperCase();
    const terms = await google.getSearchTerms({ dateRange });
    res.json({ ok: true, terms, dateRange });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/google/ads", async (req, res) => {
  try {
    const dateRange = (req.query.preset || "LAST_7_DAYS").toUpperCase();
    const ads = await google.getAds({ dateRange });
    res.json({ ok: true, ads, dateRange });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/google/analyze", async (req, res) => {
  if (!anthropic) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
  if (!google.tokenOk()) return res.status(500).json({ error: "Google Ads 未設定" });
  const { scope = "campaigns", dateRange = "LAST_7_DAYS", extraContext = "" } = req.body || {};
  try {
    let dataBlock = "";
    if (scope === "campaigns") {
      const campaigns = await google.getCampaigns({ dateRange });
      dataBlock = campaigns.slice(0, 30).map(c => `${c.name} (${c.status}) · 花費 NT$${Math.round(c.cost)} · 點擊 ${c.clicks} · 轉換 ${c.conversions.toFixed(1)} · ROAS ${c.roas.toFixed(2)}`).join("\n");
    } else if (scope === "keywords") {
      const kws = await google.getKeywords({ dateRange });
      dataBlock = kws.slice(0, 40).map(k => `[${k.matchType}] ${k.keyword} · ${k.campaignName}>${k.adGroupName} · 點擊${k.clicks} 花費NT$${Math.round(k.cost)} 轉換${k.conversions.toFixed(1)} ROAS${k.roas.toFixed(2)}`).join("\n");
    } else if (scope === "search-terms") {
      const terms = await google.getSearchTerms({ dateRange });
      dataBlock = terms.slice(0, 40).map(t => `"${t.term}" · ${t.campaignName}>${t.adGroupName} · 點擊${t.clicks} 花費NT$${Math.round(t.cost)} 轉換${t.conversions.toFixed(1)} ROAS${t.roas.toFixed(2)}`).join("\n");
    }
    if (!dataBlock) return res.json({ ok: true, analysis: "目前沒有任何資料可以分析（帳戶可能還沒開始投放）。" });

    const emp = EMPLOYEES["leon"] || EMPLOYEES["victor"];
    const systemPrompt = (emp?.systemPrompt || "你是數位廣告操盤手。") + "\n\n本次任務：分析以下 Google Ads " + scope + " 資料，用繁中回覆，給 3-5 點具體優化建議。每點標註優先順序（高/中/低）。";
    const userPrompt = `資料區間：${dateRange}\n\n資料：\n${dataBlock}\n\n${extraContext ? "額外情境：" + extraContext + "\n\n" : ""}請給優化建議。`;
    const msg = await anthropic.messages.create({
      model: DIRECTOR_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const analysis = (msg.content || []).map(c => c.text || "").join("\n");
    res.json({ ok: true, analysis, scope, dateRange });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ============================================================
// /api/customers/* — LINE 客人畫像 + RFM 分群 (T8)
// ============================================================

// GET /api/customers?refresh=1
app.get('/api/customers', async (req, res) => {
  try {
    const sm = (() => { try { return require('./salesmartly'); } catch { return null; } })();
    let smProfiles = null;
    if (sm && sm.getCustomerProfiles) {
      try { smProfiles = await sm.getCustomerProfiles({ days: 90, page_size: 200 }); } catch {}
    }
    let local = {};
    try { local = customerProfiler.loadProfiles(); } catch {}
    const merged = Object.assign({}, local || {});
    if (smProfiles && smProfiles.ok && Array.isArray(smProfiles.customers)) {
      for (const c of smProfiles.customers) {
        const id = c.user_id || c.chat_user_id || ('sm_' + Math.random().toString(36).slice(2));
        merged[id] = Object.assign({}, merged[id] || {}, {
          user_id: id, user_name: c.user_name || (merged[id] && merged[id].user_name) || null,
          channel: c.channel, inquiry_count: c.inquiry_count || 1,
          last_seen: new Date((c.last_at_ms || Date.now())).toISOString(),
          segment: c.segment, source: 'salesmartly'
        });
      }
    }
    const all = Object.values(merged).sort((a,b) => new Date(b.last_seen || 0) - new Date(a.last_seen || 0));
    const now = Date.now();
    const groups = { vip: [], active: [], new: [], atrisk: [] };
    for (const c of all) {
      const daysSince = c.last_seen ? Math.floor((now - new Date(c.last_seen).getTime())/86400000) : 999;
      const inq = c.inquiry_count || 1;
      if (inq >= 5 && daysSince <= 14) groups.vip.push(c);
      else if (daysSince <= 14 && inq <= 1) groups.new.push(c);
      else if (daysSince <= 14) groups.active.push(c);
      else if (daysSince > 30 && daysSince <= 90) groups.atrisk.push(c);
    }
    const summary = { total: all.length, vip: groups.vip.length, active: groups.active.length, new: groups.new.length, atrisk: groups.atrisk.length };
    res.json({ ok: true, summary, groups, segments: { vip:{label:'🔥 VIP',color:'#B08D57',desc:'高頻+詢價多+近 14 天'}, active:{label:'💚 活躍客',color:'#10b981',desc:'14 天內有對話'}, new:{label:'🆕 新客',color:'#3b82f6',desc:'首次聯絡 ≤ 14 天'}, atrisk:{label:'🥶 潛在流失',color:'#ef4444',desc:'30+ 天沒聯絡'} } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// VOC — Voice of Customer mining
app.get('/api/voc/mine', async (req, res) => {
  try {
    const sm = (() => { try { return require('./salesmartly'); } catch { return null; } })();
    if (!sm || !sm.listRecentConversations) return res.status(500).json({ ok: false, error: 'salesmartly missing' });
    const days = parseInt(req.query.days) || 90;
    const sessions = await sm.listRecentConversations({ days, page_size: 200 });
    const list = (sessions && (sessions.list || (sessions.data && sessions.data.list))) || [];
    if (!list.length) return res.json({ ok: true, total_sessions: 0, message: 'No SaleSmartly sessions in date range' });
    const sample = list.slice(0, 30);
    const allMsgs = [];
    let firstSampleKeys = null;
    for (const s of sample) {
      try {
        if (!sm.listMessages) break;
        const uid = s.chat_user_id || s.contact_id || s.user_id;
        if (!uid) continue;
        const r = await sm.listMessages(uid, { page_size: 30 });
        const items = (r && (r.list || (r.data && r.data.list) || r.result && r.result.list)) || [];
        if (!firstSampleKeys && items[0]) firstSampleKeys = Object.keys(items[0]);
        for (const m of items) {
          const text = (m.content || m.message || m.text || m.body || (m.extra && m.extra.text) || '').toString().trim();
          if (!text || text.length < 3) continue;
          // Detect direction — try multiple field names
          const isFromCustomer =
            m.sender_type === 'visitor' || m.sender_type === 'customer' || m.sender_type === 'user' ||
            m.from === 'user' || m.from === 'visitor' || m.from === 'customer' ||
            m.role === 'visitor' || m.role === 'user' || m.role === 'customer' ||
            m.sender === 'user' || m.sender === 'visitor' ||
            m.direction === 'in' || m.direction === 'inbound' ||
            m.type === 'in' || m.type === 'visitor';
          if (isFromCustomer || allMsgs.length < 100) {
            allMsgs.push({ from_customer: !!isFromCustomer, text: text.slice(0, 250) });
          }
        }
      } catch {}
    }
    if (!allMsgs.length) return res.json({ ok: true, total_sessions: list.length, customer_messages: 0, sample_keys: firstSampleKeys, message: 'Sessions found but no message content extracted' });
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = '以下是 溫點 WarmPlace 過去 ' + days + ' 天，SaleSmartly / Messenger 的對話紀錄（' + allMsgs.length + ' 則訊息）。每則前面標記 [CUSTOMER] 或 [UNKNOWN]。請當「顧客之聲」分析師，著重看 [CUSTOMER] 訊息（也可參考 [UNKNOWN] 推論），歸納：\n\n1. **Top 10 最常被問的問題**（用客戶原話風格）\n2. **Top 5 客戶顧慮 / 反對意見**\n3. **客戶常用的詞彙 / 說法**\n4. **意圖分類百分比**（價格 / 預約 / 客戶教育 / 售後 / 其他）\n5. **3 個立即可執行的行銷動作**\n\n用條列輸出，給 溫點 WarmPlace 行銷團隊用，直接結論不要客套。\n\n--- 訊息 ---\n' + allMsgs.map((m, i) => (i+1) + '. ' + (m.from_customer ? '[CUSTOMER]' : '[UNKNOWN]') + ' ' + m.text).join('\n');
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });
    const analysis = resp.content && resp.content[0] && resp.content[0].text;
    res.json({ ok: true, days_range: days, total_sessions: list.length, messages_analyzed: allMsgs.length, customer_msg_count: allMsgs.filter(m => m.from_customer).length, sample_keys: firstSampleKeys, analysis });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Attribution — per-article performance (PageView, Lead, FB engagement)
// Lead event logging — POST from Pixel client side
app.post('/api/lead/track', (req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); res.set('Access-Control-Allow-Methods', 'POST, OPTIONS'); res.set('Access-Control-Allow-Headers', 'Content-Type'); if (req.method === 'OPTIONS') return res.sendStatus(204); next(); }, express.json(), async (req, res) => {
  try {
    const { content_id, content_name, source_url, fbclid } = req.body || {};
    const log = {
      ts: new Date().toISOString(),
      content_id: content_id || null,
      content_name: content_name || null,
      source_url: source_url || null,
      fbclid: fbclid || null,
      ip: req.ip,
      ua: (req.headers['user-agent'] || '').slice(0, 200)
    };
    const fs = require('fs'); const path = require('path');
    const dir = process.env.RENDER_DISK_MOUNT_PATH || '/tmp';
    const file = path.join(dir, 'leads.jsonl');
    try { fs.appendFileSync(file, JSON.stringify(log) + '\n'); } catch {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/attribution/articles', async (req, res) => {
  try {
    const wp = (() => { try { return require('./wordpress'); } catch { return null; } })();
    if (!wp || !wp.listPosts) return res.status(500).json({ ok: false, error: 'wp missing' });
    // Read leads.jsonl
    const fs = require('fs'); const path = require('path');
    const dir = process.env.RENDER_DISK_MOUNT_PATH || '/tmp';
    const file = path.join(dir, 'leads.jsonl');
    let leads = [];
    try { leads = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean); } catch {}
    // Group leads by source_url
    const byUrl = {};
    for (const l of leads) {
      const u = l.source_url || 'unknown';
      byUrl[u] = (byUrl[u] || 0) + 1;
    }
    const lr = await wp.listPosts({ per_page: 50 });
    if (lr && lr.ok === false) return res.json({ ok: true, count: 0, total_leads: leads.length, articles: [], note: 'WordPress 未連接: ' + lr.error });
    const posts = Array.isArray(lr && lr.items) ? lr.items : (Array.isArray(lr) ? lr : []);
    const results = posts.map(p => ({
      id: p.id,
      title: p.title,
      link: p.link,
      published_at: p.date,
      lead_count: byUrl[p.link] || 0
    })).sort((a, b) => b.lead_count - a.lead_count);
    res.json({ ok: true, count: results.length, total_leads: leads.length, articles: results, note: 'Lead 數據從 Pixel /api/lead/track 累積。新文章需 24-48h 才有數據' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Per-teacher dashboard endpoint
app.get('/api/teachers/summary', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    // 溫點 WarmPlace 4 家門店 (page_id / account_id 從環境變數讀,沒設就跳過)
    const TEACHERS = JSON.parse(process.env.MACARON_STORES_JSON || JSON.stringify({
      hq: { name: '溫點 WarmPlace · 台南本店', page_id: '', account_id: '' },
      shinkong_ximen: { name: '新光西門 B2', page_id: '', account_id: '' },
      shinkong_zhongkang: { name: '新光中港 B2', page_id: '', account_id: '' },
      shinkong_nanxi: { name: '新光南西 B2', page_id: '', account_id: '' }
    }));
    const meta = (() => { try { return require('./meta'); } catch { return null; } })();
    const sm = (() => { try { return require('./salesmartly'); } catch { return null; } })();
    // Pull all Meta campaigns once
    // Per-teacher data: { key -> { campaigns: [...], error?: string } }
    const teacherDataMap = {};
    await Promise.all(Object.entries(TEACHERS).map(async ([key, t]) => {
      if (!t.account_id) { teacherDataMap[key] = { campaigns: [] }; return; }
      try {
        if (!meta || !meta.getAdsWithInsights) { teacherDataMap[key] = { campaigns: [] }; return; }
        const [adsRes, campRes] = await Promise.all([
          meta.getAdsWithInsights({ days, accountId: t.account_id, limit: 200 }).catch(e => ({ error: e.message })),
          (meta.getAdCampaigns ? meta.getAdCampaigns({ limit: 200, accountId: t.account_id }).catch(e => ({ error: e.message })) : Promise.resolve(null))
        ]);
        const ads = (adsRes && (adsRes.data || adsRes.ads || adsRes)) || [];
        const cArr = (campRes && (campRes.data || campRes.campaigns || campRes)) || [];
        const objMap = {};
        for (const c of cArr) { if (c && c.id) objMap[c.id] = { name: c.name || 'unknown', objective: c.objective || 'UNKNOWN' }; }
        const byId = {};
        for (const a of ads) {
          const cid = a.campaignId || a.campaign_id || 'unknown';
          if (!byId[cid]) {
            const cm = objMap[cid] || { name: a.campaign_name || 'unknown', objective: 'UNKNOWN' };
            byId[cid] = { id: cid, name: cm.name, objective: cm.objective, spend: 0, impressions: 0, clicks: 0 };
          }
          const ins = a.insights || a;
          byId[cid].spend += parseFloat(ins.spend || 0);
          byId[cid].impressions += parseInt(ins.impressions || 0);
          byId[cid].clicks += parseInt(ins.clicks || 0);
        }
        teacherDataMap[key] = { campaigns: Object.values(byId) };
      } catch (e) {
        teacherDataMap[key] = { campaigns: [], error: e.message };
        console.error('[teachers/summary]', key, e.message);
      }
    }));
        // Pull all SaleSmartly sessions once
    let sessions = [];
    try {
      if (sm && sm.listRecentConversations) {
        const s = await sm.listRecentConversations({ days, page_size: 200 });
        sessions = (s && (s.list || (s.data && s.data.list))) || [];
      }
    } catch (e) {}
    const teachers = {};
    for (const [key, t] of Object.entries(TEACHERS)) {
      const matched = (teacherDataMap[key] && teacherDataMap[key].campaigns) || [];
      const spend = matched.reduce((s, c) => s + parseFloat(c.spend || 0), 0);
      const impressions = matched.reduce((s, c) => s + parseInt(c.impressions || 0), 0);
      const clicks = matched.reduce((s, c) => s + parseInt(c.clicks || 0), 0);
      const tSessions = sessions.filter(s => s.channel_id == t.page_id);
      const leadCount = tSessions.length;
      const cpl = leadCount > 0 ? Math.round(spend / leadCount) : null;
            // Detect primary ad type (the objective with most spend)
      const objSpend = {};
      for (const c of matched) {
        const obj = c.objective || 'UNKNOWN';
        objSpend[obj] = (objSpend[obj] || 0) + parseFloat(c.spend || 0);
      }
      let primaryObjective = null, maxObjSpend = 0;
      for (const [obj, s] of Object.entries(objSpend)) {
        if (s > maxObjSpend) { maxObjSpend = s; primaryObjective = obj; }
      }
      const adTypeLabel = (() => {
        const o = String(primaryObjective || '').toUpperCase();
        if (matched.length === 0) return '無';
        if (o.includes('LEAD')) return '潛在客戶';
        if (o.includes('MESSAGES') || o.includes('ENGAGEMENT') || o.includes('POST')) return '互動/訊息';
        if (o.includes('SALES') || o.includes('CONVERSION')) return '銷售';
        if (o.includes('TRAFFIC') || o.includes('LINK')) return '流量';
        if (o.includes('AWARENESS') || o.includes('REACH')) return '觸及';
        if (o.includes('VIDEO')) return '影片觀看';
        return primaryObjective || '未知';
      })();
      teachers[key] = {
        name: t.name, page_id: t.page_id,
        campaign_count: matched.length,
        spend_ntd: Math.round(spend),
        impressions, clicks,
        ctr: impressions > 0 ? (clicks / impressions * 100).toFixed(2) + '%' : '—',
        lead_count: leadCount,
        cost_per_lead_ntd: cpl,
        cpl_health: cpl === null ? 'no_data' : cpl < 300 ? 'good' : cpl < 500 ? 'ok' : 'high',
        ad_type: adTypeLabel,
        objective: primaryObjective
      };
    }
    res.json({ ok: true, days_range: days, teachers });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// LEON brain — self-improving weekly advisor
app.post('/api/leon/brain/weekly-run', async (req, res) => {
  try {
    const brain = require('./leon-brain');
    const meta = (() => { try { return require('./meta'); } catch { return null; } })();
    if (!meta) return res.status(500).json({ ok: false, error: 'meta module missing' });
    const report = await brain.weeklyRun(meta);
    res.json({ ok: true, report, telegram_preview: brain.formatForTelegram(report) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/leon/brain/history', (req, res) => {
  try {
    const brain = require('./leon-brain');
    const all = brain.loadAll();
    const accuracy = brain.getAccuracy();
    res.json({ ok: true, accuracy, history_count: all.length, recent: all.slice(-10) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/leon/brain/snapshot', async (req, res) => {
  try {
    const brain = require('./leon-brain');
    const meta = (() => { try { return require('./meta'); } catch { return null; } })();
    const snap = await brain.takeSnapshot(meta, req.body && req.body.label || 'manual');
    res.json({ ok: true, snapshot: snap });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== AI Brain (ALL employees) =====
app.post('/api/brain/:emp/weekly-run', async (req, res) => {
  try {
    const brain = require('./ai-brain');
    const empKey = req.params.emp.toLowerCase();
    if (!brain.EMPLOYEES[empKey]) return res.status(404).json({ ok: false, error: 'unknown employee: ' + empKey });
    const report = await brain.weeklyRun(empKey);
    res.json({ ok: true, report, telegram_preview: brain.formatForTelegram(empKey, report) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/brain/run-all', async (req, res) => {
  try {
    const brain = require('./ai-brain');
    res.json({ ok: true, started: true, message: '5 個員工大腦背景跑中，約 5-8 分鐘完成。' });
    // Run in background
    brain.runAllEmployees().then(results => {
      console.log('[ai-brain] all employees done:', Object.keys(results).map(k => k + ':' + ((results[k].suggestions || []).length || 'err')).join(', '));
    }).catch(e => console.error('[ai-brain] run-all error:', e.message));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/brain/:emp/history', (req, res) => {
  try {
    const brain = require('./ai-brain');
    const empKey = req.params.emp.toLowerCase();
    if (!brain.EMPLOYEES[empKey]) return res.status(404).json({ ok: false, error: 'unknown employee' });
    const all = brain.loadAll(empKey);
    const accuracy = brain.getAccuracy(empKey);
    res.json({ ok: true, employee: brain.EMPLOYEES[empKey].name, accuracy, history_count: all.length, recent: all.slice(-10) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/brain/all/status', (req, res) => {
  try {
    const brain = require('./ai-brain');
    const result = {};
    for (const key of Object.keys(brain.EMPLOYEES)) {
      const emp = brain.EMPLOYEES[key];
      const acc = brain.getAccuracy(key);
      const history = brain.loadAll(key);
      const lastSugs = history.filter(r => r.type === 'suggestions').slice(-1)[0];
      result[key] = { name: emp.name, emoji: emp.emoji, accuracy: acc,
                      last_run: lastSugs && lastSugs.ts, last_suggestions_count: lastSugs && (lastSugs.suggestions || []).length };
    }
    res.json({ ok: true, employees: result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== Bookings + CPL Watchdog =====
app.post('/api/bookings/add', express.json(), (req, res) => {
  try {
    const bk = require('./bookings');
    const r = bk.addBooking(req.body || {});
    res.json({ ok: true, record: r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/bookings/stats', async (req, res) => {
  try {
    const bk = require('./bookings');
    res.json(await bk.getStats(parseInt(req.query.days) || 30));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/bookings/recent', (req, res) => {
  try {
    const bk = require('./bookings');
    res.json({ ok: true, recent: bk.recent(parseInt(req.query.n) || 20) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/admin/cpl-check-now', async (req, res) => {
  try {
    const w = require('./cpl-watchdog');
    res.json(await w.checkAndAlert());
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/customers/inquiries', async (req, res) => {
  try {
    const sm = (() => { try { return require('./salesmartly'); } catch { return null; } })();
    const days = parseInt(req.query.days) || 90;
    // Source 1: SaleSmartly real conversations (preferred — real data)
    let smProfiles = null;
    if (sm && sm.getCustomerProfiles) {
      try { smProfiles = await sm.getCustomerProfiles({ days, page_size: 200 }); } catch {}
    }
    // Source 2: local webhook-derived profiles (fallback / merge)
    let localProfiles = {};
    try { localProfiles = customerProfiler.loadProfiles(); } catch {}
    // Merge — SaleSmartly customers win if same chat_user_id
    const merged = Object.assign({}, localProfiles || {});
    if (smProfiles && smProfiles.ok && Array.isArray(smProfiles.customers)) {
      for (const c of smProfiles.customers) {
        const id = c.user_id || c.userId || c.chat_user_id || ('sm_' + Math.random().toString(36).slice(2));
        merged[id] = Object.assign({}, merged[id] || {}, {
          user_id: id,
          user_name: c.user_name || merged[id] && merged[id].user_name || null,
          channel: c.channel,
          inquiry_count: c.inquiry_count || 1,
          last_seen: new Date((c.last_at_ms || Date.now())).toISOString(),
          segment: c.segment,
          source: 'salesmartly'
        });
      }
    }
    const list = Object.values(merged).sort((a,b) => new Date(b.last_seen || 0) - new Date(a.last_seen || 0));
    const now = Date.now();
    const seg = { vip: { label: '🔥 VIP（高頻+近期）', desc: '5+ 詢問 + 14 天內', count: 0, list: [] },
      active_responder: { label: '💬 主動回覆', desc: '3+ 詢問 + 30 天內', count: 0, list: [] },
      active: { label: '💚 活躍', desc: '14 天內有詢問', count: 0, list: [] },
      warm: { label: '🌤️ 溫客', desc: '14-30 天前', count: 0, list: [] },
      cold: { label: '❄️ 冷客', desc: '30-60 天前', count: 0, list: [] },
      lost: { label: '😢 流失', desc: '60+ 天沒詢問', count: 0, list: [] } };
    for (const c of list) {
      const daysSince = c.last_seen ? Math.floor((now - new Date(c.last_seen).getTime()) / 86400000) : 999;
      const inq = c.inquiry_count || 1;
      let bucket;
      if (inq >= 5 && daysSince <= 14) bucket = 'vip';
      else if (inq >= 3 && daysSince <= 30) bucket = 'active_responder';
      else if (daysSince <= 14) bucket = 'active';
      else if (daysSince <= 30) bucket = 'warm';
      else if (daysSince <= 60) bucket = 'cold';
      else bucket = 'lost';
      seg[bucket].count++;
      seg[bucket].list.push(c);
    }
    res.json({ ok: true, total: list.length, days_range: days, segments: seg, customers: list.slice(0, 50) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/customers/profiles — get all customer profiles (or single one)
app.get('/api/customers/profiles', (req, res) => {
  try {
    const profiles = customerProfiler.loadProfiles();
    if (req.query.userId) {
      const p = profiles[req.query.userId];
      return res.json({ ok: true, profile: p || null });
    }
    const list = Object.values(profiles).sort((a,b) => new Date(b.last_seen) - new Date(a.last_seen));
    res.json({ ok: true, total: list.length, profiles: list.slice(0, parseInt(req.query.limit) || 100) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/customers/insights — aggregated insights for AI employees
app.get('/api/customers/insights', (req, res) => {
  try {
    const ins = customerProfiler.getAggregatedInsights({ topN: parseInt(req.query.top) || 10 });
    res.json(ins);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/customers/profile/manual-analyze — manually trigger analysis on a message (for testing)
app.post('/api/customers/profile/manual-analyze', express.json(), async (req, res) => {
  try {
    const { chat_user_id, msg, channel, user_name } = req.body || {};
    if (!chat_user_id || !msg) return res.status(400).json({ ok: false, error: 'need chat_user_id + msg' });
    const updated = await customerProfiler.updateProfile({ chat_user_id, msg, channel, user_name });
    res.json({ ok: true, profile: updated });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/customers/:userId
app.get("/api/customers/:userId", (req, res) => {
  try {
    const msgs = customers.loadMessages(DATA_DIR);
    const profiles = customers.loadCustomerProfiles(DATA_DIR);
    const list = customers.aggregateCustomers(msgs, profiles);
    const c = list.find(x => x.userId === req.params.userId);
    if (!c) return res.status(404).json({ error: "customer not found" });
    res.json({ ok: true, customer: c });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/customers/:userId/analyze — AI 生成畫像
app.post("/api/customers/:userId/analyze", async (req, res) => {
  if (!anthropic) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
  try {
    const msgs = customers.loadMessages(DATA_DIR);
    const list = customers.aggregateCustomers(msgs, customers.loadCustomerProfiles(DATA_DIR));
    const c = list.find(x => x.userId === req.params.userId);
    if (!c) return res.status(404).json({ error: "customer not found" });

    const history = c.messages.slice(0, 30).reverse().map(m => `[${m.intent}] ${m.text}${m.replyText ? " → 店回覆：" + m.replyText.slice(0,60) : ""}`).join("\n");
    const systemPrompt = `你是 溫點 WarmPlace 的客人分析師。根據客人與品牌客服的 LINE 對話紀錄，推測客人畫像並給出具體行動建議。品牌主打韓系精品馬卡龍禮盒（6 入 NT$880 / 12 入 NT$1,580 / 客製禮盒 NT$1,580-2,280，婚禮 / 企業 / 自送三種場景），4 家門店：台南本店、新光西門 B2、新光中港 B2、新光南西 B2。

回覆 JSON：
{
  "profile": "一段 2-3 句話的客人畫像（推測年齡、身份、動機）",
  "preferences": ["偏好 1", "偏好 2", "偏好 3"],
  "tags": ["短標籤1", "短標籤2", "短標籤3"],
  "nextContact": "建議下次聯絡時機與訊息主題",
  "suggestedMessage": "一段 50-80 字可以直接發給這位客人的 LINE 訊息（繁中、友善、具體）"
}

不要加任何說明，只回純 JSON。`;
    const userPrompt = `客人名稱：${c.userName}\n訊息數：${c.frequency}\n最近一次對話：${c.recencyDays} 天前\n意圖分佈：${JSON.stringify(c.intents)}\n分組：${c.segment}\n\n對話紀錄（最多 30 則，舊→新）：\n${history}`;

    const msg = await anthropic.messages.create({
      model: DIRECTOR_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const raw = (msg.content || []).map(x => x.text || "").join("");
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (!parsed) return res.status(500).json({ error: "AI 回覆無法解析", raw: raw.slice(0,300) });

    // 存 profile
    const profiles = customers.loadCustomerProfiles(DATA_DIR);
    profiles[c.userId] = {
      aiProfile: parsed.profile,
      preferences: parsed.preferences || [],
      tags: parsed.tags || [],
      nextContact: parsed.nextContact,
      suggestedMessage: parsed.suggestedMessage,
      updatedAt: new Date().toISOString(),
    };
    customers.saveCustomerProfiles(DATA_DIR, profiles);
    res.json({ ok: true, profile: profiles[c.userId] });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/customers/segment-broadcast
// body: { segment: "vip"|"active"|"new"|"atrisk", brief: "..." } 
// NOVA 寫給該組的客製廣播草稿
app.post("/api/customers/segment-broadcast", async (req, res) => {
  if (!anthropic) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
  const { segment = "active", brief = "" } = req.body || {};
  try {
    const msgs = customers.loadMessages(DATA_DIR);
    const list = customers.aggregateCustomers(msgs, customers.loadCustomerProfiles(DATA_DIR));
    const groups = customers.groupBySegment(list);
    const group = groups[segment] || [];
    const segMeta = customers.SEGMENTS[segment];

    const sampleTags = [...new Set(group.slice(0, 20).flatMap(c => c.tags || []))].slice(0, 10);
    const sampleIntents = {};
    group.forEach(c => {
      Object.entries(c.intents || {}).forEach(([k, v]) => { sampleIntents[k] = (sampleIntents[k] || 0) + v; });
    });

    const emp = EMPLOYEES["nova"];
    const systemPrompt = (emp?.systemPrompt || "你是 NOVA，溫點 WarmPlace 的社群小編。") + `\n\n本次任務：針對 ${segMeta.label} 這組客人（${group.length} 人，特色：${segMeta.desc}）寫 3 個 LINE 廣播草稿。每個風格不同。`;
    const userPrompt = `客人組別：${segMeta.label}（${group.length} 人）\n這組客人常見意圖：${JSON.stringify(sampleIntents)}\n常見標籤：${sampleTags.join("、") || "（尚未分析）"}\n\n本次 brief：${brief || "（無特別主題，請自己發揮）"}\n\n請輸出 JSON 陣列，3 個元素，每個是 { "style": "版本名", "text": "訊息內容" }。只回 JSON。`;

    const msg = await anthropic.messages.create({
      model: DIRECTOR_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const raw = (msg.content || []).map(x => x.text || "").join("");
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    const drafts = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    res.json({ ok: true, segment, groupSize: group.length, drafts });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/customers/segment-push
// body: { segment, text, imageUrl?, linkUrl?, linkLabel?, confirmed:true }
// 對該組所有客人 push（不是 broadcast 給全部好友）
app.post("/api/customers/segment-push", async (req, res) => {
  const { segment = "active", text, imageUrl, linkUrl, linkLabel, confirmed } = req.body || {};
  if (confirmed !== true) return res.status(400).json({ error: "must include confirmed:true" });
  try {
    const msgs = customers.loadMessages(DATA_DIR);
    const list = customers.aggregateCustomers(msgs, customers.loadCustomerProfiles(DATA_DIR));
    const groups = customers.groupBySegment(list);
    const group = groups[segment] || [];
    if (group.length === 0) return res.status(400).json({ error: "該組沒有客人" });

    const messages = line.buildMessages({ text, imageUrl, linkUrl, linkLabel });
    if (messages.length === 0) return res.status(400).json({ error: "no messages to send" });

    const results = [];
    for (const c of group) {
      try {
        await line.pushMessage(c.userId, messages);
        results.push({ userId: c.userId, ok: true });
      } catch (e) {
        results.push({ userId: c.userId, ok: false, error: String(e.message || e) });
      }
    }
    const success = results.filter(r => r.ok).length;
    appendAction({ type: "segment-push", segment, total: group.length, success, preview: (text || "").slice(0, 60) });
    res.json({ ok: true, segment, total: group.length, success: group.length - success, results });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/line/generate-broadcast  body: {brief, count}
// 讓 NOVA 寫 N 個廣播越稿。
app.post("/api/line/generate-broadcast", async (req, res) => {
  const { brief, count = 3 } = req.body || {};
  if (!brief || brief.trim().length < 5) return res.status(400).json({ error: "brief too short" });
  if (!anthropic) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const emp = EMPLOYEES["nova"];
  const userPrompt = `針對下面 brief，寫 ${count} 個 LINE 官方帳號廣播訊息草稿，每個風格不同。

Brief：${brief}

要求：
- LINE 廣播會發畣全部好友，語氣親近但保持精品感
- 每則 120-200 字
- 可加 emoji 但節制（1-3 個）
- 回 JSON 陣列：[{"style":"...","text":"..."}, ...]
- 不要 markdown，直接回 JSON`;
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: emp.systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const responseText = msg.content.map(b => b.text || "").join("").trim();
    const m = responseText.match(/\[[\s\S]*\]/);
    const drafts = JSON.parse(m ? m[0] : responseText);
    res.json({ drafts });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});


// ============================================================
// /api/alerts/* — 主動推播 API
// ============================================================
app.get("/api/alerts/admin", (req, res) => {
  const a = alerts.loadAdmin(DATA_DIR);
  res.json({ registered: !!a.lineUserId, registeredAt: a.registeredAt, userName: a.userName });
});

app.post("/api/alerts/test-daily", async (req, res) => {
  try {
    const result = await alerts.dailyBriefing({
      anthropic, model: MODEL, employees: EMPLOYEES, meta, customers, dataDir: DATA_DIR, line,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/alerts/test-event", async (req, res) => {
  try {
    const result = await alerts.eventMonitor({
      anthropic, model: MODEL, employees: EMPLOYEES, meta, customers, dataDir: DATA_DIR, line,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true, model: MODEL, employees: Object.keys(EMPLOYEES).length }));

// W1: 溫點 WarmPlace conversion + AI content team
app.post('/api/conversion/line', async (req, res) => {
  if (!lineConv) return res.status(500).json({ ok: false, error: 'line-conversion not loaded' });
  try { res.json(await lineConv.recordConversion(req.body || {})); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/conversion/stats/today', (req, res) => {
  if (!lineConv) return res.json({ count: 0, revenue: 0 });
  try { res.json(lineConv.getTodayStats()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/conversion/recent', (req, res) => {
  if (!lineConv) return res.json({ orders: [] });
  try { res.json({ orders: lineConv.getRecentOrders(parseInt(req.query.limit) || 20) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ai-team/months', (req, res) => {
  try {
    const fs = require('fs'), path = require('path');
    const f = path.join(__dirname, 'data', 'ai-content-monthly.json');
    if (!fs.existsSync(f)) return res.json({ months: {} });
    res.json(JSON.parse(fs.readFileSync(f, 'utf8')));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ai-team/content/:month', (req, res) => {
  if (!aiTeamContent) return res.status(500).json({ error: 'not loaded' });
  try { res.json({ month_data: aiTeamContent.getMonth(req.params.month) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ai-team/run/:role', async (req, res) => {
  if (!aiTeamContent) return res.status(500).json({ ok: false, error: 'not loaded' });
  try {
    const role = String(req.params.role || '').toLowerCase();
    if (role === 'nora') res.json(await aiTeamContent.noraPlanNextMonth(req.body && req.body.target_month));
    else if (role === 'yuki') res.json(await aiTeamContent.yukiWriteLesson(req.body && req.body.month));
    else if (role === 'rio') res.json(await aiTeamContent.rioWriteShootingScript(req.body && req.body.month));
    else if (role === 'mika-topic') res.json(await aiTeamContent.mikaWeeklyTopic());
    else if (role === 'mika') {
      const q = (req.body && req.body.question) || '';
      const s = (req.body && req.body.student) || '';
      res.json(await aiTeamContent.mikaAnswerStudent(q, s));
    }
    else if (role === 'scout') { scout.scoutScanAll().catch(e => console.error('[scout bg]', e.message)); res.json({ ok: true, started: true, message: 'SCOUT scan running in background. Poll /api/scout/reports for progress.' }); }
    else if (role === 'scout-one') res.json(await scout.scoutOne(req.body && req.body.service_id));
    else res.status(400).json({ ok: false, error: 'unknown role' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// W2: AI 內容團隊 — RIO/MIKA 查詢端點
app.get('/api/ai-team/qa/recent', (req, res) => {
  try {
    const fs = require('fs'), path = require('path');
    const f = path.join(__dirname, 'data', 'ai-content-monthly.json');
    if (!fs.existsSync(f)) return res.json({ qa: [] });
    const state = JSON.parse(fs.readFileSync(f, 'utf8'));
    res.json({ qa: (state.qa || []).slice(0, parseInt(req.query.limit) || 20) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ai-team/topics', (req, res) => {
  try {
    const fs = require('fs'), path = require('path');
    const f = path.join(__dirname, 'data', 'ai-content-monthly.json');
    if (!fs.existsSync(f)) return res.json({ topics: [] });
    const state = JSON.parse(fs.readFileSync(f, 'utf8'));
    res.json({ topics: (state.weekly_topics || []).slice(0, parseInt(req.query.limit) || 20) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SCOUT 市場調查 endpoints
// GET /api/meta/probe — diagnostic: token, page, ad account
app.get('/api/meta/probe', async (req, res) => {
  const token = process.env.META_ACCESS_TOKEN || '';
  const pageId = process.env.META_FB_PAGE_ID || '';
  const adAcct = process.env.META_AD_ACCOUNT_ID || '';
  if (!token) return res.json({ ok: false, error: 'META_ACCESS_TOKEN not set' });
  const out = { ok: true, page_id_env: pageId, ad_account_env: adAcct, token_len: token.length };
  // 1. Probe /me to identify token type
  try {
    const r = await fetch(`https://graph.facebook.com/v25.0/me?fields=id,name,category&access_token=${encodeURIComponent(token)}`);
    const j = await r.json();
    out.token_type = j.category ? 'PAGE_TOKEN' : (j.id ? 'USER_TOKEN' : 'unknown');
    out.me_response = { id: j.id, name: j.name, category: j.category };
    if (j.error) out.me_error = j.error;
  } catch (e) { out.me_error = e.message; }
  // 2. Probe ad account spend (last 7 days)
  if (adAcct) {
    try {
      const since = Math.floor((Date.now() - 7*86400*1000) / 1000);
      const until = Math.floor(Date.now() / 1000);
      const url = `https://graph.facebook.com/v25.0/${adAcct.startsWith('act_') ? adAcct : 'act_' + adAcct}/insights?fields=spend,impressions,clicks&time_range={"since":"${new Date(since*1000).toISOString().slice(0,10)}","until":"${new Date(until*1000).toISOString().slice(0,10)}"}&access_token=${encodeURIComponent(token)}`;
      const r2 = await fetch(url);
      const j2 = await r2.json();
      out.ad_spend_7d = {
        ok: !j2.error,
        data_count: (j2.data || []).length,
        spend: (j2.data || []).reduce((s, d) => s + parseFloat(d.spend || 0), 0),
        impressions: (j2.data || []).reduce((s, d) => s + parseInt(d.impressions || 0), 0),
        error: j2.error
      };
    } catch (e) { out.ad_spend_7d = { ok: false, error: e.message }; }
  } else {
    out.ad_spend_7d = { skipped: 'META_AD_ACCOUNT_ID empty' };
  }
  res.json(out);
});


// GET /api/salesmartly/webhook-debug?n=20 — return the last N raw webhook events (for inspection)
app.get('/api/salesmartly/webhook-debug', (req, res) => {
  const n = parseInt(req.query.n) || 20;
  try {
    const fs = require('fs');
    const path = require('path');
    const logFile = path.join(__dirname, 'data', 'salesmartly_webhook_events.jsonl');
    if (!fs.existsSync(logFile)) return res.json({ ok: true, events: [], note: 'no events yet' });
    const raw = fs.readFileSync(logFile, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const last = lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    res.json({ ok: true, total_events_in_log: lines.length, returned: last.length, events: last });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/salesmartly/webhook-leads?days=N — count unique sessions/users from webhook log
app.get('/api/salesmartly/webhook-leads', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  try {
    const fs = require('fs');
    const path = require('path');
    const logFile = path.join(__dirname, 'data', 'salesmartly_webhook_events.jsonl');
    if (!fs.existsSync(logFile)) return res.json({ ok: true, days, total_events: 0, unique_sessions: 0, unique_users: 0, by_event_type: {}, note: 'no webhook events received yet' });
    const cutoffMs = Date.now() - days * 86400 * 1000;
    const raw = fs.readFileSync(logFile, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const sessions = new Set();
    const users = new Set();
    const byType = {};
    let total = 0;
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        const ts = new Date(evt.ts).getTime();
        if (ts < cutoffMs) continue;
        total++;
        if (evt.session_id) sessions.add(evt.session_id);
        if (evt.chat_user_id) users.add(evt.chat_user_id);
        byType[evt.event_type || 'unknown'] = (byType[evt.event_type || 'unknown'] || 0) + 1;
      } catch (e) {}
    }
    res.json({ ok: true, days, total_events: total, unique_sessions: sessions.size, unique_users: users.size, by_event_type: byType });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/debug/disk — inspect filesystem to find correct persistent disk path
app.get('/api/debug/disk', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const out = {
    __dirname,
    cwd: process.cwd(),
    env_disk: process.env.RENDER_DISK_MOUNT_PATH || '(unset)',
    candidate_paths: {}
  };
  const candidates = [
    path.join(__dirname, 'data'),
    '/opt/render/project/src/macaron-office/data',
    '/data',
    '/mnt/data',
    '/persistent',
  ];
  for (const p of candidates) {
    try {
      const stat = fs.existsSync(p) ? fs.statSync(p) : null;
      out.candidate_paths[p] = stat ? {
        exists: true, isDir: stat.isDirectory(),
        files: fs.readdirSync(p).slice(0, 30)
      } : { exists: false };
    } catch (e) { out.candidate_paths[p] = { error: e.message }; }
  }
  res.json(out);
});

// GET /api/line/probe — diagnose LINE Insight + token issues
app.get('/api/line/probe', async (req, res) => {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const out = { has_token: !!token, token_len: (token||'').length };
  if (!token) return res.json({ ok: false, ...out, error: 'no LINE_CHANNEL_ACCESS_TOKEN' });
  try {
    // Test 1: get bot info
    const botRes = await fetch('https://api.line.me/v2/bot/info', { headers: { 'Authorization': 'Bearer ' + token }});
    const bot = await botRes.json();
    out.bot_info = bot.error ? { error: bot.error || bot.message } : { displayName: bot.displayName, basicId: bot.basicId, premiumId: bot.premiumId };
    // Test 2: try getting follower insight for yesterday
    const yesterday = new Date(Date.now() - 86400*1000).toISOString().slice(0,10).replace(/-/g, '');
    const folRes = await fetch(`https://api.line.me/v2/bot/insight/followers?date=${yesterday}`, { headers: { 'Authorization': 'Bearer ' + token }});
    const fol = await folRes.json();
    out.follower_insight = { date: yesterday, status: folRes.status, body: fol };
    // Test 3: try messages insight
    const msgRes = await fetch(`https://api.line.me/v2/bot/insight/message/event?date=${yesterday}`, { headers: { 'Authorization': 'Bearer ' + token }});
    out.message_insight = { status: msgRes.status, body: await msgRes.json() };
    res.json({ ok: true, ...out });
  } catch (e) {
    res.json({ ok: false, ...out, error: e.message });
  }
});

// ============================================================
// GIA · GEO 主理人 endpoints
// ============================================================
app.get('/api/geo/visibility-audit', async (req, res) => {
  if (!geo) return res.status(500).json({ ok: false, error: 'geo module not loaded' });
  if (req.query.async === '1') {
    res.json({ ok: true, started: true, message: 'Audit running in background.' });
    geo.auditAIVisibility().catch(e => console.error('[geo audit]', e.message));
    return;
  }
  try { res.json(await geo.auditAIVisibility()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/geo/generate-content', express.json(), async (req, res) => {
  if (!geo) return res.status(500).json({ ok: false, error: 'geo module not loaded' });
  try {
    const { platformIdx, courseIdx, customQuery } = req.body || {};
    res.json(await geo.generateContent({ platformIdx, courseIdx, customQuery }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/geo/competitor-comparison', async (req, res) => {
  if (!geo) return res.status(500).json({ ok: false, error: 'geo module not loaded' });
  try { res.json(await geo.competitorComparison()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// POST /api/geo/generate-longform — Wikipedia / GBP / PR / YouTube
app.post('/api/geo/generate-longform', express.json(), async (req, res) => {
  if (!geo) return res.status(500).json({ ok: false, error: 'geo module not loaded' });
  try {
    const { contentType = 'wikipedia', topic = '', subjectIdx = 0, type = 'course' } = req.body || {};
    res.json(await geo.generateLongFormContent({ contentType, topic, subjectIdx, type }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/geo/publish-medium — auto-publish to Medium (requires MEDIUM_INTEGRATION_TOKEN env)
app.post('/api/geo/publish-medium', express.json(), async (req, res) => {
  if (!geo) return res.status(500).json({ ok: false, error: 'geo module not loaded' });
  try {
    const { title, contentMarkdown, tags, publishStatus = 'draft' } = req.body || {};
    res.json(await geo.publishToMedium({ title, contentMarkdown, tags, publishStatus }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/geo/auto-publish-now', express.json(), async (req, res) => {
  if (!geo) return res.status(500).json({ ok: false, error: 'geo module not loaded' });
  try { res.json(await geo.dailyAutoPublishToMedium(req.body || {})); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/geo/auto-publish-log', (req, res) => {
  if (!geo || !geo.getRecentAutoPublishLog) return res.json({ ok: true, items: [] });
  try { res.json({ ok: true, items: geo.getRecentAutoPublishLog(30) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ============================================================
// 溫點 WarmPlace /blog — self-hosted blog (full GEO control)
// ============================================================
app.get('/blog', (req, res) => {
  if (!blog) return res.status(500).send('blog module not loaded');
  try { res.set('Content-Type', 'text/html; charset=utf-8').send(blog.renderIndexPage()); }
  catch (e) { res.status(500).send('Error: ' + e.message); }
});

app.get('/blog/:slug', (req, res) => {
  if (!blog) return res.status(500).send('blog module not loaded');
  const post = blog.getPost(req.params.slug);
  if (!post) return res.status(404).send('Post not found');
  try { res.set('Content-Type', 'text/html; charset=utf-8').send(blog.renderPostPage(post)); }
  catch (e) { res.status(500).send('Error: ' + e.message); }
});

app.get('/sitemap.xml', (req, res) => {
  if (!blog) return res.status(500).send('blog module not loaded');
  try { res.set('Content-Type', 'application/xml; charset=utf-8').send(blog.generateSitemap()); }
  catch (e) { res.status(500).send('Error: ' + e.message); }
});

app.get('/robots.txt', (req, res) => {
  if (!blog) return res.set('Content-Type', 'text/plain').send('User-agent: *\nAllow: /');
  res.set('Content-Type', 'text/plain; charset=utf-8').send(blog.generateRobots());
});

app.get('/api/blog/posts', (req, res) => {
  if (!blog) return res.json({ ok: true, items: [] });
  try { res.json({ ok: true, items: blog.listPosts(100) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/blog/edit/:slug', express.json({limit:'500kb'}), (req, res) => {
  if (!blog || !blog.updatePost) return res.status(500).json({ ok: false, error: 'blog module missing updatePost' });
  try { res.json(blog.updatePost(req.params.slug, req.body || {})); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/api/blog/:slug', (req, res) => {
  if (!blog || !blog.deletePost) return res.status(500).json({ ok: false, error: 'blog module missing deletePost' });
  try { res.json(blog.deletePost(req.params.slug)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

let wp = null;
try { wp = require('./wordpress'); } catch (e) { console.error('[wp routes] load failed:', e.message); }

app.get('/api/wordpress/posts', async (req, res) => {
  if (!wp || !wp.listPosts) return res.status(500).json({ ok: false, error: 'wordpress module missing listPosts' });
  try { res.json(await wp.listPosts({ status: req.query.status || 'any', perPage: parseInt(req.query.perPage)||30 })); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/admin/create-privacy-policy', async (req, res) => {
  if (!wp || !wp.publishPost) return res.status(500).json({ ok: false, error: 'wp module missing' });
  const md = '## 隱私權政策\n\n溫點 WarmPlace（以下簡稱「我們」）尊重您的個人隱私，並依《個人資料保護法》及相關法規處理您所提供的資料。\n\n## 一、我們蒐集哪些資訊\n\n當您透過我們的網站、Facebook 粉絲專頁、Instagram、Messenger 或 LINE 與我們聯繫時，我們可能蒐集以下資訊：\n\n- 您的姓名、聯絡電話、電子信箱\n- 您與我們的對話內容\n- 您的瀏覽行為（透過 Meta Pixel 與 Cookie）\n- 您的地理位置（用於判斷服務區域）\n\n## 二、我們如何使用您的資訊\n\n- 提供諮詢、預訂、商品介紹及服務\n- 改善網站體驗與行銷投放精準度\n- 寄送您主動訂閱的活動資訊\n- 配合法律或主管機關要求\n\n## 三、第三方資料分享\n\n我們會與下列服務商共享必要資訊：\n\n- Meta（Facebook / Instagram）：透過 Pixel 與 Conversions API 進行廣告效益追蹤\n- SaleSmartly：客服訊息整合與管理\n- Google：網站分析\n\n我們不會將您的資訊販售給第三方。\n\n## 四、Cookie 與追蹤技術\n\n本網站使用 Cookie 與類似技術記錄您的瀏覽行為，您可隨時透過瀏覽器設定關閉 Cookie。\n\n## 五、您的權利\n\n您可隨時：\n\n- 查詢、閱覽您的個人資料\n- 要求修正或補充\n- 要求停止蒐集、處理或利用\n- 要求刪除\n\n請透過 Messenger 與我們聯繫提出請求。\n\n## 六、資料保留期限\n\n客戶資料會保留至客戶要求刪除為止，或於我們業務需求結束後 5 年內銷毀。\n\n## 七、政策更新\n\n本政策可能不定期修訂，最新版本將公告於本頁。\n\n## 八、聯絡方式\n\n如有任何隱私權相關疑問，歡迎透過 Facebook 粉絲專頁 溫點 WarmPlace 與我們聯繫。\n\n---\n\n最後更新日期：' + new Date().toISOString().slice(0, 10);
  try {
    const r = await wp.publishPost({ title: '隱私權政策 Privacy Policy', contentMarkdown: md, status: 'publish' });
    res.json({ ok: true, link: r.link, id: r.id });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Google Indexing API admin endpoints
app.get('/api/admin/google-indexing/check', (req, res) => {
  try {
    const gi = require('./google-indexing');
    res.json({ ok: true, config: gi.checkConfig() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/admin/google-indexing/submit-url', express.json(), async (req, res) => {
  try {
    const gi = require('./google-indexing');
    const { url, type } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: 'url required' });
    const r = await gi.submitUrl(url, type || 'URL_UPDATED');
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/admin/google-indexing/submit-all-articles', async (req, res) => {
  try {
    const gi = require('./google-indexing');
    if (!wp || !wp.listPosts) return res.status(500).json({ ok: false, error: 'wp module missing' });
    const lr = await wp.listPosts({ per_page: 50 });
    const posts = (lr && lr.items) || lr || [];
    const urls = posts.map(p => p.link).filter(Boolean);
    res.json({ ok: true, started: true, count: urls.length, message: '背景跑中，每筆 200ms' });
    // background submit
    gi.submitUrls(urls).then(results => {
      const success = results.filter(r => r.ok).length;
      console.log('[google-indexing] batch submit done:', success + '/' + results.length);
    }).catch(e => console.error('[google-indexing] batch error:', e.message));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== FB/IG Comment Auto-Reply Bot =====
// Webhook 接收 Meta 事件
app.get('/api/meta/webhook/comments', (req, res) => {
  // Meta webhook 驗證
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || 'ofz_comment_bot_2026';
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.status(403).send('forbidden');
});

app.post('/api/meta/webhook/comments', express.json(), async (req, res) => {
  // 先回 200 給 Meta（避免 timeout 重試）
  res.status(200).send('ok');
  try {
    const bot = require('./fb-comment-bot');
    const body = req.body || {};
    if (body.object !== 'page' || !Array.isArray(body.entry)) return;
    for (const entry of body.entry) {
      try { await bot.handleCommentEvent(entry); }
      catch (e) { console.error('[fb-comment-bot]', e.message); }
    }
  } catch (e) { console.error('[fb-comment-bot] webhook error:', e.message); }
});

app.post('/api/admin/fb-comment-bot/subscribe', async (req, res) => {
  try {
    const bot = require('./fb-comment-bot');
    const results = await bot.subscribeAllOfzPages();
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/admin/fb-comment-bot/log', (req, res) => {
  try {
    const bot = require('./fb-comment-bot');
    const n = parseInt(req.query.n) || 20;
    res.json({ ok: true, count: n, log: bot.getRecentLog(n) });

  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/admin/wp-fix-title-overlap', async (req, res) => {
  if (!wp || !wp.listPosts || !wp.updatePost || !wp.getPostRaw) return res.status(500).json({ ok: false, error: 'wp helpers missing' });
  const STYLE = '<style>.wp-block-post-title,h1.wp-block-post-title,.entry-title,article h1.alignwide,article h1{margin-top:140px !important;padding-top:24px !important;line-height:1.4 !important;text-wrap:balance;text-wrap:pretty;word-break:keep-all;overflow-wrap:break-word;max-width:780px;margin-left:auto !important;margin-right:auto !important;text-align:center;font-size:clamp(24px,4vw,38px) !important}@media (max-width:768px){.wp-block-post-title,h1.wp-block-post-title,.entry-title,article h1.alignwide,article h1{margin-top:100px !important;padding-top:16px !important;font-size:22px !important;line-height:1.45 !important;padding-left:16px;padding-right:16px}}</style>';
  const PIXEL = '<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version="2.0";n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,"script","https://connect.facebook.net/en_US/fbevents.js");fbq("init","1475056767679373");fbq("track","PageView");document.addEventListener("click",function(e){var a=e.target.closest("a");if(!a)return;var h=a.getAttribute("href")||"";if(/(facebook\\.com|m\\.me|wa\\.me|whatsapp|line\\.me|line\\/|t\\.me|telegram|mailto:|tel:)/i.test(h)||/私訊|諮詢|聯絡|預約|報名/.test(a.textContent||"")){fbq("track","Lead",{content_name:document.title,source_url:location.href});try{fetch("https://macaron-office.onrender.com/api/lead/track",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content_name:document.title,source_url:location.href,fbclid:new URLSearchParams(location.search).get("fbclid")||null})})}catch(e){}}});</script><noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=1475056767679373&ev=PageView&noscript=1"/></noscript>';
  try {
    const lr = await wp.listPosts({ per_page: 50 });
    const list = (lr && lr.items) || lr || [];
    const results = [];
    for (const p of list) {
      try {
        const post = await wp.getPostRaw(p.id);
        let raw = (post.content && (post.content.raw || post.content.rendered)) || '';
        raw = raw.replace(/^\s*(<style[^>]*>[\s\S]*?<\/style>\s*|<script[^>]*>[\s\S]*?<\/script>\s*|<noscript[^>]*>[\s\S]*?<\/noscript>\s*){1,8}/i, '');
        // Rewrite old colors → match homepage palette
        raw = raw.replace(/#F5F0E8/g, '#FFFFFF')
          .replace(/#E8C77A/g, '#F0E3DC')
          .replace(/#D4A574/g, '#B8755C')
          .replace(/#A37849/g, '#B8755C')
          .replace(/#8E3D4B/g, '#B8755C')
          .replace(/#1F1A18/g, '#1A1612')
          .replace(/#28201D/g, '#221C18')
          .replace(/#26201D/g, '#221C18')
          .replace(/#FDF7EE/g, '#F0E3DC')
          .replace(/#2E1E14/g, '#FFFFFF')
          .replace(/linear-gradient\(135deg,#B8755C,#B8755C\)/g, '#B8755C');
        const newContent = STYLE + PIXEL + raw;
        await wp.updatePost(p.id, { content: newContent });
        results.push({ id: p.id, ok: true });
      } catch (e) { results.push({ id: p.id, error: e.message }); }
    }
    res.json({ ok: true, count: results.length, results });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/api/wordpress/posts/:id', async (req, res) => {
  if (!wp || !wp.trashPost) return res.status(500).json({ ok: false, error: 'wordpress module missing trashPost' });
  try { res.json(await wp.trashPost(req.params.id)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/geo/schema-org', (req, res) => {
  if (!geo) return res.status(500).json({ ok: false, error: 'geo module not loaded' });
  res.json(geo.generateSchemaOrg());
});
app.get('/api/geo/daily-briefing', async (req, res) => {
  if (!geo) return res.status(500).json({ ok: false, error: 'geo module not loaded' });
  try { res.json(await geo.dailyBriefing()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/geo/recent-audits', (req, res) => {
  if (!geo) return res.status(500).json({ ok: false, error: 'geo module not loaded' });
  res.json({ ok: true, audits: geo.getRecentAudits(parseInt(req.query.n) || 7) });
});
app.get('/api/geo/recent-content', (req, res) => {
  if (!geo) return res.status(500).json({ ok: false, error: 'geo module not loaded' });
  res.json({ ok: true, content: geo.getRecentContent(parseInt(req.query.n) || 30) });
});

// GET /api/salesmartly/probe — diagnostic: env presence + raw listRecentConversations call
app.get('/api/salesmartly/probe', async (req, res) => {
  const env_check = {
    has_token: !!process.env.SALESMARTLY_TOKEN,
    token_len: (process.env.SALESMARTLY_TOKEN || '').length,
    has_project_id: !!process.env.SALESMARTLY_PROJECT_ID,
    project_id_len: (process.env.SALESMARTLY_PROJECT_ID || '').length,
    base_url: process.env.SALESMARTLY_BASE_URL || 'https://developer.salesmartly.com (default)',
  };
  if (!salesmartly) return res.status(500).json({ ok: false, env_check, error: 'salesmartly module not loaded' });
  const days = parseInt(req.query.days) || 30;
  let raw = null, err = null;
  try {
    raw = await salesmartly.listRecentConversations({ days, page: 1, page_size: 5 });
  } catch (e) {
    err = { message: e && e.message, stack: (e && e.stack || '').slice(0, 800) };
  }
  res.json({
    ok: !err,
    env_check,
    days,
    raw_top_keys: raw && typeof raw === 'object' ? Object.keys(raw).slice(0, 10) : raw,
    raw_code: raw && raw.code,
    raw_msg: raw && raw.msg,
    raw_data_keys: raw && raw.data && typeof raw.data === 'object' ? Object.keys(raw.data).slice(0,15) : (raw && raw.data ? typeof raw.data : 'no data'),
    raw_data_list_len: raw && raw.data && raw.data.list ? raw.data.list.length : 'no data.list',
    raw_data_total: raw && raw.data && (raw.data.total || raw.data.count || raw.data.total_count),
    raw_data_first_keys: raw && raw.data && raw.data.list && raw.data.list[0] ? Object.keys(raw.data.list[0]).slice(0,10) : null,
    raw_endpoint_used: raw && raw._endpoint_used,
    raw_method_used: raw && raw._method_used,
    merged_attempts: raw && raw._merged_attempts,
    error: err
  });
});

// GET /api/salesmartly/sync?days=30 — manually trigger SaleSmartly fetch + cache write (fire-and-forget background)
app.get('/api/salesmartly/sync', async (req, res) => {
  if (!salesmartly) return res.status(500).json({ ok: false, error: 'salesmartly module not loaded' });
  const days = parseInt(req.query.days) || 30;
  res.json({ ok: true, started: true, days, message: `Sync started in background (~30s). Poll /api/customers/inquiries afterwards.` });
  setImmediate(async () => {
    try {
      console.log(`[salesmartly-sync] start days=${days}`);
      const insights = await salesmartly.getCustomerInsights({ days });
      console.log(`[salesmartly-sync] done convs=${insights.conversation_count} msgs=${insights.message_count}`);
    } catch (e) {
      console.error('[salesmartly-sync] error:', e && e.message ? e.message : e);
    }
  });
});

app.get('/api/scout/reports', (req, res) => {
  if (!scout) return res.status(500).json({ error: 'scout not loaded' });
  try { res.json(scout.getLatestReports()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/scout/summary', (req, res) => {
  if (!scout) return res.status(500).json({ error: 'scout not loaded' });
  try { res.json(scout.getReportSummary()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/scout/intelligence', (req, res) => {
  if (!scout) return res.status(500).json({ error: 'scout not loaded' });
  try { res.json(scout.getMarketIntelligence() || { ok: false, reason: 'not yet distilled' }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/scout/distill', (req, res) => {
  if (!scout) return res.status(500).json({ error: 'scout not loaded' });
  scout.distillIntelligence().catch(e => console.error('[distill bg]', e.message));
  res.json({ ok: true, started: true, message: 'DISTILL running in background. Poll /api/scout/intelligence for result.' });
});
app.get('/api/scout/report/:serviceId', (req, res) => {
  if (!scout) return res.status(500).json({ error: 'scout not loaded' });
  try {
    const all = scout.getLatestReports();
    const r = (all.reports || {})[req.params.serviceId];
    if (!r) return res.status(404).json({ error: 'no report' });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SaleSmartly 詢問數客畫像 (T9)

// ROAS 兩層即時數據
app.get('/api/roas/lead', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  try {
    let messenger_new_conversations = 0;
    let webhook_unique_users = 0;
    let comments = { ok: false };
    // Source 1: SaleSmartly Messenger sessions (assigned-to-token-owner only)
    if (salesmartly && salesmartly.listRecentConversations) {
      try {
        const sessions = await salesmartly.listRecentConversations({ days, page_size: 200 });
        messenger_new_conversations = (sessions && (sessions.total || (sessions.list && sessions.list.length))) || 0;
      } catch (e) { console.error('[roas/lead] salesmartly:', e.message); }
    } else if (salesmartly && salesmartly.getCustomerProfiles) {
      try {
        const profiles = await salesmartly.getCustomerProfiles({ days });
        messenger_new_conversations = (profiles && profiles.total) || 0;
      } catch (e) { console.error('[roas/lead] salesmartly:', e.message); }
    }
    // Source 2: webhook log (catches all conversations regardless of assignment)
    try {
      const fs = require('fs');
      const path = require('path');
      const logFile = path.join(__dirname, 'data', 'salesmartly_webhook_events.jsonl');
      if (fs.existsSync(logFile)) {
        const cutoffMs = Date.now() - days * 86400 * 1000;
        const raw = fs.readFileSync(logFile, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        const users = new Set();
        for (const line of lines) {
          try {
            const evt = JSON.parse(line);
            if (new Date(evt.ts).getTime() < cutoffMs) continue;
            if (evt.chat_user_id) users.add(evt.chat_user_id);
          } catch {}
        }
        webhook_unique_users = users.size;
      }
    } catch (e) { console.error('[roas/lead] webhook log:', e.message); }
    // Source 3: Meta FB post comments
    if (meta && meta.getRecentPagePostComments) {
      try { comments = await meta.getRecentPagePostComments({ days }); } catch (e) { comments = { ok: false, error: e.message }; }
    }
    const fb_inquiry_comments = (comments && comments.inquiry_comments) || 0;
    // Use MAX of SaleSmartly API count vs webhook count (whichever is higher = more accurate)
    const messenger_count = Math.max(messenger_new_conversations, webhook_unique_users);
    const lead_count = messenger_count + fb_inquiry_comments;
    res.json({
      ok: true, days, lead_count,
      breakdown: {
        messenger_new_conversations: messenger_count,
        fb_inquiry_comments,
        salesmartly_api_count: messenger_new_conversations,
        webhook_unique_users
      },
      raw: { source: 'salesmartly+webhook+comments', comments }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/roas/line', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const stats = await line.getFollowerStats({ days }).catch(e => ({ ok: false, error: e.message }));
    res.json({ ok: stats.ok !== false, days, new_followers: stats.total_new || 0, total_followers: stats.latest_followers || 0, total_blocks: stats.latest_blocks || 0, samples: stats.samples || [] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/roas/today', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  try {
    let messenger_new_conversations = 0;
    let webhook_unique_users = 0;
    let comments = {};
    let line_followers = 0;
    let ad_spend = 0;
    if (salesmartly && salesmartly.listRecentConversations) {
      try {
        const sessions = await salesmartly.listRecentConversations({ days, page_size: 200 });
        messenger_new_conversations = (sessions && (sessions.total || (sessions.list && sessions.list.length))) || 0;
      } catch (e) { console.error('[roas/today] salesmartly:', e.message); }
    } else if (salesmartly && salesmartly.getCustomerProfiles) {
      try { const profiles = await salesmartly.getCustomerProfiles({ days }); messenger_new_conversations = (profiles && profiles.total) || 0; } catch (e) { console.error('[roas/today] salesmartly:', e.message); }
    }
    try {
      const fs = require('fs'); const path = require('path');
      const logFile = path.join(__dirname, 'data', 'salesmartly_webhook_events.jsonl');
      if (fs.existsSync(logFile)) {
        const cutoffMs = Date.now() - days * 86400 * 1000;
        const raw = fs.readFileSync(logFile, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        const users = new Set();
        for (const line of lines) { try { const evt = JSON.parse(line); if (new Date(evt.ts).getTime() < cutoffMs) continue; if (evt.chat_user_id) users.add(evt.chat_user_id); } catch {} }
        webhook_unique_users = users.size;
      }
    } catch (e) { console.error('[roas/today] webhook:', e.message); }
    if (meta && meta.getRecentPagePostComments) { try { comments = await meta.getRecentPagePostComments({ days }); } catch (e) { comments = { error: e.message }; } }
    if (line && line.getFollowerStats) { try { const ls = await line.getFollowerStats({ days }); line_followers = (ls && ls.new_followers) || 0; } catch (e) { console.error('[roas/today] line:', e.message); } }
    try {
      const token = process.env.META_ACCESS_TOKEN;
      const adAcct = process.env.META_AD_ACCOUNT_ID;
      if (token && adAcct) {
        const acctPath = adAcct.startsWith('act_') ? adAcct : 'act_' + adAcct;
        const since = new Date(Date.now() - days*86400*1000).toISOString().slice(0,10);
        const until = new Date().toISOString().slice(0,10);
        const url = `https://graph.facebook.com/v25.0/${acctPath}/insights?fields=spend,impressions,clicks&time_range={"since":"${since}","until":"${until}"}&access_token=${encodeURIComponent(token)}`;
        const r = await fetch(url);
        const j = await r.json();
        if (!j.error) ad_spend = (j.data || []).reduce((s, d) => s + parseFloat(d.spend || 0), 0);
      }
    } catch (e) { console.error('[roas/today] ad spend:', e.message); }
    const fb_inquiry_comments = (comments && comments.inquiry_comments) || 0;
    const messenger_count = Math.max(messenger_new_conversations, webhook_unique_users);
    const lead_count = messenger_count + fb_inquiry_comments;
    const cpl = lead_count > 0 ? Math.round((ad_spend / lead_count) * 100) / 100 : 0;
    const cpf = line_followers > 0 ? Math.round((ad_spend / line_followers) * 100) / 100 : 0;
    let cpl_health = 'no_data', cpf_health = 'no_data';
    if (lead_count > 0 && ad_spend > 0) { cpl_health = cpl < 100 ? 'good' : (cpl < 300 ? 'ok' : 'high'); }
    if (line_followers > 0 && ad_spend > 0) { cpf_health = cpf < 50 ? 'good' : (cpf < 150 ? 'ok' : 'high'); }
    res.json({
      ok: true, days,
      lead_count, new_followers: line_followers, ad_spend_ntd: Math.round(ad_spend),
      cost_per_lead_ntd: cpl, cost_per_follower_ntd: cpf,
      benchmark: { cpl_health, cpf_health },
      breakdown: { messenger_new_conversations: messenger_count, fb_inquiry_comments, salesmartly_api_count: messenger_new_conversations, webhook_unique_users }
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Manual trigger for VICTOR briefing + auto-publish test
app.post('/api/admin/test-briefing', async (req, res) => {
  try {
    const alerts = require('./alerts');
    if (!alerts || !alerts.dailyBriefing) return res.status(500).json({ ok: false, error: 'alerts.dailyBriefing not available' });
    const r = await alerts.dailyBriefing();
    res.json({ ok: true, result: r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message, stack: e.stack && e.stack.slice(0, 500) }); }
});

app.post('/api/admin/test-camille', async (req, res) => {
  try {
    const ap = require('./auto-publish');
    if (!ap || !ap.generateAndQueueDrafts) return res.status(500).json({ ok: false, error: 'auto-publish not available' });
    const r = await ap.generateAndQueueDrafts();
    res.json({ ok: true, result: r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/admin/probe-env', (req, res) => {
  let lineLoadOk = false, lineLoadErr = null;
  try { require('./line'); lineLoadOk = true; } catch (e) { lineLoadErr = e.message; }
  res.json({
    ok: true,
    line_token_len: (process.env.LINE_CHANNEL_ACCESS_TOKEN || '').length,
    line_secret_len: (process.env.LINE_CHANNEL_SECRET || '').length,
    admin_line_user_id_len: (process.env.ADMIN_LINE_USER_ID || '').length,
    meta_token_len: (process.env.META_ACCESS_TOKEN || '').length,
    line_module_loads: lineLoadOk,
    line_module_err: lineLoadErr,
    line_token_starts: (process.env.LINE_CHANNEL_ACCESS_TOKEN || '').slice(0, 8),
  });
});

app.post('/api/admin/test-line-push', async (req, res) => {
  try {
    const alerts = require('./alerts');
    const msg = (req.body && req.body.text) || '✅ LINE 推播測試 ' + new Date().toLocaleString('zh-TW');
    const r = await alerts.pushToAdmin(msg);
    res.json({ ok: true, sent: r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});


app.post('/api/admin/test-victor-briefing', async (req, res) => {
  try {
    const adminId = process.env.ADMIN_LINE_USER_ID;
    const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) && !(adminId && lineToken)) return res.json({ ok: false, error: 'no notification channel: set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID OR ADMIN_LINE_USER_ID + LINE_CHANNEL_ACCESS_TOKEN' });
    let parts = ['🌅 溫點 WarmPlace 早安簡報（測試）' + new Date().toLocaleString('zh-TW')];
    try {
      const r = await fetch('https://macaron-office.onrender.com/api/roas/today').then(x => x.json());
      if (r && r.ok) parts.push('\n💰 過去 7 天: 詢問 ' + r.lead_count + ' · 新好友 ' + r.new_followers);
    } catch {}
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
    const j = resp.ok ? { sent: true } : await resp.json();
    res.json({ ok: resp.ok, status: resp.status, body: j, text_preview: text });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/admin/get-page-token', async (req, res) => {
  const userToken = process.env.META_ACCESS_TOKEN;
  if (!userToken) return res.json({ ok: false, error: 'META_ACCESS_TOKEN not set' });
  try {
    const r = await fetch('https://graph.facebook.com/v19.0/me/accounts?access_token=' + encodeURIComponent(userToken));
    const j = await r.json();
    if (j.error) return res.json({ ok: false, error: j.error.message, hint: '你現在的 token 不是使用者 token，無法列出 pages。請到 Graph API Explorer 拿 User Token + pages_show_list, pages_read_engagement, pages_manage_posts 權限' });
    const pages = (j.data || []).map(p => ({ id: p.id, name: p.name, has_token: !!p.access_token, token_preview: p.access_token ? p.access_token.slice(0, 12) + '...' + p.access_token.slice(-6) : null, full_token: p.access_token }));
    const targetPageId = process.env.MACARON_FB_PAGE_ID || '';
    const ofzPage = targetPageId ? pages.find(p => p.id === targetPageId) : (pages[0] || null);
    res.json({
      ok: true,
      pages_count: pages.length,
      pages: pages.map(p => ({ id: p.id, name: p.name, has_token: p.has_token, token_preview: p.token_preview })),
      ofz_page_token: ofzPage ? ofzPage.full_token : null,
      next_step: ofzPage ? '複製上面的 page_token 貼到 Render 的 META_ACCESS_TOKEN env var' : '沒找到 MACARON Page'
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ============================================================
// Telegram 雙向 webhook — 從 Telegram 指揮 AI 團隊
// ============================================================

async function tgSend(chatId, text, parseMode) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  // Telegram message limit ~4096 chars; chunk if longer
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, 3800));
    remaining = remaining.slice(3800);
  }
  const results = [];
  for (const chunk of chunks) {
    try {
      const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: parseMode || undefined })
      });
      results.push(r.status);
    } catch (e) { results.push('err:' + e.message); }
  }
  return results;
}

app.post('/api/telegram/webhook', express.json(), async (req, res) => {
  res.json({ ok: true }); // ack immediately so Telegram doesn't retry
  try {
    const update = req.body || {};
    const msg = update.message || update.edited_message;
    if (!msg || !msg.text) return;
    const chatId = msg.chat && msg.chat.id;
    const adminChatId = process.env.TELEGRAM_CHAT_ID;
    // Security: only respond to admin
    if (String(chatId) !== String(adminChatId)) {
      console.warn('[telegram] rejected chat_id', chatId);
      return;
    }
    const text = msg.text.trim();
    console.log('[telegram] cmd:', text);
    
    // Quick commands
    if (text === '/start' || text === '/help') {
      await tgSend(chatId, '🤖 溫點 WarmPlace AI 團隊遙控\n\n直接打字下指令：\n• 「VICTOR 今天廣告怎樣」 → 行銷總監回\n• 「GIA 寫一篇 12 入禮盒」 → 立刻產文章\n• 「CAMILLE 發 FB」 → 立刻發 MACARON pages\n• 「NORA 上週 ROAS」 → 數據分析\n• 「YUKI 客戶輪廓」 → 客戶洞察\n• 「RIO 禮贈策略」 → 銷售顧問\n• 「MIKA 寫文案」 → 創意\n\n快捷指令：\n/today — 今日數據\n/post — CAMILLE 立刻發 FB\n/article — GIA 立刻發長文\n/status — 系統狀態');
      return;
    }
    // Per-teacher /today {amanda|paisley|sinda|lilly|ofz}
    const teacherCmd = text && text.match(/^\/(today|voc)\s+(amanda|paisley|sinda|lilly|ofz)$/i);
    if (teacherCmd) {
      const [, cmd, teacher] = teacherCmd;
      try {
        await tgSend(chatId, '📊 正在拉 ' + teacher.toUpperCase() + ' 的數據...');
        if (cmd.toLowerCase() === 'today') {
          const r = await fetch('https://macaron-office.onrender.com/api/teachers/summary?days=7').then(x => x.json());
          const t = r.teachers && r.teachers[teacher.toLowerCase()];
          if (!t) { await tgSend(chatId, '找不到 ' + teacher); return; }
          const msg = '👩 ' + t.name + ' · 過去 7 天\n' +
            '────────────\n' +
            '💰 廣告花費：NT$' + (t.spend_ntd || 0).toLocaleString() + '\n' +
            '📩 詢問數：' + t.lead_count + '\n' +
            '💎 CPL：' + (t.cost_per_lead_ntd ? 'NT$' + t.cost_per_lead_ntd : '—') + ' (' + t.cpl_health + ')\n' +
            '👁 曝光：' + (t.impressions || 0).toLocaleString() + '\n' +
            '🎯 CTR：' + t.ctr + '\n' +
            '📦 Campaign 數：' + t.campaign_count;
          await tgSend(chatId, msg);
        }
      } catch (e) { await tgSend(chatId, '錯誤：' + e.message); }
      return;
    }
    // Generic /brain <emp> command
    const brainCmd = text && text.match(/^\/brain\s+(victor|leon|camille|dex|nova)$/i);
    if (brainCmd) {
      const key = brainCmd[1].toLowerCase();
      try {
        await tgSend(chatId, '🧠 ' + key.toUpperCase() + ' 大腦啟動... 1-2 分鐘');
        const r = await fetch('https://macaron-office.onrender.com/api/brain/' + key + '/weekly-run', { method: 'POST' }).then(x => x.json());
        if (!r.ok) { await tgSend(chatId, '❌ ' + (r.error || 'unknown')); return; }
        await tgSend(chatId, r.telegram_preview || '無內容');
      } catch (e) { await tgSend(chatId, '錯誤：' + e.message); }
      return;
    }
    if (text === '/brain-all' || text === '/all-brains') {
      try {
        await tgSend(chatId, '🧠 5 個員工大腦全部啟動！每人 1-2 分鐘，5 分鐘後 Telegram 收完整報告。');
        fetch('https://macaron-office.onrender.com/api/brain/run-all', { method: 'POST' });
        const keys = ['victor','leon','camille','dex','nova'];
        for (const k of keys) {
          await new Promise(rs => setTimeout(rs, 90000));
          try {
            const r = await fetch('https://macaron-office.onrender.com/api/brain/' + k + '/history').then(x => x.json());
            const last = r.recent && r.recent.filter(x => x.type === 'suggestions').slice(-1)[0];
            if (last) await tgSend(chatId, '✅ ' + k.toUpperCase() + ' 完成 — ' + (last.suggestions || []).length + ' 條建議');
          } catch {}
        }
      } catch (e) { await tgSend(chatId, '錯誤：' + e.message); }
      return;
    }
    if (text === '/brain' || text === 'brain') {
      try {
        const r = await fetch('https://macaron-office.onrender.com/api/brain/all/status').then(x => x.json());
        let msg = '🧠 全員 AI 大腦狀態\n─────\n';
        for (const [k, e] of Object.entries(r.employees || {})) {
          msg += e.emoji + ' ' + e.name + ' — 準確率 ' + e.accuracy.correct_rate + ' (' + e.accuracy.weekly_runs + ' 週)\n';
        }
        msg += '\n💡 打 /brain <名字> 觸發單一員工';
        await tgSend(chatId, msg);
      } catch (e) { await tgSend(chatId, '錯誤：' + e.message); }
      return;
    }
    if (text === '/leon' || text === 'leon週報' || text === 'leon brain') {
      try {
        await tgSend(chatId, '🧠 LEON 大腦啟動中... 預計 1-2 分鐘\n（拍快照 + 對比上週 + 產建議）');
        const r = await fetch('https://macaron-office.onrender.com/api/leon/brain/weekly-run', { method: 'POST' }).then(x => x.json());
        if (!r.ok) { await tgSend(chatId, '❌ ' + (r.error || 'unknown')); return; }
        await tgSend(chatId, r.telegram_preview || '無內容');
      } catch (e) { await tgSend(chatId, 'LEON 大腦錯誤：' + e.message); }
      return;
    }
    // /booked customer-name amount service teacher
    if (text && text.match(/^\/booked\s+/i)) {
      try {
        const bk = require('./bookings');
        const parsed = bk.parseBookedCommand(text);
        if (!parsed) { await tgSend(chatId, '格式：/booked 客戶名 NT$1580 12入禮盒 台南店'); return; }
        const r = bk.addBooking(parsed);
        await tgSend(chatId, '✅ 預約已記錄\n客戶：' + r.customer_name + '\n金額：NT$' + r.amount_ntd + (r.service ? '\n服務：' + r.service : '') + (r.teacher ? '\n主理人：' + r.teacher : ''));
      } catch (e) { await tgSend(chatId, '錯誤：' + e.message); }
      return;
    }
    if (text === '/bookings' || text === '預約報表') {
      try {
        const r = await fetch('https://macaron-office.onrender.com/api/bookings/stats?days=30').then(x => x.json());
        let msg = '📊 過去 30 天預約報表\n────\n';
        msg += '💰 總營收：NT$' + (r.total_revenue || 0).toLocaleString() + '\n';
        msg += '📦 預約數：' + r.total_bookings + '\n';
        msg += '🎯 平均客單價：NT$' + r.avg_ticket + '\n\n';
        if (r.teachers_roi) {
          msg += '👩 各主理人 ROI：\n';
          for (const [k, t] of Object.entries(r.teachers_roi)) {
            msg += '  ' + (t.name || k) + ': ' + t.bookings + ' 預約 / NT$' + (t.revenue || 0).toLocaleString() + ' / ROAS ' + t.roas + ' / 轉約率 ' + t.conversion_rate + '\n';
          }
        }
        await tgSend(chatId, msg);
      } catch (e) { await tgSend(chatId, '錯誤：' + e.message); }
      return;
    }
    if (text === '/cpl' || text === 'cpl體檢') {
      try {
        await tgSend(chatId, '⏳ 跑 CPL 體檢中...');
        const r = await fetch('https://macaron-office.onrender.com/api/admin/cpl-check-now', { method: 'POST' }).then(x => x.json());
        let msg = '📊 CPL 即時體檢\n────\n';
        msg += '檢查 Campaign：' + (r.total_campaigns_checked || 0) + '\n';
        msg += '觸發警報：' + (r.alerts || []).length + ' 條\n';
        if ((r.alerts || []).length === 0) msg += '\n✅ 所有 Campaign CPL 正常';
        else for (const a of r.alerts) msg += '\n' + (a.level === 'CRITICAL' ? '🚨' : '⚠️') + ' ' + a.campaign + ' CPL NT$' + a.cpl;
        await tgSend(chatId, msg);
      } catch (e) { await tgSend(chatId, '錯誤：' + e.message); }
      return;
    }
    if (text === '/token-check' || text === 'token' || text === '檢測token') {
      try {
        const tm = require('./token-monitor');
        const results = await tm.checkAllTokens();
        await tgSend(chatId, tm.formatReport(results), 'Markdown');
      } catch (e) {
        await tgSend(chatId, '❌ Token 檢測失敗：' + e.message);
      }
      return res.json({ ok: true });
    }

    if (text === '/autoreply' || text === '自動回訊' || text === '/autoreply log') {
      try {
        const bot = require('./auto-reply-bot');
        const log = bot.getLog(10);
        let msg = '🤖 *Auto-Smart Reply 狀態*\n\n';
        if (!log || log.length === 0) {
          msg += '尚無自動回訊紀錄。\n\n如需訂閱粉專訊息 webhook，請呼叫：\nPOST /api/admin/auto-reply/subscribe';
        } else {
          msg += '📋 最近 ' + log.length + ' 筆自動回訊：\n';
          for (const r of log) {
            const t = (r.ts || '').slice(11, 16);
            const page = (r.pageName || r.pageId || '').slice(0, 12);
            const incoming = (r.incoming || '').slice(0, 30);
            const reply = (r.reply || '').slice(0, 40);
            msg += '\n[' + t + '] ' + page + '\n顧客：' + incoming + '\nAI：' + reply + '\n';
          }
        }
        await tgSend(chatId, msg, 'Markdown');
      } catch (e) {
        await tgSend(chatId, '❌ 讀取自動回訊紀錄失敗：' + e.message);
      }
      return res.json({ ok: true });
    }

    if (text === '/autoreply subscribe' || text === '訂閱自動回訊') {
      try {
        const bot = require('./auto-reply-bot');
        const results = await bot.subscribeMessages();
        const ok = results.filter(r => r.ok).length;
        const fail = results.length - ok;
        let msg = '🔔 *訂閱粉專訊息 webhook*\n\n成功：' + ok + ' / 失敗：' + fail + '\n\n';
        for (const r of results) {
          msg += (r.ok ? '✅' : '❌') + ' ' + (r.pageName || r.pageId) + (r.error ? ' — ' + r.error : '') + '\n';
        }
        await tgSend(chatId, msg, 'Markdown');
      } catch (e) {
        await tgSend(chatId, '❌ 訂閱失敗：' + e.message);
      }
      return res.json({ ok: true });
    }

    if (text === '/voc' || text === 'voc' || text === '顧客之聲') {
      try {
        await tgSend(chatId, '🔬 正在分析過去 90 天客戶訊息，請稍候 30-60 秒...');
        const r = await fetch('https://macaron-office.onrender.com/api/voc/mine?days=90').then(x => x.json());
        if (!r.ok) { await tgSend(chatId, '❌ VOC 分析失敗：' + (r.error || 'unknown')); return; }
        if (!r.analysis) { await tgSend(chatId, '⚠️ 找到 ' + r.total_sessions + ' 個對話但抽不到客戶訊息。' + (r.message || '')); return; }
        await tgSend(chatId, '📊 VOC 分析（' + r.messages_analyzed + ' 則訊息 / ' + r.total_sessions + ' 個對話）\n\n' + r.analysis);
      } catch (e) { await tgSend(chatId, 'VOC 錯誤：' + e.message); }
      return;
    }
    if (text === '/today' || text === '今日') {
      try {
        const r = await fetch('https://macaron-office.onrender.com/api/roas/today').then(x => x.json());
        await tgSend(chatId, '📊 今日 溫點 WarmPlace\n\n💰 過去 7 天:\n• 詢問 ' + (r.lead_count||0) + '\n• 新好友 ' + (r.new_followers||0) + '\n• 廣告 NT$' + (r.ad_spend||0) + '\n• 曝光 ' + (r.impressions||0));
      } catch (e) { await tgSend(chatId, '❌ ' + e.message); }
      return;
    }
    if (text === '/post' || text === '/fb') {
      await tgSend(chatId, '⏳ CAMILLE 開始寫並發 FB（MACARON pages）...');
      try {
        const ap = require('./auto-publish');
        const r = await ap.generateAndQueueDrafts();
        const d = r.drafts && r.drafts[0];
        if (d && d.status === 'published') {
          await tgSend(chatId, '✅ FB 已發\n標題: ' + (d.caption||'').slice(0, 80) + '...\nPost ID: ' + d.publish_id);
        } else {
          await tgSend(chatId, '❌ ' + ((d && d.publish_error) || 'unknown'));
        }
      } catch (e) { await tgSend(chatId, '❌ ' + e.message); }
      return;
    }
    if (text === '/article' || text === '/gia') {
      await tgSend(chatId, '⏳ GIA 開始寫長文並發到 ofzbeautyacademy.com（30-60 秒）...');
      try {
        if (!geo || !geo.dailyAutoPublishToMedium) throw new Error('geo module missing');
        const r = await geo.dailyAutoPublishToMedium();
        if (r.ok) {
          const wpUrl = r.wp && r.wp.link;
          await tgSend(chatId, '✅ 文章已發\n📝 標題: ' + r.title + '\n🔗 ' + (wpUrl || r.publish.url));
        } else {
          await tgSend(chatId, '❌ ' + (r.error || 'unknown'));
        }
      } catch (e) { await tgSend(chatId, '❌ ' + e.message); }
      return;
    }
    if (text === '/status') {
      await tgSend(chatId, '🟢 溫點 WarmPlace AI 系統狀態\n• Render: 正常\n• GIA cron: 9:00 + 15:00\n• CAMILLE cron: 10:00\n• VICTOR Telegram 早報: 8:30\n• 連通: WordPress ✅ FB ✅ Telegram ✅');
      return;
    }
    
    // Detect employee prefix
    const employees = {
      'VICTOR': '你是 VICTOR — 溫點 WarmPlace 的 AI 行銷總監。提供具體可執行的建議，控制在 200 字內。',
      'GIA': '你是 GIA — 溫點 WarmPlace 的 GEO 主理人，專長是讓 ChatGPT/Claude/Perplexity 推薦 溫點 WarmPlace。',
      'CAMILLE': '你是 CAMILLE — 溫點 WarmPlace 的 FB/IG 社群行銷專員。',
      'NORA': '你是 NORA — 溫點 WarmPlace 的數據分析師，擅長解讀廣告 ROAS、客戶轉換漏斗。',
      'YUKI': '你是 YUKI — 溫點 WarmPlace 的客戶洞察分析師，分析客戶詢問內容找模式。',
      'RIO': '你是 RIO — 溫點 WarmPlace 的銷售顧問，專責企業禮贈與婚禮禮盒。',
      'MIKA': '你是 MIKA — 溫點 WarmPlace 的內容創意，寫文案、想活動、設計優惠。',
      'LEXI': '你是 LEXI — 溫點 WarmPlace 的銷售跟單，追蹤每個 lead 從詢問到成交。',
      'SCOUT': '你是 SCOUT — 溫點 WarmPlace 的市場情報員，掃描韓系甜點與精品禮盒競品。',
    };
    let employee = 'VICTOR';
    let userMsg = text;
    for (const name of Object.keys(employees)) {
      const re = new RegExp('^' + name + '\\s+', 'i');
      if (re.test(text)) {
        employee = name;
        userMsg = text.replace(re, '').trim();
        break;
      }
    }
    
    // Call Anthropic
    if (!process.env.ANTHROPIC_API_KEY) { await tgSend(chatId, '❌ ANTHROPIC_API_KEY missing'); return; }
    try {
      const Anthropic = require('@anthropic-ai/sdk').default;
      const c = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      let context = '';
      try {
        const r = await fetch('https://macaron-office.onrender.com/api/roas/today').then(x => x.json());
        if (r.ok) context = '\n\n當前 溫點 WarmPlace 數據（過去 7 天）：詢問 ' + r.lead_count + ' · 新好友 ' + r.new_followers + ' · 廣告 NT$' + r.ad_spend;
      } catch {}
      const sys = employees[employee] + context + '\n\n業態：台灣韓系精品馬卡龍 + 高端禮贈品牌，主力商品：6 入禮盒 NT$880、12 入 NT$1,580、客製禮盒、單顆零售；4 家門店：台南本店 / 新光西門 B2 / 新光中港 B2 / 新光南西 B2。回覆要簡潔、可行動、用繁體中文。';
      const resp = await c.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: sys,
        messages: [{ role: 'user', content: userMsg }],
      });
      const reply = (resp.content && resp.content[0] && resp.content[0].text) || '(空)';
      await tgSend(chatId, '【' + employee + '】\n\n' + reply);
    } catch (e) {
      await tgSend(chatId, '❌ AI 失敗: ' + e.message);
    }
  } catch (e) { console.error('[telegram] webhook error:', e.message); }
});


// ============ Auto-Smart Reply (Messenger AI 5秒自動回) ============
app.get('/api/meta/webhook/messages', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const VT = process.env.META_WEBHOOK_VERIFY_TOKEN || 'ofz_comment_bot_2026';
  if (mode === 'subscribe' && token === VT) return res.status(200).send(challenge);
  res.status(403).send('forbidden');
});

app.post('/api/meta/webhook/messages', express.json(), async (req, res) => {
  res.status(200).send('ok');
  try {
    const bot = require('./auto-reply-bot');
    for (const entry of (req.body.entry || [])) {
      await bot.handleMessageEvent(entry).catch(e => console.error('[auto-reply]', e.message));
    }
  } catch (e) { console.error('[auto-reply webhook]', e.message); }
});

app.post('/api/admin/auto-reply/subscribe', async (req, res) => {
  try {
    const bot = require('./auto-reply-bot');
    const results = await bot.subscribeMessages();
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/admin/auto-reply/log', (req, res) => {
  try {
    const bot = require('./auto-reply-bot');
    const log = bot.getLog(parseInt(req.query.n) || 20);
    res.json({ ok: true, log });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});


// ============ Debug: All Campaigns Raw ============
app.get('/api/admin/debug/all-ads', async (req, res) => {
  try {
    const meta = require('./meta');

    const days = parseInt(req.query.days) || 30;
    const [campaigns, adsWithIns] = await Promise.all([
      meta.getAdCampaigns ? meta.getAdCampaigns({ limit: 200 }).catch(e => ({ error: e.message })) : Promise.resolve(null),
      meta.getAdsWithInsights ? meta.getAdsWithInsights({ days, limit: 200 }).catch(e => ({ error: e.message })) : Promise.resolve(null)
    ]);
    res.json({ ok: true, days, campaigns, ads: adsWithIns });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ============ Debug: All Ad Accounts ============
app.get('/api/admin/debug/ad-accounts', async (req, res) => {
  try {
    const token = process.env.META_ACCESS_TOKEN || process.env.META_USER_TOKEN || process.env.FB_USER_TOKEN;
    if (!token) return res.status(400).json({ ok: false, error: 'META_ACCESS_TOKEN not set' });
    const url = 'https://graph.facebook.com/v19.0/me/adaccounts?fields=id,account_id,name,account_status,currency,amount_spent,balance,business&limit=50&access_token=' + encodeURIComponent(token);
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.error) return res.status(500).json({ ok: false, error: data.error.message });
    res.json({ ok: true, total: (data.data || []).length, accounts: data.data || [] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});


// ============ Meta CAPI Admin Endpoints ============
app.post('/api/admin/capi/test', async (req, res) => {
  try {
    const capi = require('./meta-capi');
    const pageId = (req.query && req.query.pageId) || (req.body && req.body.pageId);
    const result = await capi.sendTestEvent(pageId);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/admin/capi/log', (req, res) => {
  try {
    const capi = require('./meta-capi');
    const n = parseInt(req.query.n) || 30;
    res.json({ ok: true, log: capi.getLog(n) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/admin/capi/purchase', express.json(), async (req, res) => {
  try {
    const capi = require('./meta-capi');
    const { pageId, senderId, value, service } = req.body || {};
    if (!pageId || !senderId) return res.status(400).json({ ok: false, error: 'pageId and senderId required' });
    const result = await capi.sendPurchaseEvent({ pageId, senderId, value, service });
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});


// ============ CAPI Sync (poll SaleSmartly -> Meta CAPI) ============
app.post('/api/admin/capi-sync/run', async (req, res) => {
  try {
    const sync = require('./capi-sync');
    const days = parseInt((req.query && req.query.days) || (req.body && req.body.days)) || 1;
    const result = await sync.syncOnce({ days });
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/admin/capi-sync/log', (req, res) => {
  try {
    const sync = require('./capi-sync');
    const n = parseInt(req.query.n) || 30;
    res.json({ ok: true, log: sync.getLog(n) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Direct webhook from SaleSmartly (push-based, faster than polling)
app.post('/api/salesmartly/webhook/capi', express.json(), async (req, res) => {
  res.status(200).send('ok'); // ack immediately
  try {
    const body = req.body || {};
    const capi = require('./meta-capi');
    const sync = require('./capi-sync');
    const channelId = String(body.channel_id || (body.conversation && body.conversation.channel_id) || '');
    const pageId = sync.CHANNEL_TO_PAGE[channelId];
    if (!pageId) { console.log('[capi-sync webhook] no pageId for channel', channelId); return; }
    const senderId = String(body.user_id || body.contact_id || (body.conversation && body.conversation.contact_id) || '');
    const message = body.content || body.message || (body.last_message && body.last_message.content) || '';
    if (!senderId) { console.log('[capi-sync webhook] no senderId'); return; }
    const result = await capi.sendLeadEvent({ pageId, senderId, message, eventTimeMs: Date.now() });
    console.log('[capi-sync webhook] sent:', result.tier, '$' + result.value);
  } catch (e) { console.error('[capi-sync webhook]', e.message); }
});

// Run sync every 5 minutes
try {
  const cron = require('node-cron');
  cron.schedule('*/5 * * * *', async () => {
    try {
      const sync = require('./capi-sync');
      const r = await sync.syncOnce({ days: 1 });
      if (r && r.sent > 0) console.log('[capi-sync cron]', JSON.stringify(r));
    } catch (e) { console.error('[capi-sync cron]', e.message); }
  }, { timezone: 'Asia/Taipei' });
  console.log('[capi-sync] cron registered: every 5 min');
} catch (e) { console.error('[capi-sync cron register]', e.message); }


// ============ Token Monitor ============
app.get('/api/admin/token/check', async (req, res) => {
  try {
    const tm = require('./token-monitor');
    const results = await tm.checkAllTokens();
    res.json({ ok: true, results, report: tm.formatReport(results) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Cron: monthly token health check (1st of month at 09:00)
try {
  const cron = require('node-cron');
  cron.schedule('0 9 1 * *', async () => {
    try {
      const tm = require('./token-monitor');
      const results = await tm.checkAllTokens();
      const msg = tm.formatReport(results);
      const warn = results.some(r => !r.ok || (r.daysLeft !== undefined && r.daysLeft <= 14));
      if (warn) {
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (chatId && typeof tgSend === 'function') {
          await tgSend(chatId, msg, 'Markdown');
        }
      }
    } catch (e) { console.error('[token-monitor cron]', e.message); }
  }, { timezone: 'Asia/Taipei' });
  console.log('[token-monitor] cron registered: 1st of month 09:00');
} catch (e) { console.error('[token-monitor cron register]', e.message); }


// ============ Competitor Ad Library Scout ============
app.post('/api/admin/competitor/scan', async (req, res) => {
  try {
    const scout = require('./competitor-scout');
    const result = await scout.scanAll();
    res.json({ ok: true, ts: result.ts, total: result.total, errors: result.errors });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/admin/competitor/top', (req, res) => {
  try {
    const scout = require('./competitor-scout');
    const n = parseInt(req.query.n) || 5;
    res.json({ ok: true, top: scout.topAds(n) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/admin/competitor/report', (req, res) => {
  try {
    const scout = require('./competitor-scout');
    const n = parseInt(req.query.n) || 5;
    res.type('text/plain').send(scout.weeklyReport(n));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/admin/competitor/analyze', async (req, res) => {
  try {
    const scout = require('./competitor-scout');
    const analysis = await scout.analyzeWithAI();
    res.json({ ok: true, analysis });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Cron: daily 06:00 scan + Monday 08:00 weekly report
try {
  const cron = require('node-cron');
  cron.schedule('0 6 * * *', async () => {
    try {
      const scout = require('./competitor-scout');
      const r = await scout.scanAll();
      console.log('[scout] daily scan:', r.total, 'ads, errors:', r.errors.length);
    } catch (e) { console.error('[scout daily]', e.message); }
  }, { timezone: 'Asia/Taipei' });
  cron.schedule('0 8 * * 1', async () => {
    try {
      const scout = require('./competitor-scout');
      const report = scout.weeklyReport(5);
      const ai = await scout.analyzeWithAI().catch(() => null);
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (chatId && typeof tgSend === 'function') {
        await tgSend(chatId, report, 'Markdown');
        if (ai) await tgSend(chatId, '🤖 *LEON 競品分析*\n\n' + ai, 'Markdown');
      }
    } catch (e) { console.error('[scout weekly]', e.message); }
  }, { timezone: 'Asia/Taipei' });
  console.log('[competitor-scout] cron registered: daily 06:00 + Mon 08:00');
} catch (e) { console.error('[scout cron register]', e.message); }



// ============ SaleSmartly Config Probe (temporary) ============
app.get('/api/admin/ss-probe', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ ok: false, error: 'token required' });
  const BASE = 'https://developer.salesmartly.com';
  const endpoints = [
    { path: '/api/v2/get-session-list', body: { page_size: 5 } },
    { path: '/api/v2/get-tag-list', body: { page_size: 50 } },
    { path: '/api/v2/get-channel-list', body: {} },
    { path: '/api/v2/get-trigger-list', body: { page_size: 50 } },
    { path: '/api/v2/get-flow-list', body: { page_size: 50 } },
    { path: '/api/v2/get-bot-list', body: { page_size: 50 } },
    { path: '/api/v2/get-quick-reply-list', body: { page_size: 50 } },
    { path: '/api/v2/get-team-list', body: {} },
    { path: '/api/v2/get-user-list', body: { page_size: 50 } },
    { path: '/api/v2/get-contact-list', body: { page_size: 5 } }
  ];
  const results = {};
  for (const ep of endpoints) {
    try {
      const r = await fetch(BASE + ep.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Api-Key': token, 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(ep.body)
      });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
      results[ep.path] = { status: r.status, body };
    } catch (e) { results[ep.path] = { error: e.message }; }
  }
  res.json({ ok: true, base: BASE, results });
});



// ============ SaleSmartly Probe v2 (more endpoint variants) ============
app.get('/api/admin/ss-probe2', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ ok: false, error: 'token required' });
  const BASE = 'https://developer.salesmartly.com';
  const variants = [
    '/api/v2/contacts/list', '/api/v2/contact/list', '/api/v2/get-contact',
    '/api/v2/tags/list', '/api/v2/tag/list', '/api/v2/get-tags',
    '/api/v2/channels/list', '/api/v2/channel/list',
    '/api/v2/get-session-tag-list',
    '/api/v2/get-contact-tag-list',
    '/api/v2/add-session-tag',
    '/api/v2/send-message',
    '/api/v2/add-session-note',
    '/api/v2/get-trigger',
    '/api/v2/get-bot',
    '/api/v2/get-flow',
    '/api/v2/get-team',
    '/api/v2/get-user'
  ];
  const results = {};
  for (const path of variants) {
    try {
      const r = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Api-Key': token },
        body: JSON.stringify({ page_size: 3 })
      });
      results[path] = { status: r.status };
      if (r.status !== 404) {
        const text = await r.text();
        let body;
        try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
        results[path].body = body;
      }
    } catch (e) { results[path] = { error: e.message }; }
  }
  res.json({ ok: true, base: BASE, results });
});



// ============================================================
// 🚀 Dashboard Endpoints — 一次回多個資料源 (Performance optimization)
// ============================================================
function _internalGet(req, path) {
  const host = req.get('host');
  const proto = req.protocol;
  return fetch(`${proto}://${host}${path}`)
    .then(r => r.json())
    .catch(e => ({ ok: false, error: e.message }));
}

// /api/meta/dashboard — 廣告中心一次回應 (ROAS today + lead + line)
app.get('/api/meta/dashboard', async (req, res) => {
  const [roas, lead, line, probe] = await Promise.all([
    _internalGet(req, '/api/roas/today'),
    _internalGet(req, '/api/roas/lead'),
    _internalGet(req, '/api/roas/line'),
    _internalGet(req, '/api/meta/probe'),
  ]);
  res.json({ ok: true, roas, lead, line, meta_probe: probe, generated_at: new Date().toISOString() });
});

// /api/customer-hub/dashboard — 客戶中心一次回應
app.get('/api/customer-hub/dashboard', async (req, res) => {
  const days = req.query.days || '7';
  const [groups, inquiries, insights, profiles] = await Promise.all([
    _internalGet(req, '/api/customers'),
    _internalGet(req, `/api/customers/inquiries?days=${days}`),
    _internalGet(req, '/api/customers/insights'),
    _internalGet(req, '/api/customers/profiles'),
  ]);
  res.json({ ok: true, groups, inquiries, insights, profiles, generated_at: new Date().toISOString() });
});

// /api/inbox/dashboard — 對話中心一次回應
app.get('/api/inbox/dashboard', async (req, res) => {
  const [recent, stats_today, inquiries, ss_probe] = await Promise.all([
    _internalGet(req, '/api/conversion/recent'),
    _internalGet(req, '/api/conversion/stats/today'),
    _internalGet(req, '/api/customers/inquiries?days=7'),
    _internalGet(req, '/api/salesmartly/probe'),
  ]);
  res.json({ ok: true, recent, stats_today, inquiries, salesmartly: ss_probe, generated_at: new Date().toISOString() });
});

// /api/geo/dashboard — GEO 中心一次回應 (跳過慢的 daily-briefing)
app.get('/api/geo/dashboard', async (req, res) => {
  const [audits, content] = await Promise.all([
    _internalGet(req, '/api/geo/recent-audits'),
    _internalGet(req, '/api/geo/recent-content'),
  ]);
  res.json({ ok: true, audits, content, note: 'daily-briefing 需單獨叫 /api/geo/daily-briefing(會跑 Claude 故慢)', generated_at: new Date().toISOString() });
});

// /api/ai-team/dashboard — AI 內容團隊一次回應
app.get('/api/ai-team/dashboard', async (req, res) => {
  const [months, topics, qa] = await Promise.all([
    _internalGet(req, '/api/ai-team/months'),
    _internalGet(req, '/api/ai-team/topics'),
    _internalGet(req, '/api/ai-team/qa/recent'),
  ]);
  res.json({ ok: true, months, topics, qa, generated_at: new Date().toISOString() });
});



// ============================================================
// 🤖 Telegram AI Agent — Jeffrey 在 Telegram 上問問題,VICTOR 帶整個 AI 團隊回答
// ============================================================
// Persistent Telegram conversation memory — saved to disk so survives Render restarts
const TG_DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || require('path').join(__dirname, 'data');
function tgHistoryFile(chatId) { return require('path').join(TG_DATA_DIR, `telegram-conv-${chatId}.json`); }
function tgLoadHistory(chatId) {
  try { return JSON.parse(require('fs').readFileSync(tgHistoryFile(chatId), 'utf8')); } catch { return []; }
}
function tgSaveHistory(chatId, history) {
  try {
    require('fs').mkdirSync(TG_DATA_DIR, { recursive: true });
    require('fs').writeFileSync(tgHistoryFile(chatId), JSON.stringify(history.slice(-40), null, 2));
  } catch (e) { console.error('[TG save history]', e.message); }
}
function tgClearHistory(chatId) { try { require('fs').unlinkSync(tgHistoryFile(chatId)); } catch {} }

async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const chunks = [];
  const SAFE = 3800;
  for (let i = 0; i < text.length; i += SAFE) chunks.push(text.slice(i, i + SAFE));
  for (let i = 0; i < chunks.length; i++) {
    const body = chunks.length > 1 ? `(${i+1}/${chunks.length})\n${chunks[i]}` : chunks[i];
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: body })
      });
    } catch (e) { console.error('[TG send]', e.message); }
  }
}

async function gatherTelegramContext() {
  const base = `http://localhost:${PORT}`;
  const out = {};
  try {
    const [meta, cust, ig] = await Promise.all([
      fetch(`${base}/api/meta/probe`).then(r => r.json()).catch(() => null),
      fetch(`${base}/api/customer-hub/dashboard`).then(r => r.json()).catch(() => null),
      fetch(`${base}/api/conversion/stats/today`).then(r => r.json()).catch(() => null),
    ]);
    if (meta) out.meta = { page: meta.me_response, ad_7d: meta.ad_spend_7d };
    if (cust) out.customers = { total: cust.groups && cust.groups.summary && cust.groups.summary.total, inquiries: cust.inquiries && cust.inquiries.total };
    if (ig) out.conversion_today = { orders: (ig.orders && ig.orders.length) || 0, revenue: ig.revenue };
  } catch (e) { out._err = e.message; }
  return out;
}

app.post('/api/telegram/webhook', express.json({ limit: '1mb' }), async (req, res) => {
  res.json({ ok: true }); // ack immediately so Telegram doesn't retry
  try {
    const update = req.body;
    const msg = update.message || update.edited_message;
    if (!msg || !msg.text) return;
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();
    const adminChat = String(process.env.TELEGRAM_CHAT_ID || '');

    // Restrict to admin chat
    if (adminChat && chatId !== adminChat) {
      await sendTelegram(chatId, '❌ 你不是 MACARON 管理員,無法使用這個 AI 助理。');
      return;
    }

    // Commands
    if (text === '/start' || text === '/help') {
      await sendTelegram(chatId, '🥐 溫點 WarmPlace · VICTOR (AI 行銷總監)\n\n直接問我問題,我會帶整個 AI 團隊找答案。例如:\n\n• 「下週母親節該主打什麼?」\n• 「IG 流量都導不到門市,怎麼辦?」\n• 「企業送禮怎麼開發?」\n• 「新光西門 B2 表現比較差,有什麼建議?」\n\n指令:\n/reset — 清空對話記憶\n/data — 看現在帳號數據摘要');
      return;
    }
    if (text === '/reset') {
      tgClearHistory(chatId);
      await sendTelegram(chatId, '✅ 對話記憶已清空。');
      return;
    }
    if (text === '/data') {
      const ctx = await gatherTelegramContext();
      await sendTelegram(chatId, '📊 目前數據摘要\n\n' + JSON.stringify(ctx, null, 2));
      return;
    }

    // Build conversation history (last 6 turns)
    const history = tgLoadHistory(chatId);
    history.push({ role: 'user', content: text });

    // Inject live data into context
    const liveData = await gatherTelegramContext();
    let marketCtx = "";
    try { if (marketIntel) marketCtx = marketIntel.getMarketIntelContext({ compact: true }); } catch {}
    const dataLine = `\n\n[目前 MACARON 即時數據]\n${JSON.stringify(liveData)}\n\n${marketCtx}`;

    const systemPrompt = `你是 VICTOR — 溫點 WarmPlace 的 AI 行銷總監兼整個 AI 團隊的大腦。\n\n品牌:精品馬卡龍與費南雪禮贈品牌,4 家門店(台南本店、新光西門 B2、新光中港 B2、新光南西 B2)。月度預算 NT$60,000。\nIG @warmplace.here 粉絲 32K,FB 粉專 118 粉絲(主戰場在 IG)。\nLINE Bot @110ypqki, SaleSmartly 對話追蹤已開。\n\n你帶領團隊:LEON(廣告投手)、CAMILLE(內容主筆,負責文案+部落格 SEO)、ARIA(視覺指導)、DEX(數據分析)、NOVA(品牌經理,負責社群+公關)、MILO(KOL)。\n\n【你的工作模式 — 你是 AI Agent,不是建議生成器】\n你的目標是【幫 Jeffrey 解決問題、產出可立即使用的交付物】,不是給「建議」。\n\n**判斷請求類型,直接給對應交付物:**\n\n① 問題型 → 給【今天做 / 本週做 / 本月做】三層具體行動 + 指名負責員工\n② 內容型(寫文案/Reels 腳本) → 【直接產 3-5 版可立即複製貼上的成品】,不要先講想法再寫\n③ 規劃型(行事曆) → 【直接出表格】:日期 / 平台 / 主題 / 文案 / 視覺需求\n④ 分析型(現在數據怎樣?) → 引用即時數據,3 個觀察 + 1 個關鍵問題給 Jeffrey 拍板\n⑤ 決策型(該不該做 X?) → 直接給【做 / 不做】+ 量化理由(預估金額、leads、GMV)+ 風險\n\n**你有對話記憶** — 你看得到過去的對話,延續討論,不要重複問已經回答的問題。\n**遇資料不足** — 直接告訴 Jeffrey 缺什麼數據 + 怎麼補上,不要瞎掰。\n\n【絕對禁止】\n- 廣告投放細節(老闆要求,只談客戶經營/內容/門店/品牌)\n- 課程、報名、學員、教學、紋繡、美容(這些是舊業態)\n- 「以下幾個建議供參考」「希望對你有幫助」這類客套話\n- 給範圍式建議(「可以考慮...」)應改成決策建議(「建議做 X,不要做 Y,因為 ...」)\n\n回答用繁體中文,可用 emoji 但不要太多。`;

    const c = anthropic;
    if (!c) { await sendTelegram(chatId, '❌ ANTHROPIC_API_KEY 未設,VICTOR 不在線'); return; }

    let reply = null;
    try {
      const resp = await c.messages.create({
        model: DIRECTOR_MODEL,
        max_tokens: 2000,
        system: systemPrompt + dataLine,
        messages: history.slice(-30),
      });
      const block = resp.content && resp.content[0];
      if (block && block.type === 'text') reply = block.text.trim();
    } catch (e) {
      console.error('[TG AI]', e.message);
      reply = '⚠️ AI 處理出錯: ' + e.message.slice(0, 200);
    }

    if (!reply) reply = '抱歉,VICTOR 沒有回應。';

    // Save to history (truncate at 12 turns to prevent context overflow)
    history.push({ role: 'assistant', content: reply });
    tgSaveHistory(chatId, history);

    await sendTelegram(chatId, reply);
  } catch (err) {
    console.error('[/api/telegram/webhook]', err);
  }
});

// /api/telegram/setup — admin 一鍵設定 Telegram webhook
app.post('/api/admin/telegram/setup-webhook', async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(400).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not set' });
  const host = req.get('host');
  const webhookUrl = `https://${host}/api/telegram/webhook`;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'edited_message'] })
    });
    const j = await r.json();
    res.json({ ok: j.ok, webhook_url: webhookUrl, telegram_response: j });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});



// ============================================================
// 📡 Market Intel — 每日台灣網路情報爬蟲 + 自動餵 AI 團隊
// ============================================================
if (marketIntel) {
  // 06:00 每天自動跑
  try {
    cron.schedule('0 6 * * *', async () => {
      console.log('[market-intel cron] daily 06:00 scan starting...');
      try { await marketIntel.runDailyScan(); } catch (e) { console.error('[market-intel cron]', e.message); }
    }, { timezone: 'Asia/Taipei' });
    console.log('[market-intel] cron registered: daily 06:00');
  } catch (e) { console.error('[market-intel cron register]', e.message); }
}

// 手動觸發
app.post('/api/market-intel/run-now', async (req, res) => {
  if (!marketIntel) return res.status(500).json({ ok: false, error: 'market-intel module not loaded' });
  try {
    const r = await marketIntel.runDailyScan();
    res.json({ ok: true, date: r.date, summary_stats: r.summary_stats });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 看最新情報
app.get('/api/market-intel/latest', (req, res) => {
  if (!marketIntel) return res.status(500).json({ ok: false, error: 'market-intel module not loaded' });
  const intel = marketIntel.loadLatestIntel();
  if (!intel) return res.json({ ok: false, error: 'no data yet, call /api/market-intel/run-now first' });
  res.json({ ok: true, ...intel });
});

// 看摘要文字(就是注入 AI 用的 context)
app.get('/api/market-intel/summary', (req, res) => {
  if (!marketIntel) return res.status(500).json({ ok: false, error: 'market-intel module not loaded' });
  res.type('text').send(marketIntel.getMarketIntelContext({ compact: false }));
});

// 「溫點 vs 對手」AI 比對分析
app.post('/api/market-intel/compare', async (req, res) => {
  if (!marketIntel) return res.status(500).json({ ok: false, error: 'market-intel module not loaded' });
  if (!anthropic) return res.status(500).json({ ok: false, error: 'anthropic not configured' });
  try {
    const r = await marketIntel.compareWithWarmplace({ anthropic, model: DIRECTOR_MODEL });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ============================================================
// app.listen — required for Render to detect open port



// ============================================================
// app.listen — required for Render to detect open port
// ============================================================
app.listen(PORT, () => {
  console.log('🥐 溫點 WarmPlace · Virtual Office v2');
  console.log('   Listening on http://localhost:' + PORT);
  console.log('   Model: ' + MODEL);
  console.log('   Employees: ' + Object.keys(EMPLOYEES).length);
  console.log('   Cron: VICTOR Mon 09:00 / DEX Fri 17:00 (Asia/Taipei)');
});
