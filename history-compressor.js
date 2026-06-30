// history-compressor.js — Phase 4 替代方案
// 主對話 messages.length > 10 時,把前面 (length-6) 條對話用 Haiku summary 成 1 條 system note
// 省 60-80% history tokens,不接外部 Headroom package

let _anthropic = null;
try {
  const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
  if (process.env.ANTHROPIC_API_KEY) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
} catch (e) { console.error('[history-compressor] sdk init', e.message); }

const FAST_MODEL = 'claude-haiku-4-5-20251001';
const THRESHOLD = 10;      // > 10 條才壓
const KEEP_RECENT = 6;     // 保留最近 6 條
const MAX_SUMMARY = 600;   // summary 上限 600 字

// 簡易記憶體快取:hash(舊 messages) → summary text,避免重複 LLM call
const _cache = new Map();
function hashMessages(arr) {
  let h = 0;
  const s = JSON.stringify(arr);
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h);
}

async function compressHistory(messages) {
  if (!Array.isArray(messages) || messages.length <= THRESHOLD) return messages;
  if (!_anthropic) return messages;

  const cutAt = messages.length - KEEP_RECENT;
  const oldPart = messages.slice(0, cutAt);
  const recentPart = messages.slice(cutAt);

  const cacheKey = hashMessages(oldPart);
  let summary = _cache.get(cacheKey);
  if (!summary) {
    try {
      const dump = oldPart.map((m, i) => {
        const role = m.role || 'user';
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `[${role}] ${content.slice(0, 800)}`;
      }).join('\n\n');
      const r = await _anthropic.messages.create({
        model: FAST_MODEL,
        max_tokens: 800,
        system: `你是對話歷史壓縮員。從下面 ${oldPart.length} 條對話抽出「最該保留的具體事實」:決策、數字、人名、產品、客戶要求、已做過什麼。**只保留會影響後續回答的內容**,不要結語、不要客套。
規則:
- 總字數 ≤ ${MAX_SUMMARY} 字
- 用條列(每條 1 句)
- 開頭加「[歷史摘要 · ${oldPart.length} 條]」
- 不要說「之前提到」這種廢話`,
        messages: [{ role: 'user', content: dump.slice(0, 20000) }],
        _noReadability: true,  // 不要在這裡注入排版規則(摘要不給用戶看)
      });
      summary = r.content.map(b => b.text || '').join('').trim();
      _cache.set(cacheKey, summary);
      // cap cache size
      if (_cache.size > 50) { const firstKey = _cache.keys().next().value; _cache.delete(firstKey); }
      console.log(`[history-compressor] compressed ${oldPart.length} msgs → ${summary.length} chars`);
    } catch (e) {
      console.error('[history-compressor] failed:', e.message);
      return messages;  // fallback: 不壓
    }
  }
  // 改造 messages:summary 變成第一條 user message,後接 recent
  return [
    { role: 'user', content: summary },
    { role: 'assistant', content: '(收到歷史摘要,繼續對話)' },
    ...recentPart,
  ];
}

module.exports = { compressHistory };
