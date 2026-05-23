// image-gen.js — OpenAI 圖片生成 + 存檔 + 提供公開 URL
//
// 環境變數:
//   OPENAI_API_KEY        — 必填
//   OPENAI_IMAGE_MODEL    — 預設 gpt-image-1 (也可填 dall-e-3)
//   IMAGE_SIZE            — 預設 1024x1024 (IG 方形); 也可 1536x1024 (FB 橫向) 或 1024x1536 (IG Story)
//   IMAGE_QUALITY         — 預設 high (low / medium / high / auto)
//   SITE_URL              — 預設讀 process.env.SITE_URL,沒設則 https://macaron-office.onrender.com
//   RENDER_DISK_MOUNT_PATH — 預設 ./data

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname, 'data');
const IMG_DIR = path.join(DATA_DIR, 'auto-images');

function ensureDir() {
  try { fs.mkdirSync(IMG_DIR, { recursive: true }); } catch {}
}

function getSiteUrl() {
  return process.env.SITE_URL || 'https://macaron-office.onrender.com';
}

function publicUrlForFile(filename) {
  return getSiteUrl().replace(/\/$/, '') + '/uploads/auto-images/' + filename;
}

// MACARON DE LUXE 視覺風格基底 (ARIA 風)
const STYLE_BASE = '法式精品攝影風格 / 馬卡龍與費南雪雙主力特寫,自然採光,玫瑰金 + 深酒紅 + 象牙白色調,景深淺,構圖留白,雜誌等級質感,廣告攝影風格,1:1 方形';
const STYLE_NEGATIVE = '不要 卡通/插畫/低品質/水印/文字/亂塗鴉/雜亂背景';

// 從 IG/FB 文案 + brief 產出 ARIA 級的圖片 prompt
function buildImagePrompt({ caption, brief, platform }) {
  const base = (caption || brief || '法式精品馬卡龍與費南雪混合禮盒,搭配玫瑰花瓣與絲帶').slice(0, 300);
  const sizeHint = platform === 'IG' ? '1:1 方形' : '4:5 直式';
  return base + '\n\n畫面風格: ' + STYLE_BASE + ' ' + sizeHint + '。' + STYLE_NEGATIVE;
}

// 呼叫 OpenAI Image API
async function callOpenAI({ prompt, size, model, quality }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY 未設定');
  const m = model || process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
  const sz = size || process.env.IMAGE_SIZE || '1024x1024';
  const q = quality || process.env.IMAGE_QUALITY || 'high';

  // gpt-image-1 vs dall-e-3 參數略不同
  const body = (m === 'dall-e-3')
    ? { model: m, prompt, size: sz, quality: q === 'high' ? 'hd' : 'standard', n: 1, response_format: 'b64_json' }
    : { model: m, prompt, size: sz, quality: q, n: 1 };

  const resp = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify(body),
  });
  const j = await resp.json();
  if (!resp.ok) throw new Error('OpenAI: ' + (j.error?.message || resp.status));
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI 沒回傳 b64_json');
  return b64;
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

// 主函式:產生一張圖並存檔,回傳 publicUrl 供 IG/FB 使用
async function generateImage({ caption, brief, platform, slug }) {
  ensureDir();
  const prompt = buildImagePrompt({ caption, brief, platform });
  const b64 = await callOpenAI({ prompt });
  const buf = Buffer.from(b64, 'base64');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeSlug = slug ? slugify(slug) : (platform || 'auto');
  const filename = `${ts}-${safeSlug}.png`;
  const localPath = path.join(IMG_DIR, filename);
  fs.writeFileSync(localPath, buf);
  return {
    filename,
    localPath,
    publicUrl: publicUrlForFile(filename),
    prompt,
    size_bytes: buf.length,
  };
}

// 列出最近 N 張生成的圖
function listRecent(n = 20) {
  ensureDir();
  try {
    const files = fs.readdirSync(IMG_DIR)
      .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(IMG_DIR, f));
        return { filename: f, url: publicUrlForFile(f), mtime: stat.mtime, size: stat.size };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, n);
    return files;
  } catch {
    return [];
  }
}

module.exports = { generateImage, listRecent, IMG_DIR, buildImagePrompt };
