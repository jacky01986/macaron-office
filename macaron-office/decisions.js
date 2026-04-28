// decisions.js — 決策清單管理（1ok / 1no / 1? LINE 一鍵決策）
//
// 提供：
//   - addPending(decision)       新增等待決策的事項
//   - getPending({ limit })      列出未決策事項（最多 N 件）
//   - getAll()                   全部紀錄
//   - parseUserReply(text)       解析 "1ok" / "2no" / "3?" 文字
//   - applyReply(userId, parsed) 套用使用者回覆 → 更新 actions.json
//   - handleLineMessage(event)   給 LINE webhook 直接呼叫（自動辨認 + 回確認）

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const ACTIONS_FILE = path.join(DATA_DIR, 'actions.json');

let line = null;
try { line = require('./line'); } catch {}

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ACTIONS_FILE)) {
    fs.writeFileSync(ACTIONS_FILE, JSON.stringify({ pending: [], history: [] }, null, 2));
  }
}

function load() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(ACTIONS_FILE, 'utf8'));
  } catch {
    return { pending: [], history: [] };
  }
}

function save(state) {
  ensureFile();
  fs.writeFileSync(ACTIONS_FILE, JSON.stringify(state, null, 2));
}

function genId() {
  return 'dec_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

async function addPending({ title, recommendation, source = 'system' }) {
  const state = load();
  const item = {
    id: genId(),
    title,
    recommendation: recommendation || null,
    source,
    created_at: new Date().toISOString(),
  };
  state.pending.push(item);
  if (state.pending.length > 10) state.pending = state.pending.slice(-10);
  save(state);
  return item;
}

async function getPending({ limit = 3 } = {}) {
  const state = load();
  return state.pending.slice(0, limit);
}

async function getAll() {
  return load();
}

function parseUserReply(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  const m = trimmed.match(/^(\d*)\s*(ok|no|\?)(?:\s+(.+))?$/i);
  if (!m) return null;
  const indexStr = m[1] || '1';
  const action = m[2].toLowerCase();
  const note = m[3] ? m[3].trim() : null;
  return { index: parseInt(indexStr, 10), action, note };
}

async function applyReply(userId, parsed) {
  if (!parsed) return { ok: false, reason: 'parse failed' };
  const state = load();
  const idx = parsed.index - 1;
  if (idx < 0 || idx >= state.pending.length) {
    return { ok: false, reason: `第 ${parsed.index} 件不存在（目前只有 ${state.pending.length} 件待決策）` };
  }
  const item = state.pending[idx];
  if (parsed.action === '?') {
    item.questions = item.questions || [];
    item.questions.push({ from: userId, at: new Date().toISOString(), note: parsed.note || '' });
    save(state);
    return { ok: true, action: '?', item };
  }
  state.pending.splice(idx, 1);
  state.history.push({
    ...item,
    decision: parsed.action,
    decided_at: new Date().toISOString(),
    decided_by: userId,
    note: parsed.note,
  });
  if (state.history.length > 200) state.history = state.history.slice(-200);
  save(state);
  return { ok: true, action: parsed.action, item };
}

async function handleLineMessage(event) {
  if (!event || event.type !== 'message' || !event.message || event.message.type !== 'text') {
    return null;
  }
  const text = event.message.text;
  const parsed = parseUserReply(text);
  if (!parsed) return null;
  const userId = event.source?.userId;
  const result = await applyReply(userId, parsed);
  if (line && typeof line.replyMessage === 'function' && event.replyToken) {
    let confirm;
    if (!result.ok) {
      confirm = `⚠️ ${result.reason}`;
    } else if (result.action === 'ok') {
      confirm = `✅ 已記錄：第 ${parsed.index} 件「${result.item.title}」決定 OK`;
      if (parsed.note) confirm += `\n📝 ${parsed.note}`;
    } else if (result.action === 'no') {
      confirm = `❌ 已記錄：第 ${parsed.index} 件「${result.item.title}」決定 NO`;
      if (parsed.note) confirm += `\n📝 ${parsed.note}`;
    } else {
      confirm = `❓ 收到問題：第 ${parsed.index} 件「${result.item.title}」`;
      confirm += `\n明天 VICTOR 會回應你的提問。`;
    }
    try {
      await line.replyMessage(event.replyToken, [{ type: 'text', text: confirm }]);
    } catch (e) {}
  }
  return result;
}

module.exports = { addPending, getPending, getAll, parseUserReply, applyReply, handleLineMessage };
