// ============================================================
// telegram-chat.js — Telegram bot 對話模組
// ------------------------------------------------------------
// 接 webhook → 判斷該員工 → 跑 prompt → 回 Telegram
// 安全:只認 process.env.TELEGRAM_CHAT_ID,其他人發訊不答
// 指令:/v VICTOR · /c CAMILLE · /n NOVA · /d DEX · /a ARIA · /m MILO · /l LEON
//      /help 員工清單 · 純文字訊息 VICTOR 自動判斷該誰答
// ============================================================

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FAST_MODEL = 'claude-haiku-4-5-20251001';
const MAIN_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

let _anthropic = null;
try {
  if (process.env.ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
} catch (e) { console.error('[telegram-chat init]', e.message); }

const CMD_MAP = {
  '/v': 'victor', '/victor': 'victor',
  '/c': 'camille', '/camille': 'camille',
  '/n': 'nova', '/nova': 'nova',
  '/d': 'dex', '/dex': 'dex',
  '/a': 'aria', '/aria': 'aria',
  '/m': 'milo', '/milo': 'milo',
  '/l': 'leon', '/leon': 'leon',
};

// 把 HTML 段落 + <ol> 轉成 Telegram 純文字(保留結構)
function htmlToTelegramText(html) {
  if (!html) return '';
  return html
    .replace(/<div class="tldr"[^>]*>([\s\S]*?)<\/div>/g, '\n⚡ $1\n')
    .replace(/<div class="next-3"[^>]*>([\s\S]*?)<\/div>/g, '\n──────\n$1\n')
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/g, '\n*$1*\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/g, '• $1\n')
    .replace(/<\/?(ol|ul)[^>]*>/g, '')
    .replace(/<strong>([\s\S]*?)<\/strong>/g, '*$1*')
    .replace(/<em>([\s\S]*?)<\/em>/g, '_$1_')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/p>\s*<p>/g, '\n\n')
    .replace(/<\/?(p|div|table|tr|td|th|blockquote|code|span)[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function tgSend(chatId, text, opts = {}) {
  if (!TG_TOKEN) return;
  const body = {
    chat_id: chatId,
    text: text.slice(0, 3900),
    disable_web_page_preview: true,
    ...opts,
  };
  try {
    await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) { console.error('[telegram send]', e.message); }
}

async function tgTyping(chatId) {
  if (!TG_TOKEN) return;
  try {
    await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendChatAction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    });
  } catch {}
}

// 用 Haiku 判斷該交給哪個員工
async function decideEmployee(EMPLOYEES, userText) {
  if (!_anthropic) return 'victor';
  const list = Object.values(EMPLOYEES)
    .filter(e => e && e.id)
    .map(e => `- ${e.id} (${e.name} · ${e.role}): ${e.bio || ''}`)
    .join('\n');
  try {
    const r = await _anthropic.messages.create({
      model: FAST_MODEL,
      max_tokens: 80,
      system: `你是路由員。讀使用者一句話,從下面員工中選最適合答的「一個」員工 id(全小寫):
${list}
只輸出 employeeId(例如:nova),不要解釋。預設 victor。`,
      messages: [{ role: 'user', content: userText.slice(0, 400) }],
    });
    const id = r.content.map(b => b.text || '').join('').trim().toLowerCase().replace(/[^a-z]/g, '');
    return EMPLOYEES[id] ? id : 'victor';
  } catch (e) {
    console.error('[telegram route]', e.message);
    return 'victor';
  }
}

async function runEmployee(emp, augmentedSystem, userText) {
  if (!_anthropic) return null;
  try {
    const r = await _anthropic.messages.create({
      model: MAIN_MODEL,
      max_tokens: 2000,
      system: augmentedSystem,
      messages: [{ role: 'user', content: userText }],
    });
    return r.content.map(b => b.text || '').join('');
  } catch (e) {
    console.error('[telegram run emp]', emp.id, e.message);
    return '⚠️ 我這邊出了一點問題:' + (e.message || '不明錯誤');
  }
}

// 主入口 — server.js 把 webhook payload 跟 EMPLOYEES + maybeAugmentSystemPrompt 傳進來
async function handleWebhook({ payload, EMPLOYEES, maybeAugmentSystemPrompt }) {
  const msg = payload && payload.message;
  if (!msg || !msg.text) return { ok: true, skip: 'no text' };

  const chatId = String(msg.chat.id);
  // 安全 — 只認設定的 TELEGRAM_CHAT_ID
  if (TG_CHAT_ID && chatId !== String(TG_CHAT_ID)) {
    return { ok: true, skip: 'unauthorized chat: ' + chatId };
  }

  let text = (msg.text || '').trim();

  // /start, /help
  if (/^\/(start|help)\b/i.test(text)) {
    const help =
      '🥐 *溫點 WarmPlace AI 團隊*\n\n' +
      '直接打字 → VICTOR 自動判斷該誰答\n\n' +
      '*指定員工*(指令當開頭):\n' +
      '/v VICTOR 行銷總監\n' +
      '/l LEON 廣告投手\n' +
      '/c CAMILLE 內容主筆\n' +
      '/a ARIA 視覺指導\n' +
      '/d DEX 數據分析\n' +
      '/n NOVA 品牌經理\n' +
      '/m MILO KOL 合作\n\n' +
      '範例:\n' +
      '`/c 寫 3 則母親節 IG 貼文`\n' +
      '`今天 ROAS 怎樣?`(VICTOR 會派給 DEX)';
    await tgSend(chatId, help, { parse_mode: 'Markdown' });
    return { ok: true, handled: 'help' };
  }

  // 解析指令 /v /c /n ...
  let targetEmpId = null;
  const cmdMatch = text.match(/^(\/[a-z]+)(?:@\w+)?\s+([\s\S]+)$/i);
  if (cmdMatch) {
    const id = CMD_MAP[cmdMatch[1].toLowerCase()];
    if (id) {
      targetEmpId = id;
      text = cmdMatch[2].trim();
    } else {
      // 未知指令 — 提示
      await tgSend(chatId, '🤔 不認得這個指令,送 /help 看清單');
      return { ok: true, handled: 'unknown_cmd' };
    }
  }

  await tgTyping(chatId);

  // VICTOR 路由
  if (!targetEmpId) {
    targetEmpId = await decideEmployee(EMPLOYEES, text);
  }

  const emp = EMPLOYEES[targetEmpId];
  if (!emp) {
    await tgSend(chatId, '⚠️ 找不到員工:' + targetEmpId);
    return { ok: true, handled: 'no_emp' };
  }

  // 通知正在交給誰
  await tgSend(chatId, `${emp.emoji || '💫'} *${emp.name}* (${emp.role}) 接手…`, { parse_mode: 'Markdown' });

  // 注入即時數據 + 品牌記憶 + 市場情報
  let system = emp.systemPrompt;
  try {
    if (typeof maybeAugmentSystemPrompt === 'function') {
      system = await maybeAugmentSystemPrompt(emp);
    }
  } catch (e) { /* ignore */ }

  // 附加 Telegram 場景提示
  const tgSuffix = `\n\n【★ Telegram 場景特別規則 ★】
你現在透過 Telegram 回答 Jeffrey,輸出會被轉成 Telegram 純文字。
- 控制在 1500 字內,Telegram 太長會被截
- 可以用 <h4>、<strong>、<ul><li>、<div class="next-3"> 等標籤,系統會自動轉純文字
- 「下一步 3 點」一定要寫,Jeffrey 看完手機就要能行動`;

  const answer = await runEmployee(emp, system + tgSuffix, text);
  const finalText = htmlToTelegramText(answer || '⚠️ 沒回應');

  await tgSend(chatId, finalText);

  // 記錄
  try {
    const H = require('./history');
    H.record({
      fn: emp.name.toUpperCase(),
      title: emp.name + ' · Telegram · ' + text.slice(0, 40),
      html: '<h4>Telegram 問:</h4><p>' + text.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</p><h4>' + emp.name + ' 回:</h4><div>' + (answer || '') + '</div>',
      text: text.slice(0, 500) + ' → ' + (answer || '').replace(/<[^>]+>/g, ' ').slice(0, 1500),
      meta: { employeeId: emp.id, source: 'telegram', chatId },
    });
  } catch (e) { console.error('[telegram history]', e.message); }

  return { ok: true, handled: emp.id };
}

module.exports = { handleWebhook, tgSend };
