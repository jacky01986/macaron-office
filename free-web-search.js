// free-web-search.js
// 免費網路搜尋模組 — 三層 fallback,不需任何 API key
// 來源順序:DuckDuckGo HTML → Google News RSS → SearXNG 公開實例
// 適用於所有 AI 員工的即時資料查詢

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// ============ 工具:HTML decode ============
function decodeHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/<[^>]+>/g, "")
    .trim();
}

// ============ 來源 1:DuckDuckGo HTML ============
async function searchDDG(query, limit = 10) {
  const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8"
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error("DDG HTTP " + res.status);
  const html = await res.text();
  const results = [];
  // 解析 result__title / result__snippet / result__url
  const blockRe = /<div class="result__body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  let m;
  while ((m = blockRe.exec(html)) && results.length < limit) {
    const block = m[1];
    const titleM = block.match(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    const urlM = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"/);
    const snipM = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    if (titleM) {
      let link = urlM ? urlM[1] : "";
      // DDG 跳轉連結 //duckduckgo.com/l/?uddg=...
      const uddg = link.match(/uddg=([^&]+)/);
      if (uddg) link = decodeURIComponent(uddg[1]);
      results.push({
        title: decodeHtml(titleM[1]),
        url: link,
        snippet: snipM ? decodeHtml(snipM[1]) : ""
      });
    }
  }
  return results;
}

// ============ 來源 2:Google News RSS ============
async function searchGoogleNews(query, limit = 10) {
  const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=zh-TW&gl=TW&ceid=TW:zh-Hant";
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error("GoogleNews HTTP " + res.status);
  const xml = await res.text();
  const results = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) && results.length < limit) {
    const item = m[1];
    const t = item.match(/<title>([\s\S]*?)<\/title>/);
    const l = item.match(/<link>([\s\S]*?)<\/link>/);
    const d = item.match(/<description>([\s\S]*?)<\/description>/);
    const pub = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    if (t) {
      results.push({
        title: decodeHtml(t[1]),
        url: l ? l[1].trim() : "",
        snippet: d ? decodeHtml(d[1]).slice(0, 200) : "",
        date: pub ? pub[1].trim() : ""
      });
    }
  }
  return results;
}

// ============ 來源 3:SearXNG 公開實例 ============
const SEARXNG_INSTANCES = [
  "https://searx.be",
  "https://search.brave4u.com",
  "https://priv.au"
];
async function searchSearxng(query, limit = 10) {
  let lastErr;
  for (const base of SEARXNG_INSTANCES) {
    try {
      const url = base + "/search?q=" + encodeURIComponent(query) + "&format=json&language=zh-TW";
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept": "application/json" },
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) { lastErr = "HTTP " + res.status; continue; }
      const data = await res.json();
      if (!data.results) { lastErr = "no results"; continue; }
      return data.results.slice(0, limit).map(r => ({
        title: r.title || "",
        url: r.url || "",
        snippet: r.content || ""
      }));
    } catch (e) {
      lastErr = e.message;
    }
  }
  throw new Error("All SearXNG instances failed: " + lastErr);
}

// ============ 主入口:三層 fallback ============
async function webSearch(query, opts = {}) {
  const limit = opts.limit || 8;
  const sources = opts.sources || ["ddg", "google-news", "searxng"];
  const errors = [];
  for (const src of sources) {
    try {
      let results;
      if (src === "ddg") results = await searchDDG(query, limit);
      else if (src === "google-news") results = await searchGoogleNews(query, limit);
      else if (src === "searxng") results = await searchSearxng(query, limit);
      else continue;
      if (results && results.length > 0) {
        return { source: src, query, count: results.length, results, errors };
      }
      errors.push({ source: src, error: "0 results" });
    } catch (e) {
      errors.push({ source: src, error: e.message });
    }
  }
  return { source: null, query, count: 0, results: [], errors };
}

// ============ 給 Claude 用的格式化文字 ============
function formatForClaude(searchResult) {
  if (!searchResult || searchResult.count === 0) {
    return "(無搜尋結果)";
  }
  const lines = [`[即時網路搜尋 來源:${searchResult.source} | 查詢:${searchResult.query} | ${searchResult.count} 筆]`];
  searchResult.results.forEach((r, i) => {
    lines.push(`\n${i + 1}. ${r.title}`);
    if (r.url) lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    if (r.date) lines.push(`   📅 ${r.date}`);
  });
  return lines.join("\n");
}

// ============ Express 路由註冊 ============
function register(app) {
  // 通用搜尋端點
  app.get("/api/free-search", async (req, res) => {
    const q = req.query.q;
    const limit = parseInt(req.query.limit || "8", 10);
    const sources = req.query.sources ? req.query.sources.split(",") : undefined;
    if (!q) return res.status(400).json({ error: "missing q" });
    try {
      const r = await webSearch(q, { limit, sources });
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 格式化版(直接給人看 / 給 LLM 塞 prompt)
  app.get("/api/free-search/text", async (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).send("missing q");
    try {
      const r = await webSearch(q, { limit: parseInt(req.query.limit || "8", 10) });
      res.type("text/plain").send(formatForClaude(r));
    } catch (e) {
      res.status(500).send("error: " + e.message);
    }
  });

  // 狀態檢測:依序試每個來源
  app.get("/api/free-search/status", async (req, res) => {
    const out = {};
    for (const src of ["ddg", "google-news", "searxng"]) {
      try {
        const r = await webSearch("test", { sources: [src], limit: 2 });
        out[src] = { ok: r.count > 0, count: r.count };
      } catch (e) {
        out[src] = { ok: false, error: e.message };
      }
    }
    res.json(out);
  });

  console.log("[free-web-search] registered /api/free-search /api/free-search/text /api/free-search/status");
}

// ============ Claude tool_use schema ============
const CLAUDE_TOOL_DEF = {
  name: "web_search",
  description: "搜尋即時網路資料。當你不確定最新事實、需要查證、需要近期新聞或趨勢、或被問到知識截止後的事情時使用。不要用於通用知識題。",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜尋關鍵字,可用中文或英文" },
      limit: { type: "number", description: "最多回傳幾筆(預設 6)", default: 6 }
    },
    required: ["query"]
  }
};

// 處理 Claude 回傳的 tool_use,執行搜尋後產生 tool_result
async function handleToolUse(toolUseBlock) {
  if (toolUseBlock.name !== "web_search") return null;
  const { query, limit } = toolUseBlock.input || {};
  if (!query) {
    return { type: "tool_result", tool_use_id: toolUseBlock.id, content: "error: missing query", is_error: true };
  }
  try {
    const r = await webSearch(query, { limit: limit || 6 });
    return { type: "tool_result", tool_use_id: toolUseBlock.id, content: formatForClaude(r) };
  } catch (e) {
    return { type: "tool_result", tool_use_id: toolUseBlock.id, content: "search error: " + e.message, is_error: true };
  }
}

module.exports = {
  webSearch,
  searchDDG,
  searchGoogleNews,
  searchSearxng,
  formatForClaude,
  register,
  CLAUDE_TOOL_DEF,
  handleToolUse
};
