// ============================================================
// 溫點 WarmPlace · AiToEarn MCP Bridge
// ------------------------------------------------------------
// 透過 AiToEarn 統一 MCP 端點，把內容鋪到內建工具沒涵蓋的
// 平台（TikTok / 小紅書 / YouTube / X / Threads / Pinterest 等）。
// 協議：MCP streamable-HTTP (JSON-RPC 2.0)，認證 x-api-key。
//
// 環境變數：
//   AITOEARN_API_KEY  必填，從 aitoearn.ai 或 aitoearn.cn 設定頁取得
//   AITOEARN_MCP_URL  可選，預設國際版；中國版用 https://aitoearn.cn/api/unified/mcp
// 未設 KEY 時所有呼叫回傳明確錯誤，不會 crash。
// ============================================================

const BASE = process.env.AITOEARN_MCP_URL || "https://aitoearn.ai/api/unified/mcp";
const KEY = process.env.AITOEARN_API_KEY || "";
const PROTOCOL_VERSION = "2025-06-18";

let _id = 0;
let _session = null;
let _initPromise = null;

function configured() { return !!KEY; }

async function _send(method, params, isNotification = false) {
  if (!KEY) throw new Error("AITOEARN_API_KEY 未設定");
  const headers = {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
    "x-api-key": KEY,
  };
  if (_session) headers["mcp-session-id"] = _session;
  const body = isNotification
    ? { jsonrpc: "2.0", method, params: params || {} }
    : { jsonrpc: "2.0", id: ++_id, method, params: params || {} };

  const res = await fetch(BASE, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) _session = sid;
  if (isNotification) return null;

  const ct = res.headers.get("content-type") || "";
  let data = null;
  if (ct.includes("text/event-stream")) {
    const text = await res.text();
    const chunks = text.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).filter(Boolean);
    for (const c of chunks) { try { const j = JSON.parse(c); if (j && (j.id !== undefined || j.result || j.error)) data = j; } catch (_) {} }
  } else {
    data = await res.json().catch(() => null);
  }
  if (!res.ok) throw new Error(`AiToEarn HTTP ${res.status}` + (data && data.error ? `: ${data.error.message || ""}` : ""));
  if (data && data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data ? data.result : null;
}

async function _init() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    await _send("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "warmplace-office", version: "1.0" },
    });
    try { await _send("notifications/initialized", {}, true); } catch (_) {}
  })().catch(e => { _initPromise = null; throw e; });
  return _initPromise;
}

async function listTools() {
  await _init();
  const r = await _send("tools/list", {});
  if (r && Array.isArray(r.tools)) {
    return r.tools.map(t => ({ name: t.name, description: t.description || "" }));
  }
  return r;
}

async function callTool(name, args) {
  if (!name) throw new Error("action(name) 必填");
  await _init();
  return await _send("tools/call", { name, arguments: args || {} });
}

module.exports = { configured, listTools, callTool };
