// memory-widget.js v2 — 浮動「💾 記住」按鈕 + 全頁面 universal chat beautifier
// 處理 AI 員工輸出的:\n 換行、HTML 標籤、JSON proposal、tool result、段落間距
// 讓所有對話框的內容都是「人可以讀」的格式

(function () {
  if (window.__memoryWidgetLoaded) return;
  window.__memoryWidgetLoaded = true;

  const css = `
.mem-fab{position:fixed;right:22px;bottom:22px;width:56px;height:56px;border-radius:28px;background:linear-gradient(135deg,#B08D57,#d4a87e);color:#3a1521;font-size:22px;font-weight:700;border:none;cursor:pointer;z-index:9998;box-shadow:0 6px 24px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;transition:transform .15s ease,box-shadow .15s ease}
.mem-fab:hover{transform:scale(1.08);box-shadow:0 8px 30px rgba(0,0,0,.5)}
.mem-fab .lbl{display:none}
@media(min-width:800px){.mem-fab{width:auto;height:50px;padding:0 18px;border-radius:25px;font-size:14px;gap:6px}.mem-fab .lbl{display:inline}}
.mem-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:9999;backdrop-filter:blur(4px)}
.mem-overlay.show{display:flex}
.mem-card{background:linear-gradient(135deg,#3a1521,#5e2a3a);border:1px solid rgba(176,141,87,.4);border-radius:18px;width:min(560px,92vw);padding:22px;color:#f4e8d4;font-family:'Noto Sans TC','PingFang TC',sans-serif;box-shadow:0 12px 50px rgba(0,0,0,.6);max-height:90vh;overflow-y:auto}
.mem-card h3{margin:0 0 4px;font-size:18px;color:#fff;display:flex;align-items:center;gap:8px}
.mem-card .sub{color:#c9b89e;font-size:12px;margin-bottom:16px}
.mem-card label{display:block;color:#d4a87e;font-size:12px;margin:12px 0 4px;font-weight:600}
.mem-card select,.mem-card textarea,.mem-card input{width:100%;box-sizing:border-box;background:rgba(0,0,0,.35);border:1px solid rgba(176,141,87,.3);color:#fff;border-radius:8px;padding:8px 10px;font-family:inherit;font-size:13px}
.mem-card textarea{min-height:110px;resize:vertical;line-height:1.5}
.mem-card .row{display:flex;gap:10px}.mem-card .row>*{flex:1}
.mem-card .actions{display:flex;gap:10px;margin-top:18px;justify-content:flex-end}
.mem-card .btn{background:linear-gradient(135deg,#B08D57,#d4a87e);color:#3a1521;border:none;padding:9px 18px;border-radius:20px;font-weight:700;cursor:pointer;font-size:13px}
.mem-card .btn.ghost{background:transparent;color:#c9b89e;border:1px solid rgba(176,141,87,.4)}
.mem-card .hint{color:#9c8973;font-size:11px;margin-top:6px;line-height:1.5}
.mem-card .recent{margin-top:16px;padding-top:12px;border-top:1px dashed rgba(176,141,87,.25);max-height:180px;overflow-y:auto}
.mem-card .recent h4{margin:0 0 8px;font-size:12px;color:#d4a87e;text-transform:uppercase}
.mem-card .recent .item{padding:6px 0;border-bottom:1px dashed rgba(176,141,87,.12);font-size:12px;color:#e4d6bc}
.mem-card .recent .item .t{color:#d4a87e;font-size:10px;margin-right:6px}
.mem-card .recent .item .del{float:right;cursor:pointer;color:#ff6b6b;font-size:11px}
.mem-toast{position:fixed;top:22px;right:22px;padding:12px 20px;border-radius:10px;font-weight:600;z-index:10000;display:none;font-family:'Noto Sans TC',sans-serif}
.mem-toast.success{background:linear-gradient(135deg,#3ddc84,#2b9c5e);color:#0a2a16}
.mem-toast.error{background:linear-gradient(135deg,#ff6b6b,#c5424a);color:#fff}
.mem-toast.show{display:block;animation:memToastIn .3s ease}
@keyframes memToastIn{from{transform:translateY(-20px);opacity:0}to{transform:translateY(0);opacity:1}}

/* ======== Universal chat beautifier ======== */
.mem-bf{line-height:1.75;font-size:14px;color:#f4e8d4}
.mem-bf p{margin:0 0 10px}
.mem-bf p:last-child{margin-bottom:0}
.mem-bf h4{color:#d4a87e;font-size:15px;margin:14px 0 8px;font-weight:700;border-left:3px solid #B08D57;padding-left:10px}
.mem-bf h5{color:#aac8ff;font-size:13px;margin:10px 0 6px;font-weight:700}
.mem-bf ul,.mem-bf ol{margin:6px 0 12px;padding-left:22px}
.mem-bf li{margin-bottom:4px}
.mem-bf strong{color:#fff;font-weight:700}
.mem-bf em{color:#d4a87e;font-style:italic}
.mem-bf code{background:rgba(0,0,0,.35);color:#aac8ff;padding:1px 6px;border-radius:4px;font-size:12px;font-family:'JetBrains Mono','SF Mono',monospace}
.mem-bf table.data{width:100%;border-collapse:collapse;font-size:12px;background:rgba(0,0,0,.18);border-radius:6px;overflow:hidden;margin:8px 0}
.mem-bf table.data th{background:rgba(176,141,87,.2);text-align:left;padding:8px;color:#d4a87e;font-size:10px;text-transform:uppercase}
.mem-bf table.data td{padding:8px;border-top:1px solid rgba(176,141,87,.1);color:#e4d6bc;vertical-align:top}
.mem-bf blockquote{border-left:3px solid #B08D57;padding:8px 14px;margin:10px 0;background:rgba(176,141,87,.08);color:#e4d6bc;border-radius:0 8px 8px 0}
.mem-bf .tldr{background:linear-gradient(135deg,rgba(212,168,126,.18),rgba(176,141,87,.08));border-left:4px solid #d4a87e;padding:10px 14px;border-radius:0 8px 8px 0;margin:0 0 14px;color:#f4e8d4;font-weight:600}

/* Proposal card 美化 */
.mem-proposal{background:rgba(0,0,0,.22);border:1px solid rgba(170,200,255,.32);border-radius:12px;padding:14px;margin:10px 0}
.mem-proposal .hdr{color:#aac8ff;font-size:11px;font-weight:700;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px}
.mem-proposal img{width:100%;max-width:380px;border-radius:8px;margin-bottom:10px;display:block}
.mem-proposal .caption{white-space:pre-wrap;line-height:1.7;color:#f4e8d4;font-size:14px;background:rgba(0,0,0,.15);padding:14px;border-radius:8px;margin-bottom:10px}
.mem-proposal .meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.mem-proposal .meta button{font-size:12px;padding:7px 16px;border-radius:18px;border:none;cursor:pointer;font-weight:700}
.mem-proposal .meta .pub{background:linear-gradient(135deg,#3ddc84,#2b9c5e);color:#0a2a16}
.mem-proposal .meta .skip{background:transparent;border:1px solid rgba(176,141,87,.4);color:#c9b89e}
.mem-bf details.raw{margin-top:10px;color:#9c8973;font-size:11px}
.mem-bf details.raw summary{cursor:pointer;user-select:none;color:#7a6650}
.mem-bf details.raw pre{background:rgba(0,0,0,.3);padding:10px;border-radius:6px;overflow-x:auto;font-size:10px;color:#9c8973;line-height:1.4;white-space:pre-wrap;word-break:break-all}
`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ================ FAB + Modal ================
  const fab = document.createElement('button');
  fab.className = 'mem-fab';
  fab.title = '記住一件事 — 讓所有 AI 員工都知道';
  fab.innerHTML = '💾 <span class="lbl">記住</span>';
  document.body.appendChild(fab);

  const overlay = document.createElement('div');
  overlay.className = 'mem-overlay';
  overlay.innerHTML = `
    <div class="mem-card">
      <h3>💾 記住一件事</h3>
      <div class="sub">寫進長期記憶後,所有 AI 員工(NOVA / CAMILLE / VICTOR / DEX...)都會記得這件事,影響後續決策和文案</div>
      <div class="row">
        <div><label>分類</label><select id="memTopic">
          <option>文案調性</option><option>門市</option><option>產品</option><option>管道</option><option>TA</option><option>策略</option><option>數據</option><option>競品</option><option>節慶</option><option>其他</option>
        </select></div>
        <div><label>重要度</label><select id="memPriority">
          <option value="high">高 ⭐(永遠優先)</option><option value="medium" selected>中(一般偏好)</option><option value="low">低(備註)</option>
        </select></div>
      </div>
      <label>內容(用一句話講清楚這個決策 / 偏好 / 事實)</label>
      <textarea id="memContent" placeholder="例:對外文案不要寫『限時搶購』、母親節主打 6 入 NT$880、巨蛋店預計 8 月開..."></textarea>
      <div class="hint">💡 提示:可以寫「以後都這樣...」「禁用...」「主打...」「不要做...」「目標是...」<br>快速鍵:Ctrl/Cmd + M 開啟</div>
      <div class="recent" id="memRecent"><h4>最近 5 條記憶</h4><div id="memRecentList">載入中...</div></div>
      <div class="actions">
        <button class="btn ghost" id="memCancel">取消</button>
        <button class="btn" id="memSave">💾 記住</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const toast = document.createElement('div');
  toast.className = 'mem-toast';
  document.body.appendChild(toast);
  function showToast(msg, isError) {
    toast.textContent = msg;
    toast.className = 'mem-toast show ' + (isError ? 'error' : 'success');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }

  function openModal() { overlay.classList.add('show'); setTimeout(() => document.getElementById('memContent').focus(), 50); loadRecent(); }
  function closeModal() { overlay.classList.remove('show'); document.getElementById('memContent').value = ''; }
  fab.addEventListener('click', openModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') { e.preventDefault(); openModal(); }
  });
  document.getElementById('memCancel').addEventListener('click', closeModal);
  document.getElementById('memSave').addEventListener('click', async () => {
    const content = document.getElementById('memContent').value.trim();
    if (!content) return showToast('內容不能空', true);
    try {
      const r = await fetch('/api/memory/remember', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: document.getElementById('memTopic').value, content, priority: document.getElementById('memPriority').value, source: 'widget-manual' })
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || '失敗');
      showToast('✅ 記住了 — 所有 AI 員工下次回覆都會記得');
      closeModal(); loadRecent();
    } catch (e) { showToast('❌ ' + e.message, true); }
  });
  async function loadRecent() {
    const list = document.getElementById('memRecentList');
    if (!list) return;
    try {
      const r = await fetch('/api/memory/list');
      const d = await r.json();
      const items = (d.items || []).slice(0, 5);
      if (items.length === 0) { list.innerHTML = '<div style="color:#9c8973;font-size:12px">尚無記憶,寫第一條吧</div>'; return; }
      list.innerHTML = items.map(m => `<div class="item"><span class="t">[${m.topic || '其他'}]</span>${esc(m.content)}<span class="del" data-id="${m.id}" title="刪除">×</span></div>`).join('');
      list.querySelectorAll('.del').forEach(el => el.addEventListener('click', async () => {
        if (!confirm('確定刪除這條記憶?')) return;
        await fetch('/api/memory/' + el.dataset.id, { method: 'DELETE' });
        loadRecent();
      }));
    } catch (e) { list.innerHTML = '<div style="color:#ff6b6b;font-size:12px">' + e.message + '</div>'; }
  }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ================ Universal chat beautifier ================
  // 目標:讓所有 AI 回應的 raw 文字(含 \n、HTML 標籤、JSON、proposal 樣板)變成人可讀
  function beautify() {
    // 找所有 chat 訊息容器
    const selectors = [
      '.message', '.msg-content', '.chat-bubble', '.bubble', '.chat-msg',
      '[class*="message"]:not(.mem-toast):not(.mem-overlay):not(.mem-card)',
      '[class*="bubble"]', '[class*="reply"]', '[class*="response"]'
    ];
    const seen = new Set();
    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        if (seen.has(el) || el.closest('.mem-card,.mem-overlay,.mem-toast,.mem-fab')) return;
        seen.add(el);
        if (el.dataset.memBeautified === '1') return;
        beautifyElement(el);
      });
    });
  }

  function beautifyElement(el) {
    const raw = el.innerText || '';
    // 太短的訊息(<30 字)直接跳過
    if (raw.length < 30) { el.dataset.memBeautified = '1'; return; }
    // 已經有 HTML structure 就跳過(避免重複處理)
    if (el.querySelector('h4, .mem-bf, .mem-proposal')) { el.dataset.memBeautified = '1'; return; }

    let content = raw;
    let proposal = null;

    // 1. 抓 propose_* JSON proposal
    const jsonMatch = content.match(/\{\s*"caption"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"imageUrl"\s*:\s*"([^"]+)"\s*\}/);
    if (jsonMatch) {
      const caption = unescapeJson(jsonMatch[1]);
      const imageUrl = jsonMatch[2];
      const idMatch = content.match(/Proposal ID:\s*`?(p_[A-Za-z0-9_]+)`?/);
      proposal = { caption, imageUrl, id: idMatch ? idMatch[1] : null };
      // 把整段 proposal 區塊從正文移除
      content = content.replace(/⚠️[^\n]*想執行[\s\S]*?確認執行。?/g, '').trim();
      content = content.replace(/```json[\s\S]*?```/g, '').trim();
      content = content.replace(/Proposal ID:[\s\S]*?確認執行。?/g, '').trim();
      content = content.replace(/半自動模式[\s\S]*?確認執行。?/g, '').trim();
    }

    // 2. 處理「字面上 \n」(那種 raw 字串內含 backslash-n)
    content = content.replace(/\\n/g, '\n');
    // 3. 處理多個連續空行 → 變段落
    content = content.replace(/\n{3,}/g, '\n\n');

    // 4. 內容已經是 HTML(含 <h4>/<p>/<ul>) 用 innerHTML;否則 plain text 包 <p>
    const hasHtmlTag = /<\/?(?:h[1-6]|p|ul|ol|li|strong|em|code|table|tr|td|th|blockquote|div)\b/i.test(raw);
    const wrap = document.createElement('div');
    wrap.className = 'mem-bf';

    if (hasHtmlTag) {
      // 用 innerHTML 但保留 <table class="data"> 等
      // 直接用原 innerHTML(若可能)否則 raw HTML escape
      // 注意:用 innerText 拿到的不含 HTML 標籤,要從 originalHTML 取
      const origHTML = el.innerHTML;
      // 移除 raw JSON code block
      let cleaned = origHTML.replace(/```json[\s\S]*?```/g, '');
      cleaned = cleaned.replace(/⚠️[^<]*想執行[\s\S]*?確認執行。?/g, '');
      cleaned = cleaned.replace(/Proposal ID:[\s\S]*?確認執行。?/g, '');
      wrap.innerHTML = cleaned;
    } else {
      // 純文字:把 \n\n 變段落,單 \n 變 <br>
      const paragraphs = content.split(/\n{2,}/);
      wrap.innerHTML = paragraphs
        .filter(p => p.trim())
        .map(p => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>')
        .join('');
    }

    // 5. 加 proposal card
    if (proposal) {
      const card = document.createElement('div');
      card.className = 'mem-proposal';
      card.innerHTML = `
        <div class="hdr">📣 提案 — IG 貼文</div>
        ${proposal.imageUrl ? `<img src="${esc(proposal.imageUrl)}" alt="貼文圖" loading="lazy" />` : ''}
        <div class="caption">${esc(proposal.caption)}</div>
        ${proposal.id ? `<div class="meta"><button class="pub" data-id="${proposal.id}">✅ 發布</button><button class="skip">略過</button></div>` : ''}`;
      wrap.appendChild(card);
      const pubBtn = card.querySelector('.pub');
      if (pubBtn) {
        pubBtn.addEventListener('click', async () => {
          pubBtn.disabled = true; pubBtn.textContent = '發布中…';
          try {
            const r = await fetch('/api/proposals/' + pubBtn.dataset.id + '/execute', { method: 'POST' });
            const d = await r.json();
            if (d.ok) { showToast('✅ 已發布'); pubBtn.textContent = '✅ 已發布'; }
            else throw new Error(d.error || '失敗');
          } catch (e) { showToast('❌ ' + e.message, true); pubBtn.disabled = false; pubBtn.textContent = '✅ 發布'; }
        });
      }
      card.querySelector('.skip')?.addEventListener('click', () => card.remove());
    }

    // 6. 折疊 raw 原文(debug 用)
    const orig = document.createElement('details');
    orig.className = 'raw';
    orig.innerHTML = '<summary>查看原始輸出</summary><pre>' + esc(raw) + '</pre>';
    wrap.appendChild(orig);

    // 7. 取代原 el 內容
    el.innerHTML = '';
    el.appendChild(wrap);
    el.dataset.memBeautified = '1';
  }

  function unescapeJson(s) {
    return String(s || '')
      .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
      .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

  // 每 1.5 秒掃新訊息
  setInterval(beautify, 1500);
  setTimeout(beautify, 500);
})();
