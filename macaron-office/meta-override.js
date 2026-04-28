// meta-override.js — Meta 多帳戶切換器後端邏輯
// 把切換覆寫存到 data/meta-override.json，並 mutate process.env
// meta.js 每次都讀 process.env，不用改 meta.js

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const OVERRIDE_FILE = path.join(DATA_DIR, 'meta-override.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getOverride() {
  ensureDir();
  if (!fs.existsSync(OVERRIDE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8')); } catch { return {}; }
}

function applyToEnv(payload) {
  if (!payload) return;
  if (payload.pageId) process.env.META_FB_PAGE_ID = String(payload.pageId);
  if (payload.igId) process.env.META_IG_USER_ID = String(payload.igId);
  if (payload.adAccountId) {
    let v = String(payload.adAccountId);
    if (!v.startsWith('act_')) v = 'act_' + v;
    process.env.META_AD_ACCOUNT_ID = v;
  }
}

function setOverride(payload) {
  ensureDir();
  const merged = Object.assign(getOverride(), payload || {});
  fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(merged, null, 2));
  applyToEnv(merged);
  return merged;
}

function clearOverride() {
  if (fs.existsSync(OVERRIDE_FILE)) fs.unlinkSync(OVERRIDE_FILE);
  return {};
}

function applyOnStartup() {
  const ov = getOverride();
  if (Object.keys(ov).length > 0) {
    applyToEnv(ov);
    console.log('[meta-override] restored overrides:', Object.keys(ov).join(','));
  }
}

async function metaGraph(endpoint, params = {}) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('META_ACCESS_TOKEN not set');
  const url = new URL('https://graph.facebook.com/v19.0' + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('access_token', token);
  const res = await fetch(url.toString());
  const j = await res.json();
  if (!res.ok || j.error) throw new Error('Graph API: ' + (j.error?.message || res.status));
  return j;
}

async function listAssets() {
  const result = { pages: [], ad_accounts: [], current: null };

  try {
    const pagesRes = await metaGraph('/me/accounts', {
      fields: 'id,name,instagram_business_account{id,username},access_token',
      limit: 100,
    });
    result.pages = (pagesRes.data || []).map(p => ({
      pageId: p.id,
      name: p.name,
      igId: p.instagram_business_account?.id || null,
      igUsername: p.instagram_business_account?.username || null,
    }));
  } catch (e) {
    result.pages_error = e.message;
  }

  try {
    const adRes = await metaGraph('/me/adaccounts', {
      fields: 'id,account_id,name,account_status,currency',
      limit: 100,
    });
    result.ad_accounts = (adRes.data || []).map(a => ({
      adAccountId: a.id,
      account_id: a.account_id,
      name: a.name,
      status: a.account_status === 1 ? 'active' : 'disabled',
      currency: a.currency,
    }));
  } catch (e) {
    result.ad_accounts_error = e.message;
  }

  result.current = {
    pageId: process.env.META_FB_PAGE_ID || null,
    igId: process.env.META_IG_USER_ID || null,
    adAccountId: process.env.META_AD_ACCOUNT_ID || null,
  };
  result.override = getOverride();

  return result;
}

module.exports = { getOverride, setOverride, clearOverride, applyOnStartup, listAssets };
