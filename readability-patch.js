// readability-patch.js
// monkey-patch Anthropic SDK so all messages.create() AND messages.stream() calls
// auto-prepend READABILITY_RULE to system prompt.
// require this file at the top of server.js (right after dotenv).

const READABILITY_RULE = [
  '─────────────────────────────────────────────',
  '【★★★ 輸出排版鐵律(絕對優先,違反就是錯誤輸出)★★★】',
  '',
  '你的所有輸出都會直接呈現給人類用戶閱讀。',
  '**所有規則為「強制」不是「建議」**。每一條都必須遵守。',
  '',
  '▎硬性段落上限',
  '1. 每一段(連續無空行的文字塊)**最多 3 行 / 約 80 中文字**',
  '2. 連續超過 80 字必須:',
  '   ❶ 加空白行另起新段,或',
  '   ❷ 加 emoji 標題切割(例:「💡 為什麼這樣」),或',
  '   ❸ 改寫成 <ul><li> 條列',
  '',
  '▎強制段落留白',
  '3. **段落與段落之間「必須」有一個完全空白行**(打兩次 enter)',
  '4. 標題與內文之間「必須」有空白行',
  '5. 列表前後「必須」有空白行',
  '',
  '▎標題與條列',
  '6. 答案分 ≥ 2 個段落 → 必須加 emoji 標題(例:🎯 / 📋 / 💡 / ⚡ / →)',
  '7. 列舉 ≥ 2 個項目 → 必須用 <ul><li>項目</li></ul>,不要用「、」串成一行',
  '8. 重點關鍵字 → 用 <strong>關鍵字</strong>(每段最多 2 個)',
  '',
  '▎中英文排版',
  '9. 中文與英文/數字之間加半形空格(例:「ROAS 3.0」「Meta 廣告」)',
  '10. 標點符號用全形(,。!?「」)',
  '',
  '▎❌ 絕對禁止 — 以下範例就是 wall-of-text 違規:',
  '',
  '❌「IP 的本質是把客人已經在替你說、但你還沒命名的東西,固定成一個每次都長一樣的符號。客人不講「好吃」當第一反應,先講「美 / 捨不得吃 / 有儀式感」——這代表溫點的記憶錨點已經是視覺與儀式,不是味覺。三家對手都佔了「物件」或「人」(草莓、薄荷綠盒、大師聯名),沒人佔「那一個動作、那一刻的情緒」。這就是切口:把「安靜拆禮盒的 3 秒」做成跨門市與線上的固定符號。」',
  '',
  '→ 這段 200+ 字擠成一塊,違反規則 1、3、6。',
  '',
  '▎✅ 正確寫法 — 同樣內容,合規排版:',
  '',
  '🎯 IP 的本質',
  '',
  '把客人「已經在替你說、但你還沒命名」的東西,固定成每次都長一樣的符號。',
  '',
  '客人第一反應不是「好吃」,是「美 / 捨不得吃 / 有儀式感」 — <strong>記憶錨點是視覺與儀式,不是味覺</strong>。',
  '',
  '📋 對手地景',
  '',
  '三家對手都佔了「物件」或「人」:',
  '',
  '<ul>',
  '<li>草莓(時令物件)</li>',
  '<li>薄荷綠盒(包裝物件)</li>',
  '<li>大師聯名(人)</li>',
  '</ul>',
  '',
  '沒人佔「那一個動作、那一刻的情緒」。',
  '',
  '💡 我們的切口',
  '',
  '把「安靜拆禮盒的 3 秒」做成跨門市與線上的固定符號。',
  '',
  '─────────────────────────────────────────────',
  '',
  '▎自我檢查(寫完後讀一次自己的輸出)',
  '',
  '如果你發現自己寫了:',
  '• 一段連續超過 4 行',
  '• 兩個段落間沒有空白行',
  '• 列舉超過 2 項卻用「、」串',
  '• 整篇沒有任何標題',
  '',
  '→ **重寫,直到符合鐵律才能輸出**。',
  '─────────────────────────────────────────────',
].join('\n');

function injectRule(params) {
  if (!params || typeof params !== 'object' || params._noReadability) return params;
  try {
    if (typeof params.system === 'string') {
      if (params.system.indexOf('輸出排版鐵律') >= 0) return params;
      return Object.assign({}, params, { system: READABILITY_RULE + '\n\n' + params.system });
    }
    if (Array.isArray(params.system)) {
      const has = params.system.some(function(b){ return b && typeof b.text === 'string' && b.text.indexOf('輸出排版鐵律') >= 0; });
      if (has) return params;
      return Object.assign({}, params, { system: [{ type: 'text', text: READABILITY_RULE }].concat(params.system) });
    }
    if (!params.system) {
      return Object.assign({}, params, { system: READABILITY_RULE });
    }
  } catch (e) {
    console.error('[readability-patch] inject err:', e.message);
  }
  return params;
}

function patchSDK() {
  var SDK;
  try { SDK = require('@anthropic-ai/sdk'); }
  catch (e) { console.warn('[readability-patch] SDK not found'); return false; }
  var Cls = SDK.default || SDK.Anthropic || SDK;
  if (!Cls || typeof Cls !== 'function') { console.warn('[readability-patch] no class'); return false; }
  if (Cls.__readabilityPatched) { console.log('[readability-patch] already patched'); return true; }

  var MessagesProto;
  try {
    var sample = new Cls({ apiKey: 'sk-test-not-real' });
    if (!sample.messages || typeof sample.messages.create !== 'function') return false;
    MessagesProto = Object.getPrototypeOf(sample.messages);
  } catch (e) { console.warn('[readability-patch] sample err:', e.message); return false; }

  if (!MessagesProto || typeof MessagesProto.create !== 'function') return false;

  var origCreate = MessagesProto.create;
  MessagesProto.create = function patchedCreate(params) {
    var args = Array.prototype.slice.call(arguments);
    args[0] = injectRule(params);
    return origCreate.apply(this, args);
  };

  if (typeof MessagesProto.stream === 'function') {
    var origStream = MessagesProto.stream;
    MessagesProto.stream = function patchedStream(params) {
      var args = Array.prototype.slice.call(arguments);
      args[0] = injectRule(params);
      return origStream.apply(this, args);
    };
    console.log('[readability-patch] ✓ .stream() patched');
  }

  Cls.__readabilityPatched = true;
  console.log('[readability-patch] ✓ SDK patched (create + stream auto-inject RULE)');
  return true;
}

var ok = patchSDK();
module.exports = { READABILITY_RULE: READABILITY_RULE, patched: ok };
