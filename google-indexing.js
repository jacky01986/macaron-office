// google-indexing.js — 自動 submit 新文章到 Google Indexing API
// 環境變數：
//   GOOGLE_SERVICE_ACCOUNT_JSON  — Service Account 的整段 JSON 字串（base64 或原文都行）

const crypto = require('crypto');

function loadServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    if (raw.trim().startsWith('{')) return JSON.parse(raw);
    // try base64
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch (e) { return null; }
}

// 用 Service Account 取 OAuth access token
async function getAccessToken() {
  const sa = loadServiceAccount();
  if (!sa) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/indexing',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now
  })).toString('base64url');
  const signingInput = header + '.' + claims;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(sa.private_key).toString('base64url');
  const jwt = signingInput + '.' + signature;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(jwt)
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('No access token: ' + JSON.stringify(j));
  return j.access_token;
}

// Submit 一個 URL 到 Google Indexing API
async function submitUrl(url, type) {
  type = type || 'URL_UPDATED';
  const token = await getAccessToken();
  const res = await fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, type })
  });
  const j = await res.json();
  return { ok: res.ok, status: res.status, result: j };
}

// Batch submit
async function submitUrls(urls) {
  const results = [];
  for (const url of urls) {
    try { results.push({ url, ...(await submitUrl(url)) }); }
    catch (e) { results.push({ url, error: e.message }); }
    await new Promise(r => setTimeout(r, 200));
  }
  return results;
}

// 檢查 Service Account 配置是否 OK
function checkConfig() {
  const sa = loadServiceAccount();
  if (!sa) return { ok: false, reason: 'GOOGLE_SERVICE_ACCOUNT_JSON env var not set' };
  if (!sa.client_email || !sa.private_key) return { ok: false, reason: 'invalid JSON — missing client_email or private_key' };
  return { ok: true, client_email: sa.client_email, project_id: sa.project_id };
}

module.exports = { submitUrl, submitUrls, getAccessToken, checkConfig };
