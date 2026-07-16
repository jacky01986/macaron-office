// gdrive-sync.js
// Google Drive 同步模組 — 用 Node 內建 crypto 簽 JWT,免裝 googleapis
// 流程:每小時掃資料夾 → 找新檔 → 下載 → 餵 offline-reports 萃取

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/var/data') ? '/var/data' : '/tmp/data');
const PROCESSED_FILE = path.join(DATA_DIR, 'gdrive-processed.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'gdrive-state.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// ============ 設定 ============
function getServiceAccount() {
  const raw = process.env.GDRIVE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GDRIVE_SERVICE_ACCOUNT_JSON not set');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('GDRIVE_SERVICE_ACCOUNT_JSON parse fail: ' + e.message);
  }
}
function getFolderId() {
  const id = process.env.GDRIVE_FOLDER_ID;
  if (!id) throw new Error('GDRIVE_FOLDER_ID not set');
  return id;
}

// ============ JWT + Access Token ============
let _tokenCache = null;
async function getAccessToken() {
  if (_tokenCache && _tokenCache.expires > Date.now() + 60000) return _tokenCache.token;
  const sa = getServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = b64(header) + '.' + b64(claim);
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(sa.private_key, 'base64url');
  const jwt = unsigned + '.' + signature;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(jwt)
  });
  if (!res.ok) throw new Error('token fetch failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const d = await res.json();
  _tokenCache = { token: d.access_token, expires: Date.now() + (d.expires_in * 1000) };
  return d.access_token;
}

// ============ Drive API ============
async function listFolderFiles() {
  const token = await getAccessToken();
  const folderId = getFolderId();
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const fields = encodeURIComponent('files(id,name,mimeType,size,modifiedTime,createdTime,parents,shortcutDetails)');
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('list failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const d = await res.json();
  // Resolve shortcuts to their target metadata
  const out = [];
  for (const f of (d.files || [])) {
    if (f.mimeType === 'application/vnd.google-apps.shortcut' && f.shortcutDetails && f.shortcutDetails.targetId) {
      try {
        const targetFields = encodeURIComponent('id,name,mimeType,size,modifiedTime,createdTime');
        const targetUrl = `https://www.googleapis.com/drive/v3/files/${f.shortcutDetails.targetId}?fields=${targetFields}`;
        const tr = await fetch(targetUrl, { headers: { Authorization: 'Bearer ' + token } });
        if (tr.ok) {
          const target = await tr.json();
          // Use shortcut's display name + target's mimeType/id for download
          out.push({
            id: target.id,
            name: f.name,  // shortcut filename (人類可讀)
            mimeType: target.mimeType,  // target 的真實 mimeType
            size: target.size,
            modifiedTime: target.modifiedTime || f.modifiedTime,
            createdTime: target.createdTime || f.createdTime,
            _isShortcut: true,
            _shortcutId: f.id
          });
        } else {
          out.push({ ...f, _resolveError: 'target inaccessible: ' + tr.status });
        }
      } catch (e) {
        out.push({ ...f, _resolveError: 'target fetch err: ' + e.message });
      }
    } else {
      out.push(f);
    }
  }
  return out;
}

async function downloadFile(fileId, mimeType) {
  const token = await getAccessToken();
  // Google Docs/Sheets 需要 export,其他直接 alt=media
  const googleNative = {
    'application/vnd.google-apps.document': 'application/pdf',
    'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.google-apps.presentation': 'application/pdf'
  };
  let url, exportMime;
  if (googleNative[mimeType]) {
    exportMime = googleNative[mimeType];
    url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`;
  } else {
    url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  }
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('download failed: ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, exportedMime: exportMime };
}

// ============ 已處理檔案紀錄 ============
function loadProcessed() {
  try {
    if (!fs.existsSync(PROCESSED_FILE)) return new Map();
    const m = new Map();
    fs.readFileSync(PROCESSED_FILE, 'utf8').split('\n').filter(Boolean).forEach(l => {
      try { const o = JSON.parse(l); m.set(o.id, o); } catch {}
    });
    return m;
  } catch { return new Map(); }
}
function markProcessed(file, extra = {}) {
  const entry = { id: file.id, name: file.name, mimeType: file.mimeType, modifiedTime: file.modifiedTime, processedAt: new Date().toISOString(), ...extra };
  fs.appendFileSync(PROCESSED_FILE, JSON.stringify(entry) + '\n');
  return entry;
}
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { return {}; }
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

// ============ 主流程:同步 ============
async function syncAll(opts = {}) {
  const summary = { startedAt: new Date().toISOString(), newFiles: [], skipped: [], errors: [], totalFound: 0 };
  let files;
  try {
    files = await listFolderFiles();
  } catch (e) {
    summary.errors.push({ phase: 'list', error: e.message });
    summary.finishedAt = new Date().toISOString();
    return summary;
  }
  summary.totalFound = files.length;
  const processed = loadProcessed();

  for (const file of files) {
    const prev = processed.get(file.id);
    if (prev && prev.modifiedTime === file.modifiedTime && !opts.force) {
      summary.skipped.push({ id: file.id, name: file.name, reason: 'already processed' });
      continue;
    }
    try {
      const { buffer, exportedMime } = await downloadFile(file.id, file.mimeType);
      let processedRecord;
      // Hand off to offline-reports extraction if available
      try {
        const offline = require('./offline-reports');
        if (typeof offline.processBuffer === 'function') {
          processedRecord = await offline.processBuffer(buffer, {
            originalName: file.name,
            mimeType: exportedMime || file.mimeType,
            source: 'gdrive',
            gdriveFileId: file.id,
            modifiedTime: file.modifiedTime
          });
        }
      } catch (e) {
        summary.errors.push({ id: file.id, name: file.name, phase: 'extract', error: e.message });
      }
      markProcessed(file, { extractedRecordId: processedRecord && processedRecord.id });
      summary.newFiles.push({ id: file.id, name: file.name, size: file.size, extractedRecordId: processedRecord && processedRecord.id });
    } catch (e) {
      summary.errors.push({ id: file.id, name: file.name, phase: 'download', error: e.message });
    }
  }

  const state = loadState();
  state.lastSync = new Date().toISOString();
  state.lastSummary = summary;
  saveState(state);
  summary.finishedAt = new Date().toISOString();
  return summary;
}

// ============ Async Job 模式 ============
const _jobs = new Map();
function startSyncJob(opts = {}) {
  const jobId = 'gds_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const job = { id: jobId, status: 'running', result: null, error: null, startedAt: new Date().toISOString(), finishedAt: null };
  _jobs.set(jobId, job);
  // Cleanup old jobs > 1h
  const now = Date.now();
  for (const [k, j] of _jobs.entries()) {
    if (j.finishedAt && (now - new Date(j.finishedAt).getTime() > 3600000)) _jobs.delete(k);
  }
  Promise.resolve().then(async () => {
    try {
      const r = await syncAll(opts);
      job.status = (r.errors && r.errors.length > 0 && r.newFiles.length === 0) ? 'error' : 'done';
      job.result = r;
      job.finishedAt = new Date().toISOString();
      console.log('[gdrive-sync]', jobId, 'done:', r.newFiles.length, 'new,', r.skipped.length, 'skipped,', r.errors.length, 'errors');
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      job.finishedAt = new Date().toISOString();
      console.error('[gdrive-sync]', jobId, 'error:', e.message);
    }
  });
  return job;
}
function getJob(id) { return _jobs.get(id); }

// ============ 健康檢查 ============
async function healthCheck() {
  const out = { configured: false, drive_api_reachable: false, folder_accessible: false, processed_count: 0, last_sync: null };
  try { getServiceAccount(); getFolderId(); out.configured = true; } catch (e) { out.config_error = e.message; return out; }
  try {
    const files = await listFolderFiles();
    out.drive_api_reachable = true;
    out.folder_accessible = true;
    out.files_in_folder = files.length;
  } catch (e) { out.connection_error = e.message; }
  out.processed_count = loadProcessed().size;
  out.last_sync = loadState().lastSync || null;
  return out;
}

// ============ Express 路由註冊 ============
function register(app, cron) {
  app.get('/api/offline-reports/gdrive/status', async (req, res) => {
    try { res.json(await healthCheck()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/offline-reports/gdrive/processed', (req, res) => {
    try {
      const items = [...loadProcessed().values()].sort((a, b) => (b.processedAt || '').localeCompare(a.processedAt || ''));
      res.json({ ok: true, count: items.length, items: items.slice(0, Number(req.query.limit) || 100) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Debug: list Drive files raw with mimeType
  app.get('/api/offline-reports/gdrive/debug/files', async (req, res) => {
    try {
      const files = await listFolderFiles();
      let saEmail = null; try { saEmail = getServiceAccount().client_email; } catch (e) {}
      res.json({ ok: true, serviceAccountEmail: saEmail, count: files.length, files });
    } catch (e) { res.status(500).json({ ok: false, error: e.message, stack: e.stack }); }
  });

  // Debug: try to download a specific file and report status
  app.get('/api/offline-reports/gdrive/debug/download/:fileId', async (req, res) => {
    try {
      const files = await listFolderFiles();
      const file = files.find(f => f.id === req.params.fileId);
      if (!file) return res.status(404).json({ ok: false, error: 'file not in folder' });
      const token = await getAccessToken();
      const googleNative = {
        'application/vnd.google-apps.document': 'application/pdf',
        'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.google-apps.presentation': 'application/pdf'
      };
      let url, mode;
      if (googleNative[file.mimeType]) {
        mode = 'export';
        url = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${encodeURIComponent(googleNative[file.mimeType])}`;
      } else {
        mode = 'alt=media';
        url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
      }
      const dr = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      const status = dr.status;
      let body = '';
      try { body = (await dr.text()).substring(0, 500); } catch {}
      res.json({ ok: dr.ok, file, mode, url, downloadStatus: status, bodyPreview: body });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Async job POST
  app.post('/api/offline-reports/gdrive/sync-now', (req, res) => {
    try {
      const force = req.query.force === '1' || (req.body && req.body.force);
      const job = startSyncJob({ force });
      res.json({ ok: true, status: 'started', jobId: job.id });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Poll job GET
  app.get('/api/offline-reports/gdrive/sync-now/:jobId', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, error: 'job not found' });
    res.json({ ok: true, status: job.status, result: job.result, error: job.error, startedAt: job.startedAt, finishedAt: job.finishedAt });
  });

  // Cron: 每小時 :05 同步
  if (cron) {
    cron.schedule('5 * * * *', async () => {
      try {
        const r = await syncAll();
        console.log('[gdrive-sync] hourly:', r.newFiles.length, 'new files,', r.errors.length, 'errors');
      } catch (e) { console.error('[gdrive-sync] hourly err:', e.message); }
    }, { timezone: 'Asia/Taipei' });
    console.log('[gdrive-sync] cron registered: 5 * * * * Asia/Taipei (hourly sync)');
  }

  console.log('[gdrive-sync] routes mounted: status, processed, sync-now (POST), sync-now/:jobId (GET)');
}

module.exports = { register, syncAll, startSyncJob, getJob, healthCheck, listFolderFiles, downloadFile, getAccessToken };
