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

// Employees that benefit from Meta live data in their prompt
const META_AWARE_EMPLOYEES = new Set(["leon", "nova", "zara", "dex"]);

async function maybeAugmentSystemPrompt(emp) {
  if (!META_AWARE_EMPLOYEES.has(emp.id) || !meta.tokenOk()) return emp.systemPrompt;
  try {
    const block = await meta.buildLiveDataBlock();
    if (!block) return emp.systemPrompt;
    return (
      emp.systemPrompt +
      "\n\n---\n[📡 LIVE DATA · Meta 即時數據快照]\n" +
      "以下是從 Meta Graph API 即時抓取的真實數據，請在分析與建議時優先引用這些數字，不要編造：\n\n" +
      block +
      "\n\n引用這些數據時，請在結論中標註「(資料來源：Meta Graph API)」。"
    );
  } catch (e) {
    console.warn(`[meta live-data] ${emp.id}:`, e.message);
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

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

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

    const planningPrompt = `Jeffrey 剛交付以下任務廍：

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

① <div class="tldr">⚡ TL;DR｜一句該結論</div>

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

app.get("/healthz", (req, res) => res.json({ ok: true, model: MODEL, employees: Object.keys(EMPLOYEES).length }));

app.listen(PORT, () => {
  console.log(`\n🥐 MACARON DE LUXE · Virtual Office v2`);
  console.log(`   Listening on http://localhost:${PORT}`);
  console.log(`   Model: ${MODEL} | Director: ${DIRECTOR_MODEL}`);
  console.log(`   Employees: ${Object.keys(EMPLOYEES).length}`);
  console.log(`   Cron: VICTOR Mon 09:00 / DEX Fri 17:00 (Asia/Taipei)\n`);
});
