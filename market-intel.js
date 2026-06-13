// ============================================================
// 溫點 WarmPlace · 市場情報系統
// 每天爬全台網路馬卡龍/費南雪數據 → 注入 VICTOR + 整個 AI 團隊
// ============================================================
//
// 來源:
//   1. Google News RSS (馬卡龍 / 費南雪 / 韓系甜點)
//   2. FB Ads Library (對手在跑什麼廣告)
//   3. 對手品牌動態 (法朋、亞尼克、Paul、Ladurée、Pierre Hermé)
//
// 用法:
//   const intel = require('./market-intel');
//   await intel.runDailyScan();          // 跑一次完整爬蟲
//   const ctx = intel.getMarketIntelContext();  // 取最新摘要(注入 AI prompt)
//   const data = intel.loadLatestIntel();        // 取完整 JSON

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');

// 馬卡龍 / 費南雪相關核心關鍵字(用來搜新聞)
const NEWS_KEYWORDS = [
  '馬卡龍',
  '費南雪',
  '韓系甜點 禮盒',
  '婚禮 小物 甜點',
  '企業 送禮',
];

// 對手品牌名(用來搜廣告 + 新聞)
const COMPETITORS = [
  '法朋',
  '亞尼克',
  'Paul',
  'Ladurée',
  'Pierre Hermé',
  'Aux Merveilleux',
];

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function intelFile(date = todayKey()) {
  return path.join(DATA_DIR, `market-intel-${date}.json`);
}

// ============================================================
// Google News RSS 爬蟲(免 API key)
// ============================================================
async function fetchGoogleNewsRss(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    });
    if (!r.ok) return [];
    const xml = await r.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRegex.exec(xml)) !== null) {
      const block = m[1];
      const titleM = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
      const linkM = block.match(/<link>([\s\S]*?)<\/link>/);
      const pubM = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      const srcM = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);
      const title = (titleM && titleM[1]) ? titleM[1].trim() : '';
      const link = (linkM && linkM[1]) ? linkM[1].trim() : '';
      const pubDate = (pubM && pubM[1]) ? pubM[1].trim() : '';
      const source = (srcM && srcM[1]) ? srcM[1].trim() : '';
      if (title) items.push({ title, link, pubDate, source });
      if (items.length >= 15) break;
    }
    return items;
  } catch (e) {
    console.error('[market-intel:googleNews]', e.message);
    return [];
  }
}

// ============================================================
// Facebook Ads Library 爬蟲(用 Page Token)
// ============================================================
async function fetchFbAdsLibrary(searchTerms) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return { error: 'META_ACCESS_TOKEN not set' };
  const allAds = [];
  for (const term of searchTerms) {
    try {
      const url = `https://graph.facebook.com/v22.0/ads_archive?search_terms=${encodeURIComponent(term)}&ad_reached_countries=TW&ad_active_status=ACTIVE&fields=id,ad_creative_bodies,ad_creative_link_titles,page_name,ad_delivery_start_time&limit=10&access_token=${token}`;
      const r = await fetch(url);
      const d = await r.json();
      if (d.data && Array.isArray(d.data)) {
        for (const ad of d.data) {
          allAds.push({
            id: ad.id,
            page: ad.page_name || '',
            body: ((ad.ad_creative_bodies && ad.ad_creative_bodies[0]) || '').slice(0, 200),
            title: ((ad.ad_creative_link_titles && ad.ad_creative_link_titles[0]) || '').slice(0, 100),
            start: ad.ad_delivery_start_time || '',
            search_term: term,
          });
        }
      }
      if (allAds.length >= 60) break;
    } catch (e) {
      console.error('[market-intel:fbAds]', term, e.message);
    }
  }
  return allAds.slice(0, 60);
}

// ============================================================
// PTT 看板搜尋 (免 API, 用 Google Site Search 抓 PTT)
// ============================================================
async function fetchPtt(keyword) {
  const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(keyword + ' site:ptt.cc') + '&hl=zh-TW&gl=TW&ceid=TW:zh-Hant';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    const xml = await r.text();
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) !== null && items.length < 10) {
      const b = m[1];
      const t = b.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
      const l = b.match(/<link>([\s\S]*?)<\/link>/);
      const d = b.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      if (t) items.push({ title: t[1].trim(), link: l && l[1] && l[1].trim(), pubDate: d && d[1] && d[1].trim(), source: 'PTT' });
    }
    return items;
  } catch (e) { console.error('[ptt]', e.message); return []; }
}

// ============================================================
// Dcard 公開 API 搜尋
// ============================================================
async function fetchDcard(keyword) {
  const url = 'https://www.dcard.tw/service/api/v2/search/posts?query=' + encodeURIComponent(keyword) + '&limit=10';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    if (!r.ok) return [];
    const data = await r.json();
    if (!Array.isArray(data)) return [];
    return data.slice(0, 10).map(p => ({
      title: p.title,
      excerpt: (p.excerpt || '').slice(0, 100),
      forum: p.forumName,
      like: p.likeCount,
      comment: p.commentCount,
      at: p.createdAt,
      link: 'https://www.dcard.tw/f/' + (p.forumAlias || '') + '/p/' + p.id,
      source: 'Dcard',
    }));
  } catch (e) { console.error('[dcard]', e.message); return []; }
}

// ============================================================
// Google Trends 每日熱門 (RSS, 免 API)
// ============================================================
async function fetchGoogleTrends() {
  const url = 'https://trends.google.com/trending/rss?geo=TW';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    const xml = await r.text();
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) !== null && items.length < 20) {
      const b = m[1];
      const t = b.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
      const tr = b.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/);
      const news = b.match(/<ht:news_item_title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ht:news_item_title>/);
      if (t) items.push({
        keyword: t[1].trim(),
        traffic: tr && tr[1] && tr[1].trim(),
        related_news: news && news[1] && news[1].trim(),
        source: 'GoogleTrends',
      });
    }
    return items;
  } catch (e) { console.error('[gtrends]', e.message); return []; }
}

// ============================================================
// 完整每日掃描
// ============================================================
async function runDailyScan() {
  console.log('[market-intel] starting daily scan...');
  const result = {
    date: todayKey(),
    started_at: new Date().toISOString(),
    keywords: NEWS_KEYWORDS,
    competitors: COMPETITORS,
    google_news: {},
    fb_ads: [],
    summary_stats: {},
  };

  // 1) Google News
  for (const kw of NEWS_KEYWORDS) {
    result.google_news[kw] = await fetchGoogleNewsRss(kw);
  }
  // 也爬對手品牌新聞
  for (const c of COMPETITORS) {
    result.google_news[c] = await fetchGoogleNewsRss(c + ' 甜點');
  }

  // 2) FB Ads
  result.fb_ads = await fetchFbAdsLibrary([...NEWS_KEYWORDS, ...COMPETITORS]);

  // 3) PTT 看板搜尋
  result.ptt = {};
  for (const kw of NEWS_KEYWORDS) {
    result.ptt[kw] = await fetchPtt(kw);
  }

  // 4) Dcard 公開 API
  result.dcard = {};
  for (const kw of NEWS_KEYWORDS) {
    result.dcard[kw] = await fetchDcard(kw);
  }

  // 5) Google Trends 每日熱門 (台灣)
  result.google_trends = await fetchGoogleTrends();

  result.finished_at = new Date().toISOString();

  // 統計
  let newsCount = 0;
  for (const items of Object.values(result.google_news)) {
    if (Array.isArray(items)) newsCount += items.length;
  }
  let pttCount = 0, dcardCount = 0;
  for (const items of Object.values(result.ptt || {})) if (Array.isArray(items)) pttCount += items.length;
  for (const items of Object.values(result.dcard || {})) if (Array.isArray(items)) dcardCount += items.length;
  result.summary_stats = {
    total_news: newsCount,
    total_fb_ads: Array.isArray(result.fb_ads) ? result.fb_ads.length : 0,
    total_ptt: pttCount,
    total_dcard: dcardCount,
    total_gtrends: Array.isArray(result.google_trends) ? result.google_trends.length : 0,
    keywords_scanned: NEWS_KEYWORDS.length + COMPETITORS.length,
  };

  // 儲存
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(intelFile(), JSON.stringify(result, null, 2));
  } catch (e) {
    console.error('[market-intel:save]', e.message);
  }

  console.log(`[market-intel] done. news=${newsCount} fb_ads=${result.summary_stats.total_fb_ads}`);
  return result;
}

// ============================================================
// 載入 / 摘要
// ============================================================
function loadLatestIntel() {
  try {
    return JSON.parse(fs.readFileSync(intelFile(), 'utf8'));
  } catch {
    for (let i = 1; i <= 7; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      try {
        return JSON.parse(fs.readFileSync(intelFile(d), 'utf8'));
      } catch {}
    }
    return null;
  }
}

// 生成可注入 AI prompt 的 context 字串
function getMarketIntelContext({ compact = true } = {}) {
  const intel = loadLatestIntel();
  if (!intel) return '(無市場情報資料)';

  const lines = [];
  lines.push(`【最新市場情報 · ${intel.date}】`);

  // 馬卡龍 / 費南雪 新聞 (top 2 per keyword)
  for (const kw of NEWS_KEYWORDS) {
    const items = intel.google_news[kw];
    if (!Array.isArray(items) || items.length === 0) continue;
    lines.push(`\n📰 ${kw}:`);
    items.slice(0, compact ? 2 : 5).forEach((it) => {
      lines.push(`  • ${it.title} (${it.source})`);
    });
  }

  // 對手新聞 (top 1 per competitor)
  const compNews = [];
  for (const c of COMPETITORS) {
    const items = intel.google_news[c];
    if (Array.isArray(items) && items.length > 0) {
      compNews.push(`  • [${c}] ${items[0].title}`);
    }
  }
  if (compNews.length > 0) {
    lines.push('\n🏢 對手品牌動態:');
    lines.push(...compNews);
  }

  // PTT (top 2 per keyword)
  let pttLines = [];
  for (const kw of NEWS_KEYWORDS) {
    const items = (intel.ptt || {})[kw];
    if (Array.isArray(items) && items.length > 0) {
      items.slice(0, compact ? 2 : 4).forEach(it => pttLines.push(`  • [PTT/${kw}] ${it.title}`));
    }
  }
  if (pttLines.length) {
    lines.push('\n💬 PTT 討論:');
    lines.push(...pttLines.slice(0, compact ? 8 : 20));
  }

  // Dcard (top 2 per keyword)
  let dcardLines = [];
  for (const kw of NEWS_KEYWORDS) {
    const items = (intel.dcard || {})[kw];
    if (Array.isArray(items) && items.length > 0) {
      items.slice(0, compact ? 2 : 4).forEach(it => dcardLines.push(`  • [${it.forum}] ${it.title} (❤${it.like || 0})`));
    }
  }
  if (dcardLines.length) {
    lines.push('\n🎓 Dcard 討論:');
    lines.push(...dcardLines.slice(0, compact ? 8 : 20));
  }

  // Google Trends 台灣熱門
  if (Array.isArray(intel.google_trends) && intel.google_trends.length > 0) {
    lines.push('\n🔥 今日 Google Trends 台灣熱門:');
    intel.google_trends.slice(0, compact ? 5 : 10).forEach(t => {
      lines.push(`  • ${t.keyword}${t.traffic ? ' (' + t.traffic + ')' : ''}`);
    });
  }

  // 對手廣告 hook (top 5)
  if (Array.isArray(intel.fb_ads) && intel.fb_ads.length > 0) {
    lines.push('\n📢 對手正在跑的廣告:');
    intel.fb_ads.slice(0, compact ? 5 : 12).forEach((ad) => {
      const hook = (ad.body || ad.title || '').slice(0, 80);
      lines.push(`  • [${ad.page}] ${hook}`);
    });
  }

  return lines.join('\n');
}

// 對「溫點 vs 對手」做比對(由 AI 解讀)— 用 Claude
async function compareWithWarmplace({ anthropic, model = 'claude-opus-4-8' } = {}) {
  if (!anthropic) return { ok: false, error: 'no anthropic client' };
  const intel = loadLatestIntel();
  if (!intel) return { ok: false, error: 'no intel data' };

  const sys =
    '你是 溫點 WarmPlace(IG @warmplace.here 32K 粉絲,4 家門店) 的策略分析師。' +
    '看完今天的市場情報後,給老闆 Sam 3 件本週可立即執行的事。' +
    '禁止談廣告投放細節,聚焦在【內容、品牌、客戶經營、門店體驗】。簡短具體,繁體中文。';
  const user =
    '=== 今天的台灣市場情報 ===\n' +
    JSON.stringify(intel).slice(0, 8000) +
    '\n\n=== 我們是 ===\n溫點 WarmPlace精品馬卡龍+費南雪禮贈品牌\nIG 32K / FB 118 / 4 家門店\n\n請以「溫點 vs 對手」角度,告訴我:\n1. 對手在做什麼,我們漏掉了\n2. 哪些 hook 我們可以複製\n3. 哪些角度可以反差打\n4. 3 件本週要做的事(指名員工 CAMILLE/NOVA/ARIA/...)';

  try {
    const resp = await anthropic.messages.create({
      model,
      max_tokens: 2000,
      system: sys,
      messages: [{ role: 'user', content: user }],
    });
    const text = resp.content && resp.content[0] && resp.content[0].text;
    return { ok: true, analysis: text, intel_date: intel.date };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  runDailyScan,
  loadLatestIntel,
  getMarketIntelContext,
  compareWithWarmplace,
  todayKey,
  NEWS_KEYWORDS,
  COMPETITORS,
  fetchPtt,
  fetchDcard,
  fetchGoogleTrends,
};
