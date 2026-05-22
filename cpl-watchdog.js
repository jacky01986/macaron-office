// cpl-watchdog.js — CPL alert + auto pause
const ALERT_CPL = parseInt(process.env.ALERT_CPL_NTD || '500');
const AUTO_PAUSE_CPL = parseInt(process.env.AUTO_PAUSE_CPL_NTD || '800');
const NOTIFY_COOLDOWN_HOURS = 4;
const fs = require('fs');
const path = require('path');
const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'cpl_watchdog.json');
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { last_alerts: {} }; } }
function saveState(s) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch {} }
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try { await fetch('https://api.telegram.org/bot' + token + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }) }); } catch {}
}
function shouldAlert(state, key) { const last = state.last_alerts[key]; if (!last) return true; return Date.now() - last > NOTIFY_COOLDOWN_HOURS * 3600000; }
async function checkAndAlert() {
  const meta = (() => { try { return require('./meta'); } catch { return null; } })();
  if (!meta || !meta.getAdsWithInsights) return { ok: false, error: 'meta missing' };
  const ads = await meta.getAdsWithInsights({ days: 1 });
  const list = (ads && (ads.data || ads)) || [];
  if (!list.length) return { ok: true, message: 'no ads' };
  const byCampaign = {};
  for (const a of list) {
    const cname = a.campaign_name || 'unknown';
    if (!byCampaign[cname]) byCampaign[cname] = { campaign_id: a.campaign_id, spend: 0, clicks: 0, impressions: 0 };
    const ins = a.insights || a;
    byCampaign[cname].spend += parseFloat(ins.spend || 0);
    byCampaign[cname].clicks += parseInt(ins.clicks || 0);
    byCampaign[cname].impressions += parseInt(ins.impressions || 0);
  }
  let leadByDay = 0;
  try { const r = await fetch('http://localhost:' + (process.env.PORT || 10000) + '/api/roas/today?days=1').then(x => x.json()); leadByDay = r.lead_count || 0; } catch {}
  const totalSpend = Object.values(byCampaign).reduce((s, c) => s + c.spend, 0);
  const state = loadState();
  const alerts = [];
  for (const [cname, c] of Object.entries(byCampaign)) {
    const cLeads = totalSpend > 0 ? Math.round(leadByDay * (c.spend / totalSpend)) : 0;
    const cpl = cLeads > 0 ? Math.round(c.spend / cLeads) : (c.spend > 100 ? 9999 : 0);
    if (cpl >= AUTO_PAUSE_CPL && shouldAlert(state, 'pause_' + cname)) {
      state.last_alerts['pause_' + cname] = Date.now();
      alerts.push({ level: 'CRITICAL', campaign: cname, cpl, leads: cLeads, spend: Math.round(c.spend) });
      if (c.campaign_id && meta.pauseCampaign) { try { await meta.pauseCampaign(c.campaign_id); } catch (e) {} }
      await sendTelegram('🚨 CPL 危險警報\nCampaign：' + cname + '\n今日 CPL：NT$' + cpl + ' (> NT$' + AUTO_PAUSE_CPL + ')\n今日花費：NT$' + Math.round(c.spend) + '\n→ 已自動暫停');
    } else if (cpl >= ALERT_CPL && shouldAlert(state, 'alert_' + cname)) {
      state.last_alerts['alert_' + cname] = Date.now();
      alerts.push({ level: 'WARNING', campaign: cname, cpl, leads: cLeads, spend: Math.round(c.spend) });
      await sendTelegram('⚠️ CPL 警報\nCampaign：' + cname + '\n今日 CPL：NT$' + cpl + '\n今日花費：NT$' + Math.round(c.spend) + '\n→ 建議檢查素材/受眾');
    }
  }
  saveState(state);
  return { ok: true, alerts, total_campaigns_checked: Object.keys(byCampaign).length };
}
module.exports = { checkAndAlert };
