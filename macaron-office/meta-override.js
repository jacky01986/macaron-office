// meta-override.js — Meta 多帳戶切換器後端邏輯
// env: META_ACCESS_TOKEN（要 business_management + pages_show_list + ads_management 權限）

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
  if (!res.ok || j.error) throw new Error('Graph: ' + (j.error?.message || res.status));
  return j;
}

// Try multiple strategies for listing pages
async function listAllPages() {
  const seen = new Map();
  const errors = [];

  // Strategy 1: /me/accounts (works if user is direct page admin)
  try {
    const r = await metaGraph('/me/accounts', {
      fields: 'id,name,instagram_business_account{id,username}',
      limit: 100,
    });
    (r.data || []).forEach(p => {
      seen.set(p.id, {
        pageId: p.id,
        name: p.name,
        igId: p.instagram_business_account?.id || null,
        igUsername: p.instagram_business_account?.username || null,
        source: 'me/accounts',
      });
    });
  } catch (e) {
    errors.push('me/accounts: ' + e.message);
  }

  // Strategy 2: /me/businesses → /{biz_id}/owned_pages + /{biz_id}/client_pages
  try {
    const bizRes = await metaGraph('/me/businesses', { fields: 'id,name', limit: 100 });
    const businesses = bizRes.data || [];
    for (const biz of businesses) {
      // owned_pages
      try {
        const op = await metaGraph('/' + biz.id + '/owned_pages', {
          fields: 'id,name,instagram_business_account{id,username}',
          limit: 100,
        });
        (op.data || []).forEach(p => {
          if (!seen.has(p.id)) {
            seen.set(p.id, {
              pageId: p.id,
              name: p.name,
              igId: p.instagram_business_account?.id || null,
              igUsername: p.instagram_business_account?.username || null,
              source: 'biz:' + biz.name,
              business: biz.name,
            });
          }
        });
      } catch (e) {
        errors.push('biz ' + biz.name + ' owned_pages: ' + e.message);
      }
      // client_pages (pages shared FROM partners)
      try {
        const cp = await metaGraph('/' + biz.id + '/client_pages', {
          fields: 'id,name,instagram_business_account{id,username}',
          limit: 100,
        });
        (cp.data || []).forEach(p => {
          if (!seen.has(p.id)) {
            seen.set(p.id, {
              pageId: p.id,
              name: p.name,
              igId: p.instagram_business_account?.id || null,
              igUsername: p.instagram_business_account?.username || null,
              source: 'biz_client:' + biz.name,
              business: biz.name,
            });
          }
        });
      } catch (e) {/* client_pages often empty */}
    }
  } catch (e) {
    errors.push('me/businesses: ' + e.message);
  }

  return { pages: Array.from(seen.values()), errors };
}

async function listAllAdAccounts() {
  const seen = new Map();
  const errors = [];

  // Strategy 1: /me/adaccounts
  try {
    const r = await metaGraph('/me/adaccounts', {
      fields: 'id,account_id,name,account_status,currency',
      limit: 100,
    });
    (r.data || []).forEach(a => {
      seen.set(a.id, {
        adAccountId: a.id,
        account_id: a.account_id,
        name: a.name,
        status: a.account_status === 1 ? 'active' : 'disabled',
        currency: a.currency,
        source: 'me/adaccounts',
      });
    });
  } catch (e) {
    errors.push('me/adaccounts: ' + e.message);
  }

  // Strategy 2: /me/businesses → /{biz_id}/owned_ad_accounts + /{biz_id}/client_ad_accounts
  try {
    const bizRes = await metaGraph('/me/businesses', { fields: 'id,name', limit: 100 });
    const businesses = bizRes.data || [];
    for (const biz of businesses) {
      for (const path of ['owned_ad_accounts', 'client_ad_accounts']) {
        try {
          const r = await metaGraph('/' + biz.id + '/' + path, {
            fields: 'id,account_id,name,account_status,currency',
            limit: 100,
          });
          (r.data || []).forEach(a => {
            if (!seen.has(a.id)) {
              seen.set(a.id, {
                adAccountId: a.id,
                account_id: a.account_id,
                name: a.name,
                status: a.account_status === 1 ? 'active' : 'disabled',
                currency: a.currency,
                source: path + ':' + biz.name,
                business: biz.name,
              });
            }
          });
        } catch (e) {/* often one of two paths returns empty */}
      }
    }
  } catch (e) {
    errors.push('me/businesses (for ads): ' + e.message);
  }

  return { ad_accounts: Array.from(seen.values()), errors };
}

async function listAssets() {
  const result = { pages: [], ad_accounts: [], current: null, debug: {} };

  const pagesResult = await listAllPages();
  result.pages = pagesResult.pages;
  if (pagesResult.errors.length) result.debug.pages_errors = pagesResult.errors;

  const adsResult = await listAllAdAccounts();
  result.ad_accounts = adsResult.ad_accounts;
  if (adsResult.errors.length) result.debug.ad_accounts_errors = adsResult.errors;

  result.current = {
    pageId: process.env.META_FB_PAGE_ID || null,
    igId: process.env.META_IG_USER_ID || null,
    adAccountId: process.env.META_AD_ACCOUNT_ID || null,
  };
  result.override = getOverride();

  return result;
}

module.exports = { getOverride, setOverride, clearOverride, applyOnStartup, listAssets };
