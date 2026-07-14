// mcp-bridge.js — 通用 MCP 橋：把任何 remote MCP server 的工具掛進 AI 員工
// ============================================================
// 加一隻手 = 在 Render 環境變數 MCP_SERVERS 加一筆設定 + Manual Deploy，零開發。
// MCP_SERVERS 格式（JSON array）：
// [{"name":"zapier","url":"https://mcp.zapier.com/api/mcp/mcp","key":"Bearer xxx","confirm":true},
//  {"name":"github","url":"https://api.githubcopilot.com/mcp/","key":"Bearer ghp_xxx"}]
//  - name: 英數短名（工具名會變成 mcp_<name>_<tool>）
//  - url: MCP streamable-HTTP endpoint
//  - key: 會放進 Authorization header（自動補 Bearer）；也可用 headers 自訂其他認證
//  - headers: 額外 headers，如 {"x-api-key":"..."}
//  - confirm: true = 此伺服器所有工具視為敏感，AI 不直接執行，只提案請老闆確認
// ============================================================

const PROTOCOL_VERSION = "2025-06-18";

let SERVERS = [];
try { SERVERS = JSON.parse(process.env.MCP_SERVERS || "[]"); }
catch (e) { console.error("[mcp-bridge] MCP_SERVERS JSON 解析失敗:", e.message); }

const state = {}; // name -> { session, id, tools, cfg }

function _headers(cfg) {
  const h = { "content-type": "application/json", "accept": "application/json, text/event-stream" };
  if (cfg.key) h["authorization"] = String(cfg.key).startsWith("Bearer") ? cfg.key : "Bearer " + cfg.key;
  Object.assign(h, cfg.headers || {});
  const st = state[cfg.name];
  if (st && st.session) h["mcp-session-id"] = st.session;
  return h;
}

async function _send(cfg, method, params, isNotification) {
  const st = state[cfg.name];
  const body = isNotification
    ? { jsonrpc: "2.0", method, params: params || {} }
    : { jsonrpc: "2.0", id: ++st.id, method, params: params || {} };
  const res = await fetch(cfg.url, { method: "POST", headers: _headers(cfg), body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) st.session = sid;
  if (isNotification) return null;
  const ct = res.headers.get("content-type") || "";
  let data = null;
  if (ct.includes("text/event-stream")) {
    const text = await res.text();
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try { const j = JSON.parse(line.slice(5).trim()); if (j && (j.result !== undefined || j.error)) data = j; } catch (e) {}
    }
  } else {
    data = await res.json().catch(() => null);
  }
  if (!res.ok) throw new Error("MCP " + cfg.name + " HTTP " + res.status + (data && data.error ? ": " + (data.error.message || "") : ""));
  if (data && data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data ? data.result : null;
}

function _safeName(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40); }

async function connectServer(cfg) {
  state[cfg.name] = { session: null, id: 0, tools: [], cfg };
  await _send(cfg, "initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "macaron-office", version: "1.0" } });
  try { await _send(cfg, "notifications/initialized", {}, true); } catch (e) {}
  const r = await _send(cfg, "tools/list", {});
  const tools = (r && r.tools) || [];
  state[cfg.name].tools = tools.map(t => ({
    anthName: ("mcp_" + _safeName(cfg.name) + "_" + _safeName(t.name)).slice(0, 128),
    realName: t.name,
    description: (t.description || "").slice(0, 800),
    schema: t.inputSchema || { type: "object", properties: {} },
  }));
  console.log("[mcp-bridge] " + cfg.name + " 已連線，掛入工具 " + tools.length + " 個");
}

async function init() {
  for (const cfg of SERVERS) {
    if (!cfg || !cfg.name || !cfg.url) continue;
    try { await connectServer(cfg); } catch (e) { console.error("[mcp-bridge] " + cfg.name + " 連線失敗:", e.message); }
  }
  const n = getAnthropicTools().length;
  if (n) console.log("[mcp-bridge] 共 " + n + " 個外掛工具就緒");
  else console.log("[mcp-bridge] 未設定 MCP_SERVERS（要加手時：Render env 加設定 + Manual Deploy）");
}

function getAnthropicTools() {
  const out = [];
  for (const name of Object.keys(state)) {
    for (const t of state[name].tools) {
      out.push({ name: t.anthName, description: "[外掛:" + name + "] " + t.description, input_schema: t.schema });
    }
  }
  return out;
}

function isMcpTool(name) { return typeof name === "string" && name.indexOf("mcp_") === 0; }

function _find(anthName) {
  for (const key of Object.keys(state)) {
    const t = state[key].tools.find(x => x.anthName === anthName);
    if (t) return { cfg: state[key].cfg, tool: t };
  }
  return null;
}

function needsConfirm(name) { const f = _find(name); return !!(f && f.cfg.confirm); }

async function callTool(anthName, args) {
  const f = _find(anthName);
  if (!f) throw new Error("unknown MCP tool: " + anthName);
  const r = await _send(f.cfg, "tools/call", { name: f.tool.realName, arguments: args || {} });
  if (r && Array.isArray(r.content)) {
    return r.content.map(c => c.text || JSON.stringify(c)).join("\n").slice(0, 8000);
  }
  return JSON.stringify(r).slice(0, 8000);
}

module.exports = { init, getAnthropicTools, isMcpTool, needsConfirm, callTool, _state: state };
