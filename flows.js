// flows.js — 自動回覆流程管理 + 引擎 (FB Messenger / IG DM)
// 關鍵字觸發 → 多步驟 / 條件分支 / 貼標籤 / 冷卻。含模擬器 + Meta 收發。
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const automation = (() => { try { return require('./automation'); } catch { return { isEnabled: () => true }; } })();

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const FLOWS_FILE = path.join(DATA_DIR, 'flows.json');
const COOLDOWN_FILE = path.join(DATA_DIR, 'flows_cooldown.json');
const LOG_FILE = path.join(DATA_DIR, 'flows_log.jsonl');

function ensureDir(){ try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }
function loadFlows(){ ensureDir(); try { return JSON.parse(fs.readFileSync(FLOWS_FILE, 'utf8')); } catch { return []; } }
function saveFlows(a){ ensureDir(); try { fs.writeFileSync(FLOWS_FILE, JSON.stringify(a, null, 2)); } catch (e) { console.error('[flows] save', e.message); } }
function loadCd(){ try { return JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8')); } catch { return {}; } }
function saveCd(o){ ensureDir(); try { fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(o)); } catch {} }
function genId(){ return 'flow_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function logRun(rec){ ensureDir(); try { fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n'); } catch {} }

function normKeywords(k){
  if (Array.isArray(k)) return k.map(s => String(s).trim().toLowerCase()).filter(Boolean);
  return String(k || '').split(/[,\s，、]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

// flow: { id, name, platform:'messenger'|'instagram', account, category, price, keywords:[], cooldownHours, enabled, tags:[], steps:[] }
// step: { type:'message', text } | { type:'condition', keyword, ifText, elseText } | { type:'tag', tag } | { type:'quick_replies', text, options:[] }
function matchFlow(text, platform){
  const t = String(text || '').toLowerCase();
  for (const f of loadFlows()){
    if (!f.enabled) continue;
    if (platform && f.platform && f.platform !== platform) continue;
    if (normKeywords(f.keywords).some(k => k && t.includes(k))) return f;
  }
  return null;
}

function runFlow(flow, input){
  const out = [];
  const t = String(input || '').toLowerCase();
  for (const step of (flow.steps || [])){
    const type = step.type || 'message';
    if (type === 'message'){ if (step.text) out.push({ type: 'text', text: step.text }); }
    else if (type === 'quick_replies'){ out.push({ type: 'text', text: step.text || '', quick_replies: step.options || [] }); }
    else if (type === 'condition'){
      const kw = String(step.keyword || '').toLowerCase();
      const txt = (kw && t.includes(kw)) ? step.ifText : step.elseText;
      if (txt) out.push({ type: 'text', text: txt });
    }
    else if (type === 'tag'){ if (step.tag) out.push({ type: '_tag', tag: step.tag }); }
  }
  return out;
}

function onCooldown(flowId, userId, hours){
  if (!hours || !userId) return false;
  const last = loadCd()[flowId + ':' + userId];
  return last ? (Date.now() - last) < hours * 3600 * 1000 : false;
}
function markCooldown(flowId, userId){ if (!userId) return; const cd = loadCd(); cd[flowId + ':' + userId] = Date.now(); saveCd(cd); }

// ── Meta 發送 ──
async function getPageToken(pageId){
  const userToken = process.env.META_ACCESS_TOKEN;
  if (!userToken) throw new Error('META_ACCESS_TOKEN missing');
  const r = await fetch('https://graph.facebook.com/v19.0/me/accounts?access_token=' + encodeURIComponent(userToken));
  const j = await r.json();
  const page = (j.data || []).find(p => p.id === pageId) || (j.data || [])[0];
  if (!page || !page.access_token) throw new Error('page token not found for ' + pageId);
  return page.access_token;
}
async function sendMessage(pageId, recipientId, msg){
  const token = await getPageToken(pageId);
  const body = { recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { text: (msg.text || '').slice(0, 2000) } };
  if (msg.quick_replies && msg.quick_replies.length){
    body.message.quick_replies = msg.quick_replies.slice(0, 11).map(o => ({ content_type: 'text', title: String(o).slice(0, 20), payload: String(o).slice(0, 100) }));
  }
  const r = await fetch('https://graph.facebook.com/v19.0/me/messages?access_token=' + encodeURIComponent(token), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.json();
}

// ── Webhook: 私訊進來 → 跑流程 → 回覆 ──
async function handleMessageEvent(entry, platform){
  if (!automation.isEnabled('auto_reply_flows')) return [];
  const results = [];
  const pageId = entry.id;
  const events = entry.messaging || [];
  for (const ev of events){
    const senderId = ev.sender && ev.sender.id;
    const text = ev.message && ev.message.text;
    if (!senderId || !text) continue;
    if (ev.message.is_echo) continue;
    const flow = matchFlow(text, platform);
    if (!flow) continue;
    if (onCooldown(flow.id, senderId, flow.cooldownHours)){ results.push({ flow: flow.id, skipped: 'cooldown' }); continue; }
    const msgs = runFlow(flow, text);
    let sent = 0;
    for (const m of msgs){
      if (m.type === '_tag') continue;
      try { await sendMessage(pageId, senderId, m); sent++; } catch (e) { results.push({ flow: flow.id, error: e.message }); }
    }
    markCooldown(flow.id, senderId);
    logRun({ flow: flow.id, flow_name: flow.name, platform, sender: senderId, input: String(text).slice(0, 120), sent });
    results.push({ flow: flow.id, sent });
  }
  return results;
}

// ── Routes ──
router.get('/', (req, res) => res.json({ ok: true, flows: loadFlows() }));
router.post('/', express.json(), (req, res) => {
  const b = req.body || {};
  const flows = loadFlows();
  const flow = {
    id: b.id || genId(),
    name: b.name || '未命名流程',
    platform: b.platform || 'messenger',
    account: b.account || '',
    category: b.category || '',
    price: Number(b.price) || 0,
    keywords: normKeywords(b.keywords),
    cooldownHours: Number(b.cooldownHours) || 0,
    enabled: b.enabled !== false,
    tags: Array.isArray(b.tags) ? b.tags : [],
    steps: Array.isArray(b.steps) ? b.steps : [],
    updatedAt: new Date().toISOString(),
  };
  const i = flows.findIndex(f => f.id === flow.id);
  if (i >= 0) flows[i] = flow; else flows.push(flow);
  saveFlows(flows);
  res.json({ ok: true, flow });
});
router.delete('/:id', (req, res) => { saveFlows(loadFlows().filter(f => f.id !== req.params.id)); res.json({ ok: true }); });
router.post('/simulate', express.json(), (req, res) => {
  const b = req.body || {};
  let flow = b.flow || (b.id && loadFlows().find(f => f.id === b.id));
  if (!flow) return res.status(400).json({ ok: false, error: 'flow or id required' });
  const matched = matchFlow(b.input || '', flow.platform);
  res.json({ ok: true, matched: !!(matched && matched.id === flow.id), messages: runFlow(flow, b.input || '') });
});
router.get('/log', (req, res) => {
  try {
    const items = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-50)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
    res.json({ ok: true, items });
  } catch { res.json({ ok: true, items: [] }); }
});

module.exports = router;
module.exports.handleMessageEvent = handleMessageEvent;
module.exports.matchFlow = matchFlow;
module.exports.runFlow = runFlow;
