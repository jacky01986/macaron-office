// brand-memory.js — 長期品牌記憶系統 v2
// 用戶決策 / 偏好 / 品牌事實 全部存在這,自動注入每個 AI 員工 system prompt
// 兩個來源:1) 用戶說「記住」/「以後都這樣」自動寫入 2) 手動 endpoint 寫入
// v2: 加 Express response monkey patch — 所有 HTML response 自動注入 memory-widget.js script

// ============ Express response monkey patch ============
// 在所有 HTML 回應的 </body> 前 inject <script src="/memory-widget.js">
// 讓「💾 記住」浮動按鈕出現在每個對話頁面
try {
  const express = require('express');
  if (express && express.response && !express.response.__memoryWidgetPatched) {
    const _send = express.response.send;
    express.response.send = function (body) {
      try {
        if (typeof body === 'string'
          && body.indexOf('</body>') !== -1
          && body.indexOf('memory-widget.js') === -1
          && (this.get('Content-Type') || '').indexOf('text/html') !== -1) {
          body = body.replace('</body>', '<script src="/memory-widget.js" defer></script></body>');
        }
      } catch (e) {}
      return _send.call(this, body);
    };
    express.response.__memoryWidgetPatched = true;
    console.log('[brand-memory] Express response patched — memory-widget.js auto-injected to all HTML');
  }
} catch (e) {
  console.warn('[brand-memory] express patch failed:', e.message);
}

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/var/data') ? '/var/data' : '/tmp/data');
const MEMORY_FILE = path.join(DATA_DIR, 'brand-memory.jsonl');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============ 核心 CRUD ============
function loadAll() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return [];
    return fs.readFileSync(MEMORY_FILE, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function add(entry) {
  const rec = {
    id: 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    ts: new Date().toISOString(),
    topic: String(entry.topic || '').slice(0, 50),
    content: String(entry.content || entry.text || '').slice(0, 800),
    source: String(entry.source || 'manual').slice(0, 30),
    priority: ['high', 'medium', 'low'].includes(entry.priority) ? entry.priority : 'medium',
    active: entry.active !== false
  };
  if (!rec.content) return null;
  fs.appendFileSync(MEMORY_FILE, JSON.stringify(rec) + '\n');
  return rec;
}

function remove(id) {
  const all = loadAll();
  const filtered = all.filter(m => m.id !== id);
  if (filtered.length === all.length) return false;
  fs.writeFileSync(MEMORY_FILE, filtered.map(m => JSON.stringify(m)).join('\n') + (filtered.length ? '\n' : ''));
  return true;
}

function deactivate(id) {
  const all = loadAll();
  const idx = all.findIndex(m => m.id === id);
  if (idx < 0) return false;
  all[idx].active = false;
  fs.writeFileSync(MEMORY_FILE, all.map(m => JSON.stringify(m)).join('\n') + '\n');
  return true;
}

// ============ 注入用 — 把記憶整理成 prompt 段落 ============
function getPromptSection({ limit = 50, priorityFilter = null } = {}) {
  const all = loadAll().filter(m => m.active);
  if (all.length === 0) return '';
  // 依優先序 + 時間排序
  const priOrder = { high: 0, medium: 1, low: 2 };
  const sorted = all.sort((a, b) => {
    const p = priOrder[a.priority] - priOrder[b.priority];
    if (p !== 0) return p;
    return b.ts.localeCompare(a.ts);
  });
  const items = priorityFilter ? sorted.filter(m => m.priority === priorityFilter) : sorted;
  const top = items.slice(0, limit);

  // 依 topic 分組
  const byTopic = {};
  top.forEach(m => {
    const t = m.topic || '其他';
    if (!byTopic[t]) byTopic[t] = [];
    byTopic[t].push(m);
  });

  const lines = ['', '【★ 你必須知道的品牌長期記憶(老闆 Jeffrey 過去說過 / 決定過的事,影響你所有決策)★】'];
  Object.entries(byTopic).forEach(([topic, mems]) => {
    lines.push(`\n▎${topic}`);
    mems.forEach(m => {
      const star = m.priority === 'high' ? '⭐ ' : '';
      lines.push(`  • ${star}${m.content}`);
    });
  });
  lines.push('\n以上是老闆 Jeffrey 過去明確表達過的偏好和決定。你的回答和文案必須跟這些記憶一致,絕對不要違反這些原則。');
  return lines.join('\n');
}

// ============ 自動萃取 — 從對話中找出值得記住的內容 ============
const EXTRACT_PROMPT = `你是品牌記憶萃取器。讀以下「用戶對 AI 的訊息」+「AI 的回覆」,判斷有沒有值得長期記住的「品牌決策 / 偏好 / 事實」。

值得記住的類型:
- 用戶明確說「以後都這樣」「記住」「不要再」「絕對不能」
- 用戶糾正 AI 的方向(文案太硬、太制式、太業務感)
- 用戶決定的品牌方針(調性、用詞、TA、策略)
- 客觀品牌事實(店數、新品、目標、預算、合作對象)
- 用戶拒絕的事(不要做某個檔期、不要找某類 KOL)

不要記住:
- 一次性問題(本週數據如何?)
- 已過時的活動細節
- AI 的回答本身(只記用戶的決策)
- 閒聊

只回 JSON 陣列,不要 markdown。每筆:
[{"topic":"分類(文案調性/門市/產品/管道/TA/策略/其他)","content":"用一句話描述事實或決策(不超過 80 字)","priority":"high|medium|low"}]

如果這段對話沒值得記住的,回 []。`;

async function extractFromConversation(userMessage, aiResponse = '') {
  try {
    const result = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 800,
      system: EXTRACT_PROMPT,
      messages: [{
        role: 'user',
        content: `用戶訊息:\n${userMessage}\n\nAI 回覆:\n${(aiResponse || '').slice(0, 1500)}\n\n萃取記憶 JSON 陣列:`
      }]
    });
    const text = (result.content || []).map(c => c.text || '').join('');
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    // 寫入
    const added = [];
    arr.forEach(item => {
      if (item.content) {
        const rec = add({ topic: item.topic, content: item.content, priority: item.priority, source: 'auto-extracted' });
        if (rec) added.push(rec);
      }
    });
    return added;
  } catch (e) {
    return [];
  }
}

// ============ Express endpoints ============
function register(app) {
  // 列表
  app.get('/api/memory/list', (req, res) => {
    const all = loadAll();
    res.json({ ok: true, count: all.length, items: all.sort((a, b) => b.ts.localeCompare(a.ts)) });
  });
  // 新增(手動)
  app.post('/api/memory/remember', (req, res) => {
    try {
      const b = req.body || {};
      const rec = add({
        topic: b.topic || '其他',
        content: b.content || b.text,
        priority: b.priority || 'medium',
        source: b.source || 'manual'
      });
      if (!rec) return res.status(400).json({ ok: false, error: '缺 content' });
      res.json({ ok: true, memory: rec });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // 從對話自動萃取
  app.post('/api/memory/extract', async (req, res) => {
    try {
      const { userMessage, aiResponse } = req.body || {};
      if (!userMessage) return res.status(400).json({ ok: false, error: '缺 userMessage' });
      const added = await extractFromConversation(userMessage, aiResponse);
      res.json({ ok: true, extracted_count: added.length, items: added });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // 刪除
  app.delete('/api/memory/:id', (req, res) => {
    const ok = remove(req.params.id);
    res.json({ ok });
  });
  // 停用(保留歷史但不再注入 prompt)
  app.post('/api/memory/:id/deactivate', (req, res) => {
    const ok = deactivate(req.params.id);
    res.json({ ok });
  });
  // 給 AI 看的 prompt section(debug)
  app.get('/api/memory/prompt', (req, res) => {
    res.json({ ok: true, prompt_section: getPromptSection({ limit: Number(req.query.limit) || 50 }) });
  });
  // 初始化:寫入幾條已知重要記憶
  app.post('/api/memory/seed', (req, res) => {
    const seeds = [
      { topic: '文案調性', content: '對外文案要「溫暖但得體」,像認真的烘焙師,有溫度、會自我揭露、會說真話,但不會勾肩搭背、不會耍嘴皮。對內分析則可全開,直白真誠', priority: 'high', source: 'seed' },
      { topic: '文案調性', content: '禁用「敬愛的顧客」「貴賓」「殿堂級」「臻」「絕對」「精心打造」「呈現」「必買」「限時搶購」「錯過後悔」「秒殺」「CP 值」「親民」「小資」', priority: 'high', source: 'seed' },
      { topic: '文案調性', content: '對內分析報告要去掉「教練式廢話」,直接講重點,壞數據就說壞,敢說真話', priority: 'high', source: 'seed' },
      { topic: '門市', content: '4 家店:台南西門、台南樹林、台北南西新光三越、台中中港新光。巨蛋未開', priority: 'high', source: 'seed' },
      { topic: '數據', content: '老闆很在意數字精準,要求對到第 1 元才算精準。寫文案/分析時引用的數字必須準確,不能編造', priority: 'high', source: 'seed' },
      { topic: '產品', content: '主打杜拜巧克力胖卡龍、費南雪。商品線:禮盒 NT$480–2,280,核心主力是 6 入 NT$880 與 12 入 NT$1,580', priority: 'medium', source: 'seed' },
      { topic: '管道', content: 'LINE 官方帳號要斷,改走 SaleSmartly + Meta(FB/IG)。客服 / CRM 走 SaleSmartly 不走 LINE 官方', priority: 'medium', source: 'seed' },
      { topic: '策略', content: '線下門店是最大資產,線上廣告策略要服務「導客到店」,不是純電商轉換', priority: 'medium', source: 'seed' }
    ];
    const added = seeds.map(s => add(s)).filter(Boolean);
    res.json({ ok: true, seeded_count: added.length, items: added });
  });

  console.log('[brand-memory] registered: /api/memory/{list, remember, extract, prompt, seed} + /:id [DELETE, deactivate]');
}

module.exports = { register, getPromptSection, add, remove, deactivate, loadAll, extractFromConversation };
