// capi-sync.js - poll SaleSmartly for new conversations and send CAPI events
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const SEEN_FILE = path.join(DATA_DIR, 'capi_sync_seen.json');
const SYNC_LOG = path.join(DATA_DIR, 'capi_sync_log.jsonl');

// SaleSmartly channel_id -> MACARON DE LUXE FB page_id mapping
// 從環境變數讀,格式: CHANNEL_TO_PAGE_JSON='{"<channel_id>":"<page_id>",...}'
// 一個 FB 粉專 = 一個 channel_id = 一個 page_id (在 Messenger 場景兩者相同)
let CHANNEL_TO_PAGE = {};
try {
  CHANNEL_TO_PAGE = JSON.parse(process.env.CHANNEL_TO_PAGE_JSON || '{}');
} catch (e) {
  console.error('[capi-sync] CHANNEL_TO_PAGE_JSON parse error:', e.message);
}

function loadSeen() { try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch { return {}; } }
function saveSeen(o) { try { fs.writeFileSync(SEEN_FILE, JSON.stringify(o)); } catch {} }
function appendLog(e) { try { fs.appendFileSync(SYNC_LOG, JSON.stringify(e) + '\n'); } catch {} }

function getLog(n) {
  try {
    const lines = fs.readFileSync(SYNC_LOG, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// Run one sync cycle: fetch SaleSmartly recent conversations, send CAPI for new ones
async function syncOnce({ days = 1 } = {}) {
  let sm, capi;
  try { sm = require('./salesmartly'); } catch { return { error: 'salesmartly module not loaded' }; }
  try { capi = require('./meta-capi'); } catch { return { error: 'meta-capi module not loaded' }; }
  if (!sm || !sm.listRecentConversations) return { error: 'salesmartly.listRecentConversations missing' };
  if (!capi || !capi.sendLeadEvent) return { error: 'meta-capi.sendLeadEvent missing' };
  
  let sessions;
  try {
    const res = await sm.listRecentConversations({ days, page_size: 200 });
    sessions = (res && (res.list || (res.data && res.data.list))) || [];
  } catch (e) {
    return { error: 'fetch failed: ' + e.message };
  }
  
  const seen = loadSeen();
  const results = { total: sessions.length, sent: 0, skipped: 0, errors: 0, details: [] };
  
  for (const s of sessions) {
    try {
      const convId = s.id || s.conversation_id || s.contact_id || (s.channel_id + '_' + s.user_id);
      if (!convId) { results.errors++; continue; }
      
      // skip if already sent
      if (seen[convId]) { results.skipped++; continue; }
      
      // map channel_id -> page_id (only FB Messenger maps)
      const channelId = String(s.channel_id || '');
      const pageId = CHANNEL_TO_PAGE[channelId];
      if (!pageId) { results.skipped++; continue; }
      
      const senderId = String(s.user_id || s.contact_id || convId);
      const lastMsg = s.last_message || s.last_message_content || s.preview || '';
      
      const capiResult = await capi.sendLeadEvent({
        pageId,
        senderId,
        message: lastMsg,
        eventTimeMs: s.last_message_time_ms || s.updated_at || Date.now()
      });
      
      seen[convId] = Date.now();
      saveSeen(seen);
      
      if (capiResult.ok) {
        results.sent++;
        appendLog({
          ts: new Date().toISOString(),
          convId, pageId, senderId,
          tier: capiResult.tier, value: capiResult.value,
          ok: true
        });
      } else if (capiResult.skipped) {
        results.skipped++;
      }
    } catch (e) {
      results.errors++;
      appendLog({ ts: new Date().toISOString(), error: e.message });
    }
  }
  
  return results;
}

module.exports = { syncOnce, getLog, CHANNEL_TO_PAGE };
