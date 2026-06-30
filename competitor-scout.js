// competitor-scout.js - Scan FB Ad Library for competitor ads
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const SNAPSHOT_FILE = path.join(DATA_DIR, 'competitor_snapshot.json');
const HISTORY_FILE = path.join(DATA_DIR, 'competitor_history.jsonl');

const KEYWORDS = ['馬卡龍', '費南雪', 'financier', '法朋', '亞尼克', 'Paul', 'Ladurée', 'Pierre Hermé', '韓系甜點', '韓系禮盒', '韓系精品'];

function appendHistory(e) { try { fs.appendFileSync(HISTORY_FILE, JSON.stringify(e) + '\n'); } catch {} }

function loadSnapshot() {
  try { return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')); } catch { return { ts: null, ads: [] }; }
}

// Fetch ads from Meta Ad Library API for one keyword
async function fetchByKeyword(keyword, limit = 25) {
  const token = process.env.META_ACCESS_TOKEN || process.env.META_USER_TOKEN || process.env.META_CAPI_TOKEN;
  if (!token) throw new Error('Meta token not set');
  
  const fields = [
    'id',
    'page_id',
    'page_name',
    'ad_creative_bodies',
    'ad_creative_link_titles',
    'ad_creative_link_descriptions',
    'ad_creative_link_captions',
    'ad_delivery_start_time',
    'ad_delivery_stop_time',
    'ad_snapshot_url',
    'impressions',
    'spend',
    'publisher_platforms'
  ].join(',');
  
  const url = 'https://graph.facebook.com/v19.0/ads_archive?' +
    'search_terms=' + encodeURIComponent(keyword) +
    '&ad_reached_countries=' + encodeURIComponent('["TW"]') +
    '&ad_active_status=ACTIVE' +
    '&ad_type=ALL' +
    '&fields=' + encodeURIComponent(fields) +
    '&limit=' + limit +
    '&access_token=' + encodeURIComponent(token);
  
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.error) throw new Error('[' + keyword + '] ' + data.error.message);
  return data.data || [];
}

// Calculate "ad heat score": longer-running + wider impression range = more proven
function calcHeatScore(ad) {
  let score = 0;
  // Duration: longer = more proven
  if (ad.ad_delivery_start_time) {
    const startMs = new Date(ad.ad_delivery_start_time).getTime();
    const days = Math.max(1, Math.floor((Date.now() - startMs) / 86400000));
    score += Math.min(days, 30); // cap at 30
  }
  // Impressions range (Meta returns lower/upper bound)
  if (ad.impressions && ad.impressions.lower_bound) {
    const lower = Number(ad.impressions.lower_bound);
    if (lower >= 100000) score += 50;
    else if (lower >= 10000) score += 30;
    else if (lower >= 1000) score += 15;
  }
  return score;
}

// Run full scan across all keywords
async function scanAll() {
  const allAds = new Map(); // dedup by ad.id
  const errors = [];
  
  for (const kw of KEYWORDS) {
    try {
      const ads = await fetchByKeyword(kw, 25);
      for (const a of ads) {
        if (a.id && !allAds.has(a.id)) {
          a._matchedKeyword = kw;
          a._heat = calcHeatScore(a);
          allAds.set(a.id, a);
        }
      }
    } catch (e) {
      errors.push({ keyword: kw, error: e.message });
    }
  }
  
  const list = Array.from(allAds.values()).sort((a, b) => b._heat - a._heat);
  const snapshot = { ts: new Date().toISOString(), total: list.length, ads: list, errors };
  try { fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot)); } catch {}
  appendHistory({ ts: snapshot.ts, total: list.length, errors: errors.length });
  return snapshot;
}

// Get top N ads with formatted info
function topAds(n = 5) {
  const snap = loadSnapshot();
  return (snap.ads || []).slice(0, n).map(a => ({
    page: a.page_name,
    keyword: a._matchedKeyword,
    body: (a.ad_creative_bodies && a.ad_creative_bodies[0]) || '',
    title: (a.ad_creative_link_titles && a.ad_creative_link_titles[0]) || '',
    desc: (a.ad_creative_link_descriptions && a.ad_creative_link_descriptions[0]) || '',
    cta: (a.ad_creative_link_captions && a.ad_creative_link_captions[0]) || '',
    started: (a.ad_delivery_start_time || '').slice(0, 10),
    impressions: a.impressions && (a.impressions.lower_bound + '~' + a.impressions.upper_bound),
    snapshot_url: a.ad_snapshot_url,
    heat: a._heat
  }));
}

// Format weekly report for Telegram
function weeklyReport(n = 5) {
  const snap = loadSnapshot();
  if (!snap.ts) return '尚未掃描競品廣告，請先呼叫 scanAll()';
  
  const top = topAds(n);
  let msg = '📡 *本週競品廣告 TOP ' + n + '*\n';
  msg += '掃描時間：' + snap.ts.slice(0, 10) + ' · 抓到 ' + snap.total + ' 個活躍廣告\n\n';
  
  for (let i = 0; i < top.length; i++) {
    const a = top[i];
    msg += '*' + (i + 1) + '. ' + (a.page || 'Unknown') + '* (熱度 ' + a.heat + ')\n';
    msg += '🔑 關鍵字：' + a.keyword + ' · 從 ' + a.started + '\n';
    if (a.title) msg += '📌 標題：' + a.title.slice(0, 60) + '\n';
    if (a.body) msg += '📝 ' + a.body.slice(0, 100) + '\n';
    if (a.impressions) msg += '👁 曝光區間：' + a.impressions + '\n';
    if (a.snapshot_url) msg += '🔗 看廣告：' + a.snapshot_url + '\n';
    msg += '\n';
  }
  return msg;
}

// AI analysis of competitor ads (uses Claude to extract patterns)
async function analyzeWithAI() {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const top = topAds(10);
  if (top.length === 0) return '無資料可分析，請先掃描';
  
  const adsText = top.map((a, i) => 
    (i + 1) + '. [' + a.page + ']\n標題：' + a.title + '\n內文：' + a.body + '\nCTA：' + a.cta + '\n啟動：' + a.started
  ).join('\n\n');
  
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',  // [token-opt] Sonnet→Haiku (判斷類,5x 省)
    max_tokens: 1500,
    system: '你是 溫點 WarmPlace 的 AI 廣告投手 LEON。分析以下競品廣告（含法朋、亞尼克、Paul、Ladurée、Pierre Hermé 等韓系甜點 / 禮盒品牌），找出共同模式：(1) 熱門訴求點 (2) 價格與禮盒策略 (3) CTA 模式 (4) 字數/語氣 (5) 我們可以偷學的 3 個技巧。輸出繁中、條列、簡潔。',
    messages: [{ role: 'user', content: '請分析以下台灣韓系甜點 / 馬卡龍 / 高端禮盒業界正在跑的廣告：\n\n' + adsText }]
  });
  return resp.content[0].text.trim();
}

module.exports = { scanAll, topAds, weeklyReport, analyzeWithAI, loadSnapshot, KEYWORDS };
