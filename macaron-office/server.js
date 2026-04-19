// ============================================================
// MACARON DE LUXE · Virtual Office Server v2
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
const line = require("./line");
const google = require("./google");
const multer = require("multer");

// Employees that benefit from Meta live data in their prompt
const META_AWARE_EMPLOYEES = new Set(["victor", "leon", "camille", "aria", "dex", "nova", "sofia", "milo", "emi"]);

async function maybeAugmentSystemPrompt(emp) {
  if (!META_AWARE_EMPLOYEES.has(emp.id) || !meta.tokenOk()) return emp.systemPrompt;
  try {
    const metaBlock = await meta.buildCoachDataBlock();
    const googleBlock = google.tokenOk() ? await google.buildCoachDataBlock() : null;
    if (!metaBlock && !googleBlock) return emp.systemPrompt;
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
    return emp.systemPrompt + extra;
  } catch (e) {
    console.warn(`[meta coaching-data] ${emp.id}:`, e.message);
    return emp.systemPrompt;
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
    const navHtml = `<div id="__app_nav" style="position:fixed;top:14px;right:14px;z-index:9999;display:flex;gap:8px;background:rgba(26,20,22,0.95);padding:8px 10px;border-radius:10px;border:1px solid #6D2E46;box-shadow:0 4px 14px rgba(0,0,0,0.5);font-family:-apple-system,'PingFang TC',sans-serif;">
      <a href="/optimize.html" style="color:#B08D57;text-decoration:none;padding:6px 12px;background:rgba(176,141,87,0.08);border-radius:6px;font-size:12px;letter-spacing:1px;border:1px solid rgba(176,141,87,0.3);">⚡ 廣告體檢</a>
      <a href="/competitor.html" style="color:#B08D57;text-decoration:none;padding:6px 12px;background:rgba(176,141,87,0.08);border-radius:6px;font-size:12px;letter-spacing:1px;border:1px solid rgba(176,141,87,0.3);">📡 競品追蹤</a>
      <a href="/social.html" style="color:#B08D57;text-decoration:none;padding:6px 12px;background:rgba(176,141,87,0.08);border-radius:6px;font-size:12px;letter-spacing:1px;border:1px solid rgba(176,141,87,0.3);">📱 FB/IG</a>
      <a href="/google.html" style="color:#4285F4;text-decoration:none;padding:6px 12px;background:rgba(66,133,244,0.08);border-radius:6px;font-size:12px;letter-spacing:1px;border:1px solid rgba(66,133,244,0.3);">📊 Google Ads</a>
      <a href="/line.html" style="color:#06C755;text-decoration:none;padding:6px 12px;background:rgba(6,199,85,0.08);border-radius:6px;font-size:12px;letter-spacing:1px;border:1px solid rgba(6,199,85,0.3);">💬 LINE</a>
    </div>`;
    const injected = html.replace('</body>', navHtml + '</body>');
    res.type('html').send(injected);
  });
});


app.use(express.static(path.join(__dirname, "public")));

// Serve LINE uploaded images publicly (LINE CDN 會抓這個 URL)
app.use("/uploads", express.static(LINE_UPLOAD_DIR, { maxAge: "30d" }));

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
- caption 要符合 MACARON DE LUXE 品牌語調（精品、內斂、不農場標題）
- FB 貼文 150-300 字，IG 貼文 80-150 字 + 3-5 個 hashtag
- 直接回 JSON 陣列，不要任何前後綴或 markdown`;

  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2500,
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
// /api/chat — single employee streaming
// ============================================================
app.post("/api/chat", async (req, res) => {
  const { employeeId, messages } = req.body || {};
  const emp = EMPLOYEES[employeeId];
  if (!emp) return res.status(400).json({ error: "Unknown employee" });
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: "messages required" });

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
    if (liveSystem !== emp.systemPrompt) send("status", { text: `📡 已接入 Meta 即時數據` });
    const stream = await anthropic.messages.stream({
      model: MODEL,
      max_tokens: 3072,
      system: liveSystem,
      messages: messages.map(m => ({
        role: m.role === "ai" ? "assistant" : m.role,
        content: typeof m.content === "string" ? m.content : String(m.content),
      })),
    });
    let full = "";
    stream.on("text", (delta) => {
      full += delta;
      send("delta", { text: delta });
    });
    stream.on("error", (err) => {
      send("error", { message: String(err.message || err) });
      res.end();
    });
    await stream.finalMessage();
    send("done", { ok: true, length: full.length });
    res.end();
  } catch (err) {
    console.error("[/api/chat]", err);
    send("error", { message: String(err.message || err) });
    res.end();
  }
});

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
      max_tokens: 1500,
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
          max_tokens: 2048,
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
      max_tokens: 3072,
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
      max_tokens: 2048,
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

  // 用 Claude 分類意圖 + 寫草稿
  let classification = null;
  let draft = null;
  if (anthropic) {
    try {
      const sysPrompt = `你是 MACARON DE LUXE 的客服助理。
會收到客人的 LINE 訊息，請做兩件事並輸出 JSON：
1. 意圖分類：price / pickup / storage / gifting / complaint / product / other
2. 建議的回覆草稿（精品語調、直接切入、不囉嗦）

品牌資訊（用來回答）：
- 4 家門店：台南本店、新光西門 B2、新光中港 B2、新光南西 B2
- 核心商品：6 入 NT$880、12 入 NT$1,580、禮盒 NT$480–2,280
- 保存期限：冷藏 7 天，常溫 6 小時
- 不含防腐劑，每日現做

輸出格式：
{"intent": "...", "draft": "..."}

直接回 JSON，不要前後綴、不要 markdown。`;
      const msg = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 600,
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
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const analysis = (msg.content || []).map(c => c.text || "").join("\n");
    res.json({ ok: true, analysis, scope, dateRange });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/line/generate-broadcast  body: {brief, count}
// 讓 NOVA 寫 N 個廣播草稿
app.post("/api/line/generate-broadcast", async (req, res) => {
  const { brief, count = 3 } = req.body || {};
  if (!brief || brief.trim().length < 5) return res.status(400).json({ error: "brief too short" });
  if (!anthropic) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const emp = EMPLOYEES["nova"];
  const userPrompt = `針對下面 brief，寫 ${count} 個 LINE 官方帳號廣播訊息草稿，每個風格不同。

Brief：${brief}

要求：
- LINE 廣播會發給全部好友，語氣親近但保持精品感
- 每則 120-200 字
- 可加 emoji 但節制（1-3 個）
- 回 JSON 陣列：[{"style":"...","text":"..."}, ...]
- 不要 markdown，直接回 JSON`;
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
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


app.get("/healthz", (req, res) => res.json({ ok: true, model: MODEL, employees: Object.keys(EMPLOYEES).length }));

app.listen(PORT, () => {
  console.log(`\n🥐 MACARON DE LUXE · Virtual Office v2`);
  console.log(`   Listening on http://localhost:${PORT}`);
  console.log(`   Model: ${MODEL} | Director: ${DIRECTOR_MODEL}`);
  console.log(`   Employees: ${Object.keys(EMPLOYEES).length}`);
  console.log(`   Cron: VICTOR Mon 09:00 / DEX Fri 17:00 (Asia/Taipei)\n`);
});
