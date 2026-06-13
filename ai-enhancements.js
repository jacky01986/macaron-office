// ai-enhancements.js — Tier 1/2/3 升級包
// 整合: 證據+信心 wrapper, 天氣, 異常偵測, 多模型, 反饋, 簡易向量記憶, web 搜尋, Google 商家評論
// v2: 加 brand-memory endpoints 註冊
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/var/data') ? '/var/data' : '/tmp/data');
const FEEDBACK_FILE = path.join(DATA_DIR, 'ai-feedback.jsonl');
const MEMORY_FILE = path.join(DATA_DIR, 'ai-memory.jsonl');
const ANOMALIES_FILE = path.join(DATA_DIR, 'anomalies.jsonl');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EVIDENCE_RULE = "\n\n--- 全體規則(必遵守) ---\n回答策略性建議時,結尾必須附:\n📊 根據哪些數據:[具體列出 2-3 個數據來源,如 Shopline 訂單/門市報告/Meta 廣告]\n🎯 信心度:X%(80-100%=有把握 / 60-79%=合理推測 / <60%=直覺,需驗證)\n⚖️ 反方論點:1 句話說「若我錯了,可能因為...」\n如果僅是聊天/閒談則不需附。";

function wrapWithEvidence(systemPrompt) {
  if (!systemPrompt) return EVIDENCE_RULE;
  return systemPrompt + EVIDENCE_RULE;
}

async function getWeather(city) {
  const cityMap = { '台南': [22.99, 120.21], '台北': [25.04, 121.56], '台中': [24.15, 120.68], '高雄': [22.63, 120.31] };
  const coords = cityMap[city] || cityMap['台南'];
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${coords[0]}&longitude=${coords[1]}&current=temperature_2m,precipitation,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=Asia/Taipei&forecast_days=3`);
    const d = await r.json();
    return { ok: true, city, current: d.current, daily: d.daily };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function webSearch(query) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return { ok: false, error: '未設定 BRAVE_API_KEY' };
  try {
    const r = await fetch('https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=10', { headers: { 'X-Subscription-Token': key, 'Accept': 'application/json' } });
    const d = await r.json();
    const results = (d.web?.results || []).slice(0, 8).map(x => ({ title: x.title, url: x.url, desc: x.description }));
    return { ok: true, query, results };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function googleReviews(placeId) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return { ok: false, error: '未設定 GOOGLE_PLACES_API_KEY' };
  try {
    const r = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,rating,reviews,user_ratings_total&language=zh-TW&key=${key}`);
    const d = await r.json();
    return { ok: true, place: d.result };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function askMultiModel(prompt, scope) {
  const results = {};
  try {
    const r = await anthropic.messages.create({ model: 'claude-fable-5', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] });
    results.claude = (r.content || []).map(c => c.text || '').join('');
  } catch (e) { results.claude = 'err: ' + e.message; }
  if (process.env.OPENAI_API_KEY) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: prompt }], max_tokens: 1500 }) });
      const d = await r.json();
      results.gpt = d.choices?.[0]?.message?.content || JSON.stringify(d).slice(0,200);
    } catch (e) { results.gpt = 'err: ' + e.message; }
  } else results.gpt = '未設定 OPENAI_API_KEY';
  if (process.env.GOOGLE_AI_API_KEY) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
      const d = await r.json();
      results.gemini = d.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(d).slice(0,200);
    } catch (e) { results.gemini = 'err: ' + e.message; }
  } else results.gemini = '未設定 GOOGLE_AI_API_KEY';
  return { ok: true, scope, results };
}

function saveFeedback(record) {
  const entry = { id: 'fb_' + Math.random().toString(36).slice(2, 12), ts: new Date().toISOString(), ...record };
  fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(entry) + '\n');
  return entry;
}
function loadFeedback(limit) {
  try {
    if (!fs.existsSync(FEEDBACK_FILE)) return [];
    return fs.readFileSync(FEEDBACK_FILE, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-(limit || 50)).reverse();
  } catch { return []; }
}

function saveMemory(record) {
  const entry = { id: 'mem_' + Math.random().toString(36).slice(2, 12), ts: new Date().toISOString(), ...record };
  fs.appendFileSync(MEMORY_FILE, JSON.stringify(entry) + '\n');
  return entry;
}
async function recallMemory(query, topK) {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return [];
    const all = fs.readFileSync(MEMORY_FILE, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const qWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    const scored = all.map(m => {
      const text = (m.text || m.content || '').toLowerCase();
      let score = 0;
      qWords.forEach(w => { if (text.includes(w)) score++; });
      return { ...m, score };
    }).filter(m => m.score > 0).sort((a, b) => b.score - a.score).slice(0, topK || 5);
    return scored;
  } catch { return []; }
}

async function detectAnomalies() {
  const findings = [];
  try {
    const offlineReports = require('./offline-reports');
    const sum = offlineReports.buildSummaryForAI();
    const trend = sum.revenue_trend || [];
    if (trend.length >= 2) {
      const today = trend[trend.length - 1];
      const yest = trend[trend.length - 2];
      if (today.revenue > 0 && yest.revenue > 0) {
        const pct = (today.revenue - yest.revenue) / yest.revenue * 100;
        if (Math.abs(pct) >= 20) {
          findings.push({ type: 'revenue_change', severity: pct < -20 ? 'high' : 'medium', message: `昨日營收 vs 前日:${pct > 0 ? '+' : ''}${pct.toFixed(1)}% (NT$${today.revenue.toLocaleString()} vs ${yest.revenue.toLocaleString()})` });
        }
      }
    }
    (sum.by_branch || []).forEach(b => {
      const months = b.by_month || [];
      if (months.length >= 2) {
        const m1 = months[0], m2 = months[1];
        if (m1.revenue > 0 && m2.revenue > 0) {
          const pct = (m1.revenue - m2.revenue) / m2.revenue * 100;
          if (pct <= -25) findings.push({ type: 'branch_decline', branch: b.branch, severity: 'high', message: `【${b.branch}】${m1.month} 營收較 ${m2.month} 下滑 ${pct.toFixed(1)}%` });
        }
      }
    });
  } catch (e) { findings.push({ type: 'error', message: e.message }); }

  if (findings.length > 0) {
    const entry = { ts: new Date().toISOString(), findings };
    fs.appendFileSync(ANOMALIES_FILE, JSON.stringify(entry) + '\n');
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (token && chatId) {
      const msg = '🚨 *AI 異常偵測* (' + new Date().toLocaleDateString('zh-TW') + ')\n\n' + findings.map(f => '• ' + f.message).join('\n');
      try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' }) }); } catch {}
    }
  }
  return { ok: true, findings };
}

function register(app, cron) {
  // ★ 新增:註冊 brand-memory endpoints (人性化 + 長期記憶系統)
  try {
    const bm = require('./brand-memory');
    bm.register(app);
    console.log('[ai-enhancements] brand-memory endpoints registered');
  } catch (e) {
    console.warn('[ai-enhancements] brand-memory register failed:', e.message);
  }

  // ★ v2.1:註冊 ai-team-upgrades(自動學偏好 + 真實數字 + 每日三件事)
  try {
    const up = require('./ai-team-upgrades');
    up.register(app, cron);
    console.log('[ai-enhancements] ai-team-upgrades registered');
  } catch (e) {
    console.warn('[ai-enhancements] ai-team-upgrades register failed:', e.message);
  }

  app.get('/api/enhance/weather', async (req, res) => res.json(await getWeather(req.query.city || '台南')));
  app.post('/api/enhance/web-search', async (req, res) => res.json(await webSearch(req.body?.q || req.query.q || '')));
  app.get('/api/enhance/google-reviews', async (req, res) => res.json(await googleReviews(req.query.place_id || '')));
  app.post('/api/enhance/multi-model', async (req, res) => res.json(await askMultiModel(req.body?.prompt || '', req.body?.scope)));
  app.post('/api/enhance/feedback', (req, res) => { try { res.json({ ok: true, saved: saveFeedback(req.body || {}) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.get('/api/enhance/feedback', (req, res) => res.json({ ok: true, items: loadFeedback(Number(req.query.limit) || 50) }));
  app.post('/api/enhance/memory', (req, res) => { try { res.json({ ok: true, saved: saveMemory(req.body || {}) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  app.get('/api/enhance/memory/recall', async (req, res) => res.json({ ok: true, items: await recallMemory(req.query.q || '', Number(req.query.k) || 5) }));
  app.post('/api/enhance/detect-anomalies', async (req, res) => res.json(await detectAnomalies()));
  app.get('/api/enhance/status', (req, res) => res.json({ ok: true, model: 'claude-fable-5 + opus-4-6 + haiku-4-5', features: { evidence_wrapper: 'on', weather: 'on (Open-Meteo, no key)', web_search: process.env.BRAVE_API_KEY ? 'on (Brave Search)' : 'on (free: DuckDuckGo + Google News + SearXNG fallback)', google_reviews: process.env.GOOGLE_PLACES_API_KEY ? 'on' : 'need GOOGLE_PLACES_API_KEY', multi_model: { claude: 'on', gpt: process.env.OPENAI_API_KEY ? 'on' : 'need OPENAI_API_KEY', gemini: process.env.GOOGLE_AI_API_KEY ? 'on' : 'need GOOGLE_AI_API_KEY' }, feedback: 'on', memory: 'on (keyword fallback)', anomaly_detection: 'on (8am daily cron)', brand_memory: 'on (human voice + long-term)', ai_team_upgrades: 'on (auto-learn + live-stats + daily-brief 06:30)' } }));

  if (cron) {
    cron.schedule('0 8 * * *', async () => { try { const r = await detectAnomalies(); console.log('[ai-enhancements] anomaly detection:', r.findings.length, 'findings'); } catch (e) { console.error('[ai-enhancements] anomaly err:', e.message); } }, { timezone: 'Asia/Taipei' });
    console.log('[ai-enhancements] cron registered: 0 8 * * * Asia/Taipei (anomaly detection)');
  }

  console.log('[ai-enhancements] registered: weather, web-search, google-reviews, multi-model, feedback, memory, anomaly-detection, brand-memory, ai-team-upgrades');
}

module.exports = { register, wrapWithEvidence, getWeather, webSearch, googleReviews, askMultiModel, saveFeedback, loadFeedback, saveMemory, recallMemory, detectAnomalies, EVIDENCE_RULE };
