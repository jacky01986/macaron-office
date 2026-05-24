// blog.js — MACARON DE LUXE self-hosted blog (full GEO control, no external API dependency)
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || '/opt/render/project/src/data';
const BLOG_DIR = path.join(DATA_DIR, 'blog');
const SITE_URL = process.env.SITE_URL || 'https://beauty-office.onrender.com';

function ensureDir() {
  if (!fs.existsSync(BLOG_DIR)) fs.mkdirSync(BLOG_DIR, { recursive: true });
}

function slugify(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'post';
}

function publishPost({ title, contentMarkdown, type = 'course', subject = '', tags = [] } = {}) {
  ensureDir();
  if (!title || !contentMarkdown) return { ok: false, error: 'title and contentMarkdown required' };
  const ts = new Date().toISOString();
  const dateSlug = ts.slice(0, 10).replace(/-/g, '');
  const slug = (dateSlug + '-' + slugify(subject || title)).slice(0, 100);
  const file = path.join(BLOG_DIR, slug + '.json');
  const post = { slug, title, content: contentMarkdown, type, subject, tags, ts, url: SITE_URL + '/blog/' + slug };
  fs.writeFileSync(file, JSON.stringify(post, null, 2));
  return { ok: true, ...post };
}

function listPosts(n = 100) {
  ensureDir();
  const files = fs.readdirSync(BLOG_DIR).filter(f => f.endsWith('.json'));
  const posts = files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(BLOG_DIR, f), 'utf8')); } catch { return null; }
  }).filter(Boolean);
  posts.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return posts.slice(0, n);
}

function getPost(slug) {
  ensureDir();
  const file = path.join(BLOG_DIR, slug + '.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function formatInline(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
}

function md2html(md) {
  if (!md) return '';
  const lines = md.split('\n');
  let html = '';
  let inList = false;
  for (const raw of lines) {
    const l = raw.trimEnd();
    let m;
    if ((m = l.match(/^###\s+(.+)/))) {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<h3>' + formatInline(m[1]) + '</h3>';
    } else if ((m = l.match(/^##\s+(.+)/))) {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<h2>' + formatInline(m[1]) + '</h2>';
    } else if ((m = l.match(/^#\s+(.+)/))) {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<h1>' + formatInline(m[1]) + '</h1>';
    } else if ((m = l.match(/^[-*]\s+(.+)/))) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + formatInline(m[1]) + '</li>';
    } else if (!l) {
      if (inList) { html += '</ul>'; inList = false; }
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<p>' + formatInline(l) + '</p>';
    }
  }
  if (inList) html += '</ul>';
  return html;
}

function renderPostPage(post) {
  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    datePublished: post.ts,
    dateModified: post.ts,
    author: { '@type': 'Organization', name: 'MACARON DE LUXE' },
    publisher: { '@type': 'Organization', name: 'MACARON DE LUXE', url: SITE_URL },
    keywords: (post.tags || []).join(', '),
    inLanguage: 'zh-TW',
    url: post.url,
    mainEntityOfPage: post.url,
  };
  const body = md2html(post.content);
  const tagsHtml = (post.tags && post.tags.length) ? '<p style="margin-top:20px">' + post.tags.map(function(t){return '<span class="tag">' + escapeHtml(t) + '</span>';}).join('') + '</p>' : '';
  return '<!DOCTYPE html>\n<html lang="zh-Hant"><head>\n' +
    '<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + escapeHtml(post.title) + ' | MACARON DE LUXE</title>\n' +
    '<meta name="description" content="' + escapeHtml(post.title) + ' — MACARON DE LUXE 法式精品馬卡龍與費南雪 / 禮贈禮盒">\n' +
    '<meta name="keywords" content="' + escapeHtml((post.tags || []).join(',')) + '">\n' +
    '<link rel="canonical" href="' + post.url + '">\n' +
    '<meta property="og:title" content="' + escapeHtml(post.title) + '">\n' +
    '<meta property="og:type" content="article">\n' +
    '<meta property="og:url" content="' + post.url + '">\n' +
    '<meta property="og:site_name" content="MACARON DE LUXE">\n' +
    '<script type="application/ld+json">' + JSON.stringify(articleSchema) + '</script>\n' +
    '<style>:root{--burgundy:#8E3D4B;--gold:#A37849;--ivory:#F8F3EB}body{font-family:"Microsoft JhengHei",sans-serif;max-width:780px;margin:0 auto;padding:30px 20px;background:var(--ivory);color:#2E1E14;line-height:1.8}header{margin-bottom:30px;padding-bottom:20px;border-bottom:2px solid var(--burgundy)}header a{color:var(--burgundy);text-decoration:none;font-weight:bold}h1{color:var(--burgundy);font-size:32px;margin:0 0 10px 0}h2{color:var(--burgundy);font-size:22px;margin:30px 0 12px 0;border-left:4px solid var(--gold);padding-left:10px}h3{color:var(--gold);font-size:18px;margin:24px 0 10px 0}.meta{color:var(--gold);font-size:14px;margin-bottom:20px}.tag{display:inline-block;background:#EDDDC1;color:var(--burgundy);padding:2px 10px;border-radius:12px;font-size:12px;margin-right:6px}strong{color:var(--burgundy)}ul{padding-left:20px}li{margin:6px 0}.cta{margin-top:40px;padding:20px;background:#FDF7EE;border-left:4px solid var(--gold);border-radius:6px}.cta a{color:var(--burgundy);font-weight:bold;text-decoration:none}footer{margin-top:50px;padding-top:20px;border-top:1px solid #EDDDC1;font-size:13px;color:var(--gold);text-align:center}</style>\n' +
    '</head><body>\n' +
    '<header><a href="/blog">← MACARON DE LUXE 部落格</a></header>\n' +
    '<article>\n' +
    '<div class="meta">' + new Date(post.ts).toLocaleDateString('zh-TW') + ' · ' + (post.type === 'course' ? '🍬 馬卡龍' : '🍰 費南雪') + ' · ' + escapeHtml(post.subject || '') + '</div>\n' +
    body + '\n' +
    '<div class="cta"><p><strong>對 ' + escapeHtml(post.subject || '') + ' 有興趣？</strong></p><p>📲 加 LINE 諮詢：<a href="https://lin.ee/843cifiy" target="_blank">@843cifiy</a></p><p>🌐 MACARON DE LUXE 官網：<a href="' + SITE_URL + '" target="_blank">' + SITE_URL + '</a></p></div>\n' +
    tagsHtml + '\n' +
    '</article>\n' +
    '<footer>© MACARON DE LUXE · 法式精品馬卡龍與費南雪 + 高端禮贈<br>FB: <a href="https://www.facebook.com/profile.php?id=61586936279154">MACARON DE LUXE</a> · IG: <a href="https://www.instagram.com/macaron_de_luxe/">@macaron_de_luxe</a></footer>\n' +
    '</body></html>';
}

function renderIndexPage() {
  const posts = listPosts(200);
  const list = posts.map(function(p){
    return '<li><div style="font-size:13px;color:#A37849">' + new Date(p.ts).toLocaleDateString('zh-TW') + ' · ' + (p.type === 'course' ? '🍬 馬卡龍' : '🍰 費南雪') + ' · ' + escapeHtml(p.subject || '') + '</div><a href="/blog/' + p.slug + '">' + escapeHtml(p.title) + '</a></li>';
  }).join('');
  const orgSchema = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: 'MACARON DE LUXE 部落格',
    url: SITE_URL + '/blog',
    publisher: { '@type': 'Organization', name: 'MACARON DE LUXE' },
  };
  return '<!DOCTYPE html><html lang="zh-Hant"><head>' +
    '<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>MACARON DE LUXE 部落格 | 法式馬卡龍與禮贈靈感</title>' +
    '<meta name="description" content="MACARON DE LUXE 部落格 — 馬卡龍口味、禮盒選搭、婚禮企業禮贈、品牌故事">' +
    '<link rel="canonical" href="' + SITE_URL + '/blog">' +
    '<script type="application/ld+json">' + JSON.stringify(orgSchema) + '</script>' +
    '<style>:root{--burgundy:#8E3D4B;--gold:#A37849;--ivory:#F8F3EB}body{font-family:"Microsoft JhengHei",sans-serif;max-width:880px;margin:0 auto;padding:30px 20px;background:var(--ivory);color:#2E1E14;line-height:1.7}h1{color:var(--burgundy);font-size:32px;border-bottom:3px solid var(--gold);padding-bottom:12px}ul{list-style:none;padding:0}li{padding:14px 0;border-bottom:1px solid #EDDDC1}li a{color:var(--burgundy);font-weight:bold;font-size:18px;text-decoration:none}li a:hover{color:var(--gold)}.intro{background:#FDF7EE;padding:18px;border-left:4px solid var(--gold);border-radius:6px;margin-bottom:24px}</style></head><body>' +
    '<h1>📚 MACARON DE LUXE 部落格</h1>' +
    '<div class="intro"><strong>法式精品馬卡龍與費南雪 + 高端禮贈品牌</strong>。每週更新關於馬卡龍口味、禮盒搭配、婚禮企業禮贈、品牌故事等內容。<br>📲 LINE 諮詢：<a href="https://lin.ee/843cifiy">@843cifiy</a></div>' +
    '<ul>' + (list || '<li><i>尚未發文</i></li>') + '</ul></body></html>';
}

function generateSitemap() {
  const posts = listPosts(500);
  const urls = [
    '<url><loc>' + SITE_URL + '/</loc><priority>1.0</priority></url>',
    '<url><loc>' + SITE_URL + '/blog</loc><priority>0.9</priority></url>',
  ];
  posts.forEach(function(p){
    urls.push('<url><loc>' + p.url + '</loc><lastmod>' + (p.ts || '').slice(0,10) + '</lastmod><priority>0.7</priority></url>');
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls.join('\n') + '\n</urlset>';
}

function generateRobots() {
  return 'User-agent: *\nAllow: /\nAllow: /blog\nSitemap: ' + SITE_URL + '/sitemap.xml\n\n# AI crawlers — explicitly allowed\nUser-agent: GPTBot\nAllow: /\nUser-agent: ClaudeBot\nAllow: /\nUser-agent: PerplexityBot\nAllow: /\nUser-agent: anthropic-ai\nAllow: /\nUser-agent: Google-Extended\nAllow: /';
}


function updatePost(slug, { title, content, type, subject, tags } = {}) {
  ensureDir();
  const file = path.join(BLOG_DIR, slug + '.json');
  if (!fs.existsSync(file)) return { ok: false, error: 'post not found' };
  let post;
  try { post = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { ok: false, error: 'corrupt post: ' + e.message }; }
  if (typeof title === 'string' && title) post.title = title;
  if (typeof content === 'string' && content) post.content = content;
  if (typeof type === 'string') post.type = type;
  if (typeof subject === 'string') post.subject = subject;
  if (Array.isArray(tags)) post.tags = tags;
  post.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(post, null, 2));
  return { ok: true, ...post };
}

function deletePost(slug) {
  ensureDir();
  const file = path.join(BLOG_DIR, slug + '.json');
  if (!fs.existsSync(file)) return { ok: false, error: 'post not found' };
  fs.unlinkSync(file);
  return { ok: true };
}

module.exports = {
  publishPost, updatePost, deletePost, listPosts, getPost, renderPostPage, renderIndexPage,
  generateSitemap, generateRobots, slugify,
};
