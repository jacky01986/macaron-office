// ============================================================
// meta-admin.js — 刪除 FB Page / IG 貼文 (測試/清理用)
// Mount: app.use('/api/meta-admin', require('./meta-admin'));
// ============================================================
const express = require('express');
const router = express.Router();

const GRAPH = 'https://graph.facebook.com/v21.0';

function getToken() {
  return process.env.META_ACCESS_TOKEN || process.env.FB_PAGE_TOKEN || process.env.META_PAGE_TOKEN || '';
}

// DELETE 貼文 (FB or IG)
router.post('/delete-post', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.confirmed) return res.status(400).json({ error: 'must include confirmed:true' });
    const postId = body.postId;
    if (!postId) return res.status(400).json({ error: 'postId required' });
    const token = getToken();
    if (!token) return res.status(500).json({ error: 'META access token not set' });
    const url = GRAPH + '/' + encodeURIComponent(postId) + '?access_token=' + encodeURIComponent(token);
    const r = await fetch(url, { method: 'DELETE' });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(r.ok ? 200 : r.status).json({ ok: r.ok, status: r.status, postId, response: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET 貼文資訊 (驗證貼文真的在 / 已刪)
router.get('/post/:postId', async (req, res) => {
  try {
    const postId = req.params.postId;
    const token = getToken();
    if (!token) return res.status(500).json({ error: 'META access token not set' });
    const url = GRAPH + '/' + encodeURIComponent(postId) + '?fields=id,message,created_time,permalink_url&access_token=' + encodeURIComponent(token);
    const r = await fetch(url);
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(r.ok ? 200 : r.status).json({ ok: r.ok, status: r.status, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/_status', (req, res) => res.json({ ok: true, has_token: !!getToken() }));

module.exports = router;
