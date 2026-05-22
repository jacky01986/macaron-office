// token-monitor.js - Check Meta token expiry and alert before it expires
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const LAST_CHECK_FILE = path.join(DATA_DIR, 'token_check_last.json');

// Check a single token's expiry via Meta debug_token endpoint
async function checkTokenExpiry(token, label) {
  if (!token) return { label, ok: false, error: 'token not set' };
  
  // Meta debug_token requires app token (app_id|app_secret) or admin token
  // Simpler: call /me to verify token works, and try /me/permissions for scopes
  try {
    const meUrl = 'https://graph.facebook.com/v19.0/me?access_token=' + encodeURIComponent(token);
    const meResp = await fetch(meUrl);
    const me = await meResp.json();
    if (me.error) {
      const code = me.error.code;
      if (code === 190) return { label, ok: false, expired: true, error: me.error.message };
      return { label, ok: false, error: me.error.message };
    }
    
    // Try debug_token using the token itself as access_token
    const dbgUrl = 'https://graph.facebook.com/v19.0/debug_token?input_token=' + encodeURIComponent(token) + '&access_token=' + encodeURIComponent(token);
    const dbgResp = await fetch(dbgUrl);
    const dbg = await dbgResp.json();
    
    if (dbg.data) {
      const expiresAt = dbg.data.expires_at || dbg.data.data_access_expires_at || 0;
      if (expiresAt === 0) {
        return { label, ok: true, expires: 'never', user: me.name || me.id, isValid: true };
      }
      const now = Math.floor(Date.now() / 1000);
      const daysLeft = Math.floor((expiresAt - now) / 86400);
      return {
        label,
        ok: true,
        user: me.name || me.id,
        expiresAt: new Date(expiresAt * 1000).toISOString().slice(0, 10),
        daysLeft,
        isValid: dbg.data.is_valid !== false,
        scopes: (dbg.data.scopes || []).slice(0, 5)
      };
    }
    return { label, ok: true, user: me.name || me.id, expires: 'unknown', isValid: true };
  } catch (e) {
    return { label, ok: false, error: e.message };
  }
}

// Check all configured Meta tokens
async function checkAllTokens() {
  const tokens = [
    { token: process.env.META_ACCESS_TOKEN, label: 'META_ACCESS_TOKEN' },
    { token: process.env.META_USER_TOKEN, label: 'META_USER_TOKEN' },
    { token: process.env.META_CAPI_TOKEN, label: 'META_CAPI_TOKEN' },
    { token: process.env.FB_USER_TOKEN, label: 'FB_USER_TOKEN' }
  ].filter(t => t.token);
  
  const results = [];
  for (const t of tokens) {
    const r = await checkTokenExpiry(t.token, t.label);
    results.push(r);
  }
  
  try { fs.writeFileSync(LAST_CHECK_FILE, JSON.stringify({ ts: new Date().toISOString(), results })); } catch {}
  return results;
}

// Format results as Telegram-friendly message
function formatReport(results) {
  let msg = '🔑 *Meta Token 健檢報告*\n\n';
  let warning = false;
  for (const r of results) {
    if (!r.ok) {
      msg += '❌ ' + r.label + '\n   錯誤：' + (r.error || 'unknown') + '\n\n';
      warning = true;
      continue;
    }
    if (r.expires === 'never') {
      msg += '✅ ' + r.label + '\n   永久有效 ✨\n   使用者：' + r.user + '\n\n';
    } else if (r.daysLeft !== undefined) {
      let icon = '✅';
      if (r.daysLeft <= 7) { icon = '🚨'; warning = true; }
      else if (r.daysLeft <= 14) { icon = '⚠️'; warning = true; }
      msg += icon + ' ' + r.label + '\n   剩 ' + r.daysLeft + ' 天（' + r.expiresAt + '）\n   使用者：' + r.user + '\n\n';
    } else {
      msg += '✅ ' + r.label + '\n   有效（無過期資訊）\n\n';
    }
  }
  msg += warning ? '\n⚠️ 有 token 需要刷新！去 Graph API Explorer 重新換取。' : '\n所有 token 健康 ✨';
  return msg;
}

function getLastCheck() {
  try { return JSON.parse(fs.readFileSync(LAST_CHECK_FILE, 'utf8')); } catch { return null; }
}

module.exports = { checkTokenExpiry, checkAllTokens, formatReport, getLastCheck };
