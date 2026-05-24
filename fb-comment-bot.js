// fb-comment-bot.js — FB/IG 留言自動回 + 隱藏
// Meta webhook 收到留言 → 自動回「私訊我們」→ 隱藏該留言

const REPLY_TEXT = process.env.FB_COMMENT_AUTO_REPLY || '感謝您留言 🥐 為了給您最完整的服務,煩請私訊我們,專人為您介紹禮盒選項。';
const HIDE_OR_DELETE = process.env.FB_COMMENT_ACTION || 'hide'; // 'hide' 或 'delete'

// 取 Page Access Token（MACARON DE LUXE 粉專各自的）
async function getPageToken(pageId) {
  const userToken = process.env.META_ACCESS_TOKEN;
  if (!userToken) throw new Error('META_ACCESS_TOKEN missing');
  const r = await fetch('https://graph.facebook.com/v19.0/me/accounts?access_token=' + encodeURIComponent(userToken));
  const j = await r.json();
  const page = (j.data || []).find(p => p.id === pageId);
  if (!page || !page.access_token) throw new Error('Page token not found for ' + pageId);
  return page.access_token;
}

// 回覆留言
async function replyToComment(commentId, pageToken, message) {
  const url = 'https://graph.facebook.com/v19.0/' + commentId + '/comments';
  const body = new URLSearchParams();
  body.append('message', message);
  body.append('access_token', pageToken);
  const r = await fetch(url, { method: 'POST', body });
  return r.json();
}

// 隱藏留言（業界推薦做法 — 留言者自己仍能看到，其他人看不到）
async function hideComment(commentId, pageToken) {
  const url = 'https://graph.facebook.com/v19.0/' + commentId;
  const body = new URLSearchParams();
  body.append('is_hidden', 'true');
  body.append('access_token', pageToken);
  const r = await fetch(url, { method: 'POST', body });
  return r.json();
}

// 刪除留言（不可逆 — 留言者也看不到自己的留言）
async function deleteComment(commentId, pageToken) {
  const url = 'https://graph.facebook.com/v19.0/' + commentId + '?access_token=' + encodeURIComponent(pageToken);
  const r = await fetch(url, { method: 'DELETE' });
  return r.json();
}

// 主要 webhook 處理
async function handleCommentEvent(entry) {
  const results = [];
  const pageId = entry.id;
  if (!entry.changes) return results;
  for (const change of entry.changes) {
    if (change.field !== 'feed') continue;
    const v = change.value || {};
    // Only process new comments from non-page authors
    if (v.item !== 'comment' || v.verb !== 'add') continue;
    if (v.from && v.from.id === pageId) continue; // skip page's own replies
    const commentId = v.comment_id;
    if (!commentId) continue;
    try {
      const token = await getPageToken(pageId);
      // 1) Reply with redirect message
      const replyResult = await replyToComment(commentId, token, REPLY_TEXT);
      // 2) Hide or delete the original comment
      let actionResult = null;
      if (HIDE_OR_DELETE === 'delete') actionResult = await deleteComment(commentId, token);
      else actionResult = await hideComment(commentId, token);
      // Log
      const log = { ts: new Date().toISOString(), page_id: pageId, comment_id: commentId,
                    commenter_name: v.from && v.from.name, original_text: (v.message || '').slice(0, 200),
                    reply_ok: !replyResult.error, action: HIDE_OR_DELETE, action_ok: !actionResult.error,
                    errors: [replyResult.error, actionResult.error].filter(Boolean) };
      try {
        const fs = require('fs'); const path = require('path');
        const dir = process.env.RENDER_DISK_MOUNT_PATH || '/tmp';
        fs.appendFileSync(path.join(dir, 'fb_comment_bot.jsonl'), JSON.stringify(log) + '\n');
      } catch {}
      results.push(log);
    } catch (e) {
      results.push({ comment_id: commentId, error: e.message });
    }
  }
  return results;
}

// 訂閱 webhook — 一鍵讓所有 MACARON DE LUXE pages 開始送 comment events 給我們
async function subscribeAllOfzPages() {
  const userToken = process.env.META_ACCESS_TOKEN;
  if (!userToken) throw new Error('META_ACCESS_TOKEN missing');
  const r = await fetch('https://graph.facebook.com/v19.0/me/accounts?access_token=' + encodeURIComponent(userToken));
  const j = await r.json();
  const ofzPages = (j.data || []).filter(p => /ofz/i.test(p.name));
  const results = [];
  for (const p of ofzPages) {
    try {
      const body = new URLSearchParams();
      body.append('subscribed_fields', 'feed');
      body.append('access_token', p.access_token);
      const r2 = await fetch('https://graph.facebook.com/v19.0/' + p.id + '/subscribed_apps', { method: 'POST', body });
      const j2 = await r2.json();
      results.push({ page_id: p.id, page_name: p.name, ok: !!j2.success, error: j2.error && j2.error.message });
    } catch (e) { results.push({ page_id: p.id, page_name: p.name, ok: false, error: e.message }); }
  }
  return results;
}

function getRecentLog(n) {
  n = n || 20;
  try {
    const fs = require('fs'); const path = require('path');
    const dir = process.env.RENDER_DISK_MOUNT_PATH || '/tmp';
    const file = path.join(dir, 'fb_comment_bot.jsonl');
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean).reverse();
  } catch { return []; }
}

module.exports = { handleCommentEvent, replyToComment, hideComment, deleteComment, subscribeAllOfzPages, getRecentLog };
