// flows.js — 自動回覆流程 v2 (節點分支樹 + 按鈕 postback) FB Messenger / IG DM
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const automation = (() => { try { return require('./automation'); } catch { return { isEnabled: () => true }; } })();

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const FLOWS_FILE = path.join(DATA_DIR, 'flows.json');
const CD_FILE = path.join(DATA_DIR, 'flows_cooldown.json');
const LOG_FILE = path.join(DATA_DIR, 'flows_log.jsonl');
const PB = 'SSF'; // postback payload: SSF|flowId|nodeId

function ensureDir(){ try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }
function loadFlows(){ ensureDir(); try { return JSON.parse(fs.readFileSync(FLOWS_FILE, 'utf8')).map(migrate); } catch { return []; } }
function saveFlows(a){ ensureDir(); try { fs.writeFileSync(FLOWS_FILE, JSON.stringify(a, null, 2)); } catch (e) { console.error('[flows] save', e.message); } }
function loadCd(){ try { return JSON.parse(fs.readFileSync(CD_FILE, 'utf8')); } catch { return {}; } }
function saveCd(o){ ensureDir(); try { fs.writeFileSync(CD_FILE, JSON.stringify(o)); } catch {} }
function genId(){ return 'flow_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function logRun(rec){ ensureDir(); try { fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n'); } catch {} }
function normKeywords(k){ if (Array.isArray(k)) return k.map(s => String(s).trim().toLowerCase()).filter(Boolean); return String(k || '').split(/[,\s，、]+/).map(s => s.trim().toLowerCase()).filter(Boolean); }

// 舊版 steps → 新版 nodes 相容轉換
function migrate(f){
  if (f && f.nodes) return f;
  const nodes = {}; let prev = null; let start = null;
  (f.steps || []).forEach((s, i) => {
    const id = 'n' + (i + 1);
    if (!start) start = id;
    if (s.type === 'condition') nodes[id] = { text: s.ifText || s.elseText || '', buttons: [] };
    else if (s.type === 'quick_replies') nodes[id] = { text: s.text || '', buttons: (s.options || []).map(o => ({ label: o, next: '' })) };
    else nodes[id] = { text: s.text || s.tag || '', buttons: [] };
    if (prev && !nodes[prev].buttons.length) nodes[prev].next = id;
    prev = id;
  });
  return Object.assign({}, f, { nodes, startNode: start || 'n1' });
}

function getFlow(id){ return loadFlows().find(f => f.id === id); }

function matchFlow(text, platform){
  const t = String(text || '').toLowerCase();
  for (const f of loadFlows()){
    if (!f.enabled) continue;
    if (platform && f.platform && f.platform !== platform) continue;
    if (normKeywords(f.keywords).some(k => k && t.includes(k))) return f;
  }
  return null;
}

// 產一個節點的訊息 (含按鈕 → payload 指向下一節點)
function renderNode(flow, nodeId){
  const node = (flow.nodes || {})[nodeId];
  if (!node) return null;
  const msg = { type: 'text', text: node.text || '' };
  const btns = (node.buttons || []).filter(b => b && b.label);
  if (btns.length) msg.quick_replies = btns.map(b => ({ title: b.label, payload: [PB, flow.id, b.next || ''].join('|') }));
  return { message: msg, node };
}

function onCooldown(flowId, userId, hours){ if (!hours || !userId) return false; const last = loadCd()[flowId + ':' + userId]; return last ? (Date.now() - last) < hours * 3600 * 1000 : false; }
function markCooldown(flowId, userId){ if (!userId) return; const cd = loadCd(); cd[flowId + ':' + userId] = Date.now(); saveCd(cd); }

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
    body.message.quick_replies = msg.quick_replies.slice(0, 13).map(q => ({ content_type: 'text', title: String(q.title || q).slice(0, 20), payload: String(q.payload || q.title || q).slice(0, 1000) }));
  }
  const r = await fetch('https://graph.facebook.com/v19.0/me/messages?access_token=' + encodeURIComponent(token), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function sendNode(pageId, recipientId, flow, nodeId){ const r = renderNode(flow, nodeId); if (!r) return; await sendMessage(pageId, recipientId, r.message); }

// Webhook: 私訊進來 → 關鍵字啟動 startNode；按鈕 postback → 跳對應節點
async function handleMessageEvent(entry, platform){
  if (!automation.isEnabled('auto_reply_flows')) return [];
  const results = [];
  const pageId = entry.id;
  const events = entry.messaging || [];
  for (const ev of events){
    const senderId = ev.sender && ev.sender.id;
    if (!senderId) continue;
    const pb = (ev.message && ev.message.quick_reply && ev.message.quick_reply.payload) || (ev.postback && ev.postback.payload) || '';
    if (pb && pb.indexOf(PB + '|') === 0){
      const parts = pb.split('|'); const flow = getFlow(parts[1]); const nid = parts[2];
      if (flow && nid){ try { await sendNode(pageId, senderId, flow, nid); results.push({ flow: flow.id, node: nid, via: 'button' }); } catch (e) { results.push({ error: e.message }); } }
      continue;
    }
    const text = ev.message && ev.message.text;
    if (!text || (ev.message && ev.message.is_echo)) continue;
    const flow = matchFlow(text, platform);
    if (!flow) continue;
    if (onCooldown(flow.id, senderId, flow.cooldownHours)){ results.push({ flow: flow.id, skipped: 'cooldown' }); continue; }
    try { await sendNode(pageId, senderId, flow, flow.startNode || 'n1'); } catch (e) { results.push({ error: e.message }); }
    markCooldown(flow.id, senderId);
    logRun({ flow: flow.id, flow_name: flow.name, platform, sender: senderId, input: String(text).slice(0, 120) });
    results.push({ flow: flow.id, started: true });
  }
  return results;
}

// ── Routes ──
router.get('/', (req, res) => res.json({ ok: true, flows: loadFlows() }));
router.post('/', express.json({ limit: '1mb' }), (req, res) => {
  const b = req.body || {};
  const flows = loadFlows();
  const flow = {
    id: b.id || genId(),
    name: b.name || '未命名流程',
    platform: b.platform || 'messenger',
    category: b.category || '',
    keywords: normKeywords(b.keywords),
    cooldownHours: Number(b.cooldownHours) || 0,
    enabled: b.enabled !== false,
    startNode: b.startNode || 'n1',
    nodes: (b.nodes && typeof b.nodes === 'object') ? b.nodes : {},
    updatedAt: new Date().toISOString(),
  };
  const i = flows.findIndex(f => f.id === flow.id);
  if (i >= 0) flows[i] = flow; else flows.push(flow);
  saveFlows(flows);
  res.json({ ok: true, flow });
});
router.delete('/:id', (req, res) => { saveFlows(loadFlows().filter(f => f.id !== req.params.id)); res.json({ ok: true }); });
// 模擬器: 給 input(文字) 或 nodeId(點按鈕) → 回該節點訊息 + 按鈕(可再點)
router.post('/simulate', express.json({ limit: '1mb' }), (req, res) => {
  const b = req.body || {};
  let flow = b.flow || (b.id && getFlow(b.id));
  if (!flow) return res.status(400).json({ ok: false, error: 'flow or id required' });
  flow = migrate(flow);
  let nodeId = b.nodeId;
  let matched = true;
  if (!nodeId){ const m = matchFlow(b.input || '', flow.platform); matched = !!(m && m.id === flow.id); nodeId = matched ? (flow.startNode || 'n1') : null; }
  if (!nodeId) return res.json({ ok: true, matched: false, text: '', buttons: [] });
  const r = renderNode(flow, nodeId);
  if (!r) return res.json({ ok: true, matched, text: '(節點不存在)', buttons: [] });
  res.json({ ok: true, matched, nodeId, text: r.message.text, buttons: (r.node.buttons || []).filter(x => x && x.label).map(x => ({ label: x.label, next: x.next || '' })) });
});
router.get('/log', (req, res) => { try { const items = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-50).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse(); res.json({ ok: true, items }); } catch { res.json({ ok: true, items: [] }); } });

module.exports = router;
module.exports.handleMessageEvent = handleMessageEvent;
module.exports.matchFlow = matchFlow;
module.exports.renderNode = renderNode;
