// wordpress.js — Push posts to macarondeluxe.com via WP REST API
const WP_API_URL = process.env.WORDPRESS_API_URL || 'https://macarondeluxe.com/wp-json/wp/v2';
const WP_USER = process.env.WORDPRESS_USERNAME || '';
const WP_PWD = process.env.WORDPRESS_APP_PASSWORD || '';

function authHeader() {
  if (!WP_USER || !WP_PWD) return null;
  return 'Basic ' + Buffer.from(WP_USER + ':' + WP_PWD).toString('base64');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatInline(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\`(.+?)\`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function formatInline(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#8E3D4B;font-weight:600">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\`(.+?)\`/g, '<code style="background:#FDF7EE;padding:2px 6px;border-radius:4px;color:#8E3D4B;font-family:Menlo,monospace;font-size:0.92em">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:#A37849;border-bottom:1px solid #A37849;text-decoration:none">$1</a>');
}

function md2html(md) {
  if (!md) return '';
  const lines = md.split(/\r?\n/);
  const out = [];
  let inUL = false, inOL = false, inTable = false, tableHeader = null, tableRows = [];
  function closeAll() {
    if (inUL) { out.push('</ul>'); inUL = false; }
    if (inOL) { out.push('</ol>'); inOL = false; }
    if (inTable) {
      const headerCells = (tableHeader || []).map(c =>
        '<th style="background:#B8755C;color:#FFFFFF;padding:14px 16px;text-align:left;font-weight:600;font-size:15px;border:none;font-family:Montserrat,\'Noto Sans TC\',sans-serif">' + formatInline(c) + '</th>'
      ).join('');
      const bodyRows = tableRows.map((row, i) =>
        '<tr style="background:' + (i % 2 === 0 ? '#1A1612' : '#221C18') + ';color:#F0E3DC">' +
        row.map(c =>
          '<td style="padding:12px 16px;border-top:1px solid #3A2F2A;font-size:15px;color:#F0E3DC;line-height:1.7;font-family:Montserrat,\'Noto Sans TC\',sans-serif">' + formatInline(c) + '</td>'
        ).join('') + '</tr>'
      ).join('');
      out.push(
        '<div style="overflow-x:auto;margin:28px 0">' +
        '<table style="width:100%;border-collapse:collapse;background:#1A1612;border-radius:8px;overflow:hidden;color:#F0E3DC;border:1px solid #3A2F2A">' +
        '<thead><tr>' + headerCells + '</tr></thead>' +
        '<tbody>' + bodyRows + '</tbody>' +
        '</table></div>'
      );
      inTable = false; tableHeader = null; tableRows = [];
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const trimmed = l.trim();
    if (/^\|.*\|\s*$/.test(trimmed)) {
      const cells = trimmed.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      if (/^[-: ]+$/.test(cells.join(''))) { continue; }
      if (!inTable) { closeAll(); inTable = true; tableHeader = cells; }
      else { tableRows.push(cells); }
      continue;
    } else if (inTable) { closeAll(); }
    if (/^### (.+)$/.test(l)) {
      closeAll();
      out.push('<h3 style="font-size:21px;color:#B8755C;margin:32px 0 14px;padding-left:14px;border-left:4px solid #B8755C;font-weight:600;line-height:1.5;font-family:\'Playfair Display\',\'Noto Serif TC\',serif">' + formatInline(RegExp.$1) + '</h3>');
    } else if (/^## (.+)$/.test(l)) {
      closeAll();
      out.push('<h2 style="font-size:28px;color:#F0E3DC;margin:48px 0 20px;padding-bottom:12px;border-bottom:1px solid #B8755C;font-weight:700;line-height:1.4;font-family:\'Playfair Display\',\'Noto Serif TC\',serif">' + formatInline(RegExp.$1) + '</h2>');
    } else if (/^# (.+)$/.test(l)) {
      closeAll();
    } else if (/^> (.+)$/.test(l)) {
      closeAll();
      out.push('<blockquote style="background:#1A1612;border-left:4px solid #B8755C;margin:24px 0;padding:18px 22px;color:#F0E3DC;font-style:italic;border-radius:0 6px 6px 0;line-height:1.8;font-family:Montserrat,\'Noto Sans TC\',sans-serif">' + formatInline(RegExp.$1) + '</blockquote>');
    } else if (/^[-*] (.+)$/.test(l)) {
      if (!inUL) { closeAll(); out.push('<ul style="margin:18px 0;padding-left:28px;color:#FFFFFF;line-height:1.9;font-family:Montserrat,\'Noto Sans TC\',sans-serif">'); inUL = true; }
      out.push('<li style="margin:8px 0;color:#FFFFFF">' + formatInline(RegExp.$1) + '</li>');
    } else if (/^\d+\. (.+)$/.test(l)) {
      if (!inOL) { closeAll(); out.push('<ol style="margin:18px 0;padding-left:28px;color:#FFFFFF;line-height:1.9;font-family:Montserrat,\'Noto Sans TC\',sans-serif">'); inOL = true; }
      out.push('<li style="margin:8px 0;color:#FFFFFF">' + formatInline(RegExp.$1) + '</li>');
    } else if (trimmed === '---' || trimmed === '***') {
      closeAll();
      out.push('<hr style="border:none;border-top:1px solid #3A2F2A;margin:36px 0">');
    } else if (trimmed === '') {
      closeAll();
    } else {
      closeAll();
      if (/^[\u{1F300}-\u{1F9FF}\u2600-\u27BF]\s/u.test(trimmed)) {
        out.push(
          '<div style="background:linear-gradient(135deg,#1A1612,#221C18);border-left:4px solid #B8755C;margin:22px 0;padding:18px 22px;color:#F0E3DC;border-radius:0 8px 8px 0;font-size:16px;line-height:1.8;font-family:Montserrat,\'Noto Sans TC\',sans-serif">' +
          formatInline(trimmed) +
          '</div>'
        );
      } else {
        out.push('<p style="margin:18px 0;color:#FFFFFF;font-size:17px;line-height:1.95;letter-spacing:0.2px;font-family:Montserrat,\'Noto Sans TC\',sans-serif">' + formatInline(l) + '</p>');
      }
    }
  }
  closeAll();
  const html = out.join('\n');
  return '<style>.wp-block-post-title,h1.wp-block-post-title,.entry-title,article h1.alignwide,article h1{margin-top:140px !important;padding-top:24px !important;line-height:1.4 !important;text-wrap:balance;text-wrap:pretty;word-break:keep-all;overflow-wrap:break-word;max-width:780px;margin-left:auto !important;margin-right:auto !important;text-align:center;font-size:clamp(24px,4vw,38px) !important;font-family:\'Playfair Display\',\'Noto Serif TC\',serif !important}@media (max-width:768px){.wp-block-post-title,h1.wp-block-post-title,.entry-title,article h1.alignwide,article h1{margin-top:100px !important;padding-top:16px !important;font-size:22px !important;line-height:1.45 !important;padding-left:16px;padding-right:16px}}</style>' + '<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version="2.0";n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,"script","https://connect.facebook.net/en_US/fbevents.js");fbq("init","1475056767679373");fbq("track","PageView");document.addEventListener("click",function(e){var a=e.target.closest("a");if(!a)return;var h=a.getAttribute("href")||"";if(/(facebook\\.com|m\\.me|wa\\.me|whatsapp|line\\.me|line\\/|t\\.me|telegram|mailto:|tel:)/i.test(h)||/私訊|諮詢|聯絡|預約|報名/.test(a.textContent||"")){fbq("track","Lead",{content_name:document.title,source_url:location.href});try{fetch("https://macaron-office.onrender.com/api/lead/track",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content_name:document.title,source_url:location.href,fbclid:new URLSearchParams(location.search).get("fbclid")||null})})}catch(e){}}});</script><noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=1475056767679373&ev=PageView&noscript=1"/></noscript>' + '<div style="font-family:Montserrat,\'Noto Sans TC\',sans-serif;max-width:780px;margin:0 auto;color:#FFFFFF;line-height:1.85;font-size:17px;padding:0 16px">' +
    html +
    '<div style="margin-top:56px;padding:32px 28px;background:#B8755C;border-radius:14px;text-align:center;color:#FFFFFF">' +
    '<div style="font-size:22px;font-weight:700;margin-bottom:10px;color:#FFFFFF;letter-spacing:0.5px;font-family:\'Playfair Display\',\'Noto Serif TC\',serif">專業諮詢 溫點 WarmPlace</div>' +
    '<div style="font-size:15px;margin-bottom:20px;color:#F0E3DC;line-height:1.7;opacity:0.95">韓系精品禮盒 · 客製婚禮喜餅 · 企業禮贈 · 一對一專屬諮詢</div>' +
    '<a href="https://www.facebook.com/ofzbeautyacademy" style="display:inline-block;background:#FFFFFF;color:#B8755C;padding:13px 36px;border-radius:30px;text-decoration:none;font-weight:700;font-size:16px;letter-spacing:0.5px">📩 私訊了解詳情</a>' +
    '</div></div>';
}

async function publishPost({ title, contentMarkdown, status = 'publish', tags = [], excerpt = '' } = {}) {
  const auth = authHeader();
  if (!auth) return { ok: false, error: 'WP credentials not set in env' };
  if (!title || !contentMarkdown) return { ok: false, error: 'title and contentMarkdown required' };
  // SEO: fetch 3 recent posts and append "延伸閱讀" to markdown for internal linking
  let enrichedMd = contentMarkdown;
  try {
    const lr = await listPosts({ per_page: 5 });
    const recent = ((lr && lr.items) || lr || []).filter(p => p.title !== title).slice(0, 3);
    if (recent.length) {
      enrichedMd += '\n\n## 延伸閱讀\n\n';
      for (const p of recent) {
        enrichedMd += '- [' + p.title + '](' + p.link + ')\n';
      }
    }
  } catch {}
  const html = md2html(enrichedMd);
  try {
    const r = await fetch(WP_API_URL + '/posts', {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        title, content: html, status,
        excerpt: excerpt || (contentMarkdown || '').replace(/[#*\`]/g, '').split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 160),
      })
    });
    const j = await r.json();
    if (!r.ok || j.code) return { ok: false, error: (j.message || j.code || 'unknown WP error'), raw: j };
    // SEO: ping Google sitemap + IndexNow (Bing/Yandex)
    try {
      const url = j.link;
      // Google sitemap ping
      fetch('https://www.google.com/ping?sitemap=' + encodeURIComponent('https://macarondeluxe.com/sitemap.xml')).catch(()=>{});
      // Bing IndexNow ping (instant indexing on Bing/Yandex)
      fetch('https://api.indexnow.org/IndexNow?url=' + encodeURIComponent(url) + '&key=ofz1475056767679373indexnowkeyabcdef').catch(()=>{});
    } catch {}
    return { ok: true, id: j.id, link: j.link, status: j.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function whoami() {
  const auth = authHeader();
  if (!auth) return { ok: false, error: 'WP credentials not set' };
  try {
    const r = await fetch(WP_API_URL + '/users/me?context=edit', { headers: { 'Authorization': auth, 'Accept': 'application/json' } });
    const j = await r.json();
    if (j.code) return { ok: false, error: j.message || j.code };
    return { ok: true, id: j.id, name: j.name, slug: j.slug };
  } catch (e) { return { ok: false, error: e.message }; }
}


async function listPosts({ status = 'any', perPage = 30 } = {}) {
  const auth = authHeader();
  if (!auth) return { ok: false, error: 'WP credentials not set' };
  try {
    const r = await fetch(WP_API_URL + '/posts?status=' + encodeURIComponent(status) + '&per_page=' + perPage + '&context=edit', {
      headers: { 'Authorization': auth, 'Accept': 'application/json' }
    });
    const j = await r.json();
    if (j.code) return { ok: false, error: j.message || j.code };
    return {
      ok: true,
      items: (j || []).map(p => ({
        id: p.id,
        title: (p.title && (p.title.rendered || p.title.raw)) || '',
        status: p.status,
        date: p.date,
        link: p.link,
      }))
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function trashPost(id) {
  const auth = authHeader();
  if (!auth) return { ok: false, error: 'WP credentials not set' };
  if (!id) return { ok: false, error: 'id required' };
  try {
    // No force=true → moves to Trash (reversible)
    const r = await fetch(WP_API_URL + '/posts/' + id, {
      method: 'DELETE',
      headers: { 'Authorization': auth, 'Accept': 'application/json' }
    });
    const j = await r.json();
    if (j.code) return { ok: false, error: j.message || j.code };
    return { ok: true, id: j.id, status: j.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function updatePost(id, fields) {
  const auth = authHeader(); if (!auth) throw new Error('WP_USER/WP_PWD not set');
  const url = WP_API_URL + '/posts/' + id;
  const r = await fetch(url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
  const j = await r.json();
  if (!r.ok) throw new Error('WP update failed: ' + (j.message || JSON.stringify(j)));
  return { ok: true, id: j.id, link: j.link, status: j.status };
}

async function getPostRaw(id) {
  const auth = authHeader(); if (!auth) throw new Error('WP_USER/WP_PWD not set');
  const r = await fetch(WP_API_URL + '/posts/' + id + '?context=edit', { headers: { Authorization: auth } });
  const j = await r.json();
  if (!r.ok) throw new Error('WP get failed: ' + (j.message || JSON.stringify(j)));
  return j;
}

module.exports = { publishPost, listPosts, trashPost, whoami, md2html, updatePost, getPostRaw };
