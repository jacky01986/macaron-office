// memory-widget.js — 全頁面浮動「💾 記住」按鈕
// 任何頁面 <script src="/memory-widget.js"></script> 即可生效
// 自動在右下角加一個圓鈕,點開出 modal 寫記憶,POST /api/memory/remember
//
// 進階:在每個 AI chat 頁面,自動在「最後一則訊息」尾巴加「💾 記住這段對話」按鈕
//       點下去自動呼叫 /api/memory/extract 從上下文萃取

(function () {
  if (window.__memoryWidgetLoaded) return;
  window.__memoryWidgetLoaded = true;

  const css = `
.mem-fab {
  position: fixed; right: 22px; bottom: 22px;
  width: 56px; height: 56px; border-radius: 28px;
  background: linear-gradient(135deg, #B08D57, #d4a87e);
  color: #3a1521; font-size: 22px; font-weight: 700;
  border: none; cursor: pointer; z-index: 9998;
  box-shadow: 0 6px 24px rgba(0,0,0,.4);
  display: flex; align-items: center; justify-content: center;
  transition: transform .15s ease, box-shadow .15s ease;
}
.mem-fab:hover { transform: scale(1.08); box-shadow: 0 8px 30px rgba(0,0,0,.5); }
.mem-fab .lbl { display: none; }
@media (min-width: 800px) {
  .mem-fab { width: auto; height: 50px; padding: 0 18px; border-radius: 25px; font-size: 14px; gap: 6px; }
  .mem-fab .lbl { display: inline; }
}

.mem-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.6);
  display: none; align-items: center; justify-content: center;
  z-index: 9999; backdrop-filter: blur(4px);
}
.mem-overlay.show { display: flex; }
.mem-card {
  background: linear-gradient(135deg, #3a1521, #5e2a3a);
  border: 1px solid rgba(176,141,87,.4); border-radius: 18px;
  width: min(560px, 92vw); padding: 22px;
  color: #f4e8d4; font-family: 'Noto Sans TC','PingFang TC',sans-serif;
  box-shadow: 0 12px 50px rgba(0,0,0,.6);
}
.mem-card h3 { margin: 0 0 4px; font-size: 18px; color: #fff; display:flex; align-items:center; gap:8px; }
.mem-card .sub { color: #c9b89e; font-size: 12px; margin-bottom: 16px; }
.mem-card label { display: block; color: #d4a87e; font-size: 12px; margin: 12px 0 4px; font-weight: 600; }
.mem-card select, .mem-card textarea, .mem-card input {
  width: 100%; box-sizing: border-box;
  background: rgba(0,0,0,.35); border: 1px solid rgba(176,141,87,.3);
  color: #fff; border-radius: 8px; padding: 8px 10px;
  font-family: inherit; font-size: 13px;
}
.mem-card textarea { min-height: 110px; resize: vertical; line-height: 1.5; }
.mem-card .row { display: flex; gap: 10px; }
.mem-card .row > * { flex: 1; }
.mem-card .actions { display: flex; gap: 10px; margin-top: 18px; justify-content: flex-end; }
.mem-card .btn {
  background: linear-gradient(135deg, #B08D57, #d4a87e); color: #3a1521;
  border: none; padding: 9px 18px; border-radius: 20px;
  font-weight: 700; cursor: pointer; font-size: 13px;
}
.mem-card .btn.ghost {
  background: transparent; color: #c9b89e;
  border: 1px solid rgba(176,141,87,.4);
}
.mem-card .hint { color: #9c8973; font-size: 11px; margin-top: 6px; line-height: 1.5; }
.mem-card .recent {
  margin-top: 16px; padding-top: 12px;
  border-top: 1px dashed rgba(176,141,87,.25);
  max-height: 180px; overflow-y: auto;
}
.mem-card .recent h4 { margin: 0 0 8px; font-size: 12px; color: #d4a87e; text-transform: uppercase; }
.mem-card .recent .item { padding: 6px 0; border-bottom: 1px dashed rgba(176,141,87,.12); font-size: 12px; color: #e4d6bc; }
.mem-card .recent .item .t { color: #d4a87e; font-size: 10px; margin-right: 6px; }
.mem-card .recent .item .del { float: right; cursor: pointer; color: #ff6b6b; font-size: 11px; }

.mem-toast {
  position: fixed; top: 22px; right: 22px;
  padding: 12px 20px; border-radius: 10px; font-weight: 600;
  z-index: 10000; display: none;
  font-family: 'Noto Sans TC',sans-serif;
}
.mem-toast.success { background: linear-gradient(135deg,#3ddc84,#2b9c5e); color: #0a2a16; }
.mem-toast.error { background: linear-gradient(135deg,#ff6b6b,#c5424a); color: #fff; }
.mem-toast.show { display: block; animation: memToastIn .3s ease; }
@keyframes memToastIn { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // FAB
  const fab = document.createElement('button');
  fab.className = 'mem-fab';
  fab.title = '記住一件事 — 讓所有 AI 員工都知道';
  fab.innerHTML = '💾 <span class="lbl">記住</span>';
  document.body.appendChild(fab);

  // Modal
  const overlay = document.createElement('div');
  overlay.className = 'mem-overlay';
  overlay.innerHTML = `
    <div class="mem-card">
      <h3>💾 記住一件事</h3>
      <div class="sub">寫進長期記憶後,所有 AI 員工(NOVA / CAMILLE / VICTOR / DEX...)都會記得這件事,影響後續決策和文案</div>
      <div class="row">
        <div>
          <label>分類</label>
          <select id="memTopic">
            <option>文案調性</option>
            <option>門市</option>
            <option>產品</option>
            <option>管道</option>
            <option>TA</option>
            <option>策略</option>
            <option>數據</option>
            <option>競品</option>
            <option>節慶</option>
            <option>其他</option>
          </select>
        </div>
        <div>
          <label>重要度</label>
          <select id="memPriority">
            <option value="high">高 ⭐(永遠優先)</option>
            <option value="medium" selected>中(一般偏好)</option>
            <option value="low">低(備註)</option>
          </select>
        </div>
      </div>
      <label>內容(用一句話講清楚這個決策 / 偏好 / 事實)</label>
      <textarea id="memContent" placeholder="例:對外文案不要寫『限時搶購』、母親節主打 6 入 NT$880、巨蛋店預計 8 月開..."></textarea>
      <div class="hint">💡 提示:可以寫「以後都這樣...」「禁用...」「主打...」「不要做...」「目標是...」</div>
      <div class="recent" id="memRecent"><h4>最近 5 條記憶</h4><div id="memRecentList">載入中...</div></div>
      <div class="actions">
        <button class="btn ghost" id="memCancel">取消</button>
        <button class="btn" id="memSave">💾 記住</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const toast = document.createElement('div');
  toast.className = 'mem-toast';
  document.body.appendChild(toast);
  function showToast(msg, isError) {
    toast.textContent = msg;
    toast.className = 'mem-toast show ' + (isError ? 'error' : 'success');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }

  function open() {
    overlay.classList.add('show');
    setTimeout(() => document.getElementById('memContent').focus(), 50);
    loadRecent();
  }
  function close() {
    overlay.classList.remove('show');
    document.getElementById('memContent').value = '';
  }
  fab.addEventListener('click', open);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + M 開記憶
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      open();
    }
  });

  document.getElementById('memCancel').addEventListener('click', close);
  document.getElementById('memSave').addEventListener('click', async () => {
    const content = document.getElementById('memContent').value.trim();
    if (!content) { showToast('內容不能空', true); return; }
    const topic = document.getElementById('memTopic').value;
    const priority = document.getElementById('memPriority').value;
    try {
      const r = await fetch('/api/memory/remember', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, content, priority, source: 'widget-manual' })
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || '失敗');
      showToast('✅ 記住了 — 所有 AI 員工下次回覆都會記得');
      close();
      loadRecent();
    } catch (e) {
      showToast('❌ ' + e.message, true);
    }
  });

  async function loadRecent() {
    const list = document.getElementById('memRecentList');
    if (!list) return;
    try {
      const r = await fetch('/api/memory/list');
      const d = await r.json();
      const items = (d.items || []).slice(0, 5);
      if (items.length === 0) {
        list.innerHTML = '<div style="color:#9c8973;font-size:12px">尚無記憶,寫第一條吧</div>';
        return;
      }
      list.innerHTML = items.map(m => `
        <div class="item">
          <span class="t">[${m.topic || '其他'}]</span>${escapeHtml(m.content)}
          <span class="del" data-id="${m.id}" title="刪除">×</span>
        </div>`).join('');
      list.querySelectorAll('.del').forEach(el => {
        el.addEventListener('click', async () => {
          if (!confirm('確定刪除這條記憶?')) return;
          await fetch('/api/memory/' + el.dataset.id, { method: 'DELETE' });
          loadRecent();
        });
      });
    } catch (e) {
      list.innerHTML = '<div style="color:#ff6b6b;font-size:12px">' + e.message + '</div>';
    }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // ============ Chat proposal JSON 美化 ============
  // 自動偵測 chat 訊息中的 propose_* JSON,把 caption / imageUrl 等抽出來顯示
  function beautifyProposals() {
    document.querySelectorAll('.message, [class*="msg"], [class*="bubble"], .chat-msg').forEach(el => {
      if (el.dataset.memBeautified) return;
      const html = el.innerHTML;
      // 抓 JSON code block 看是否含 caption
      const jsonMatch = el.innerText.match(/\{\s*"caption"\s*:\s*"([\s\S]+?)"\s*,\s*"imageUrl"\s*:\s*"([^"]+)"\s*\}/);
      if (jsonMatch) {
        const caption = jsonMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
        const imageUrl = jsonMatch[2];
        const propMatch = el.innerText.match(/Proposal ID:\s*`(p_[^`]+)`/);
        const propId = propMatch ? propMatch[1] : null;
        const wrap = document.createElement('div');
        wrap.style.cssText = 'background:rgba(0,0,0,.18);border:1px solid rgba(176,141,87,.3);border-radius:12px;padding:14px;margin-top:8px';
        wrap.innerHTML = `
          <div style="color:#d4a87e;font-size:11px;font-weight:600;margin-bottom:8px">📣 NOVA 提案 IG 貼文</div>
          ${imageUrl ? `<img src="${imageUrl}" style="width:100%;max-width:380px;border-radius:8px;margin-bottom:10px"/>` : ''}
          <div style="white-space:pre-wrap;line-height:1.6;color:#f4e8d4;font-size:13px">${escapeHtml(caption)}</div>
          ${propId ? `<div style="display:flex;gap:8px;margin-top:10px"><button class="mem-publish-btn" data-id="${propId}" style="background:linear-gradient(135deg,#3ddc84,#2b9c5e);color:#0a2a16;border:none;padding:6px 14px;border-radius:16px;font-weight:700;cursor:pointer;font-size:12px">✅ 發布</button><button class="mem-skip-btn" style="background:transparent;color:#c9b89e;border:1px solid rgba(176,141,87,.4);padding:6px 14px;border-radius:16px;cursor:pointer;font-size:12px">略過</button></div>` : ''}
        `;
        // 隱藏原 JSON,加美化版
        const orig = document.createElement('details');
        orig.style.cssText = 'margin-top:8px;color:#9c8973;font-size:11px';
        orig.innerHTML = '<summary style="cursor:pointer">查看原始 JSON</summary><pre style="background:rgba(0,0,0,.3);padding:10px;border-radius:6px;overflow-x:auto;font-size:10px">' + escapeHtml(el.innerText) + '</pre>';
        el.innerHTML = '';
        el.appendChild(wrap);
        el.appendChild(orig);
        el.dataset.memBeautified = '1';
        // 綁定發布按鈕
        const pubBtn = wrap.querySelector('.mem-publish-btn');
        if (pubBtn) {
          pubBtn.addEventListener('click', async () => {
            pubBtn.disabled = true;
            pubBtn.textContent = '發布中…';
            try {
              const r = await fetch('/api/proposals/' + pubBtn.dataset.id + '/execute', { method: 'POST' });
              const d = await r.json();
              if (d.ok) { showToast('✅ 已發布'); pubBtn.textContent = '✅ 已發布'; }
              else throw new Error(d.error || '失敗');
            } catch (e) { showToast('❌ ' + e.message, true); pubBtn.disabled = false; pubBtn.textContent = '✅ 發布'; }
          });
        }
      }
    });
  }
  // 每秒掃一次新訊息
  setInterval(beautifyProposals, 1000);
  beautifyProposals();
})();
