// ============================================================
// shot-director.js — 拍攝指導 (Shot Director)
// 讀文案 / 腳本 → AI 設計拍攝清單 (scene DSL JSON) → 渲染成構圖示意卡
// 入口：app.use('/api/shot-director', require('./shot-director'))
// 也提供 generateShotsFor({copy, mode, count}) 給其他模組直接呼叫
// ============================================================
const express = require('express');
const router = express.Router();

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch {}
const _scout = (() => { try { return require('./scout'); } catch { return null; } })();
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

let client = null;
function getClient() {
  if (client) return client;
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try { client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); } catch { client = null; }
  return client;
}

// ───── 顏色 / palette ─────
const C = {
  CREAM: '#F4E9DB', GOLD: '#B08D57', GOLD_SOFT: '#C9A66B',
  BURG: '#6D2E46', BURG_DK: '#4a1f30',
  ROSE: '#D88AA0', PEACH: '#E8B280', PISTACHIO: '#9CB47A',
  LAVENDER: '#A99BC5', CARAMEL: '#B07A47', BISCUIT: '#D4A574',
  WHITE: '#FFFFFF', SOFT_LINE: '#9E7A55', INK: '#3C2A20', GREY: '#7B6650',
  SKIN: '#E5C2A0', FACE: '#F0CDA3',
};
const PALETTES = {
  classic: [C.ROSE, C.PEACH, C.PISTACHIO, C.LAVENDER, C.BISCUIT, C.BURG],
  rose: [C.ROSE, '#E9A8BC', '#F3CFD9', C.ROSE, '#C46A87', C.ROSE],
  spring: [C.PISTACHIO, C.PEACH, C.ROSE, '#F5DA8C', C.LAVENDER, C.PISTACHIO],
  pastel: ['#F5D7DE', '#F2DDC5', '#E2EAD2', '#DDD2EA', '#F8E8C8', '#F5D7DE'],
  earthy: [C.BISCUIT, C.CARAMEL, C.BURG, '#A0805C', C.PISTACHIO, C.BURG_DK],
  vivid: [C.ROSE, C.PISTACHIO, C.PEACH, C.LAVENDER, C.BURG, C.GOLD],
  pistachio_focus: [C.PISTACHIO, C.PISTACHIO, '#B6C99A', C.PISTACHIO, '#7A9657', C.PISTACHIO],
};
function pal(name) { return PALETTES[name] || PALETTES.classic; }

// ───── 比例 → 框尺寸 ─────
const RATIOS = { '1:1': [200, 200], '4:5': [160, 200], '1.91:1': [240, 126], '9:16': [160, 200] };

// ───── SVG defs (光線箭頭) ─────
const DEFS = '<defs><marker id="light-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L5,3 L0,6 Z" fill="#F5D580"/></marker></defs>';

// ───── 原始繪圖 ─────
function frame(w, h, ratio) {
  let s = `<rect x="0" y="0" width="${w}" height="${h}" fill="${C.CREAM}" stroke="${C.GOLD}" stroke-width="1.2"/>`;
  if (ratio) {
    s += `<rect x="${w-46}" y="6" width="40" height="16" rx="3" fill="${C.BURG}"/>`;
    s += `<text x="${w-26}" y="17" text-anchor="middle" fill="${C.CREAM}" font-size="9" font-family="-apple-system,sans-serif" font-weight="600">${ratio}</text>`;
  }
  return s;
}
function macaron_top(cx, cy, r, color) {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" stroke="${C.SOFT_LINE}" stroke-width="0.6"/>` +
    `<circle cx="${cx-r*0.25}" cy="${cy-r*0.3}" r="${r*0.25}" fill="${C.WHITE}" opacity="0.45"/>`;
}
function macaron_side(cx, cy, w, h, color) {
  const half = w/2;
  return `<path d="M${cx-half},${cy} a${half},${h*0.45} 0 0 1 ${w},0 Z" fill="${color}" stroke="${C.SOFT_LINE}" stroke-width="0.6"/>` +
    `<rect x="${cx-half}" y="${cy}" width="${w}" height="${h*0.18}" fill="${C.CARAMEL}" stroke="${C.SOFT_LINE}" stroke-width="0.4"/>` +
    `<path d="M${cx-half},${cy+h*0.18} a${half},${h*0.45} 0 0 0 ${w},0 Z" fill="${color}" stroke="${C.SOFT_LINE}" stroke-width="0.6"/>`;
}
function financier_top(cx, cy, w, h) {
  let s = `<rect x="${cx-w/2}" y="${cy-h/2}" width="${w}" height="${h}" rx="3" fill="${C.BISCUIT}" stroke="${C.SOFT_LINE}" stroke-width="0.6"/>`;
  for (let i = 1; i < 4; i++) {
    const x = cx - w/2 + (w*i/4);
    s += `<line x1="${x}" y1="${cy-h/2+3}" x2="${x}" y2="${cy+h/2-3}" stroke="${C.SOFT_LINE}" stroke-width="0.5" opacity="0.55"/>`;
  }
  return s;
}
function box_top(cx, cy, w, h, state = 'closed', rows = 2, cols = 3, paletteName = 'classic') {
  const palette = pal(paletteName);
  let s = '';
  if (state === 'closed') {
    s += `<rect x="${cx-w/2}" y="${cy-h/2}" width="${w}" height="${h}" rx="4" fill="${C.BURG}" stroke="${C.BURG_DK}" stroke-width="0.8"/>`;
    s += `<rect x="${cx-w/2}" y="${cy-3}" width="${w}" height="6" fill="${C.GOLD}" stroke="${C.GOLD_SOFT}" stroke-width="0.5"/>`;
    s += `<rect x="${cx-3}" y="${cy-h/2}" width="6" height="${h}" fill="${C.GOLD}" stroke="${C.GOLD_SOFT}" stroke-width="0.5"/>`;
    s += `<ellipse cx="${cx-6}" cy="${cy}" rx="7" ry="4" fill="${C.GOLD}" stroke="${C.GOLD_SOFT}" stroke-width="0.5"/>`;
    s += `<ellipse cx="${cx+6}" cy="${cy}" rx="7" ry="4" fill="${C.GOLD}" stroke="${C.GOLD_SOFT}" stroke-width="0.5"/>`;
  } else if (state === 'half') {
    s += `<rect x="${cx-w/2}" y="${cy-h/2+8}" width="${w}" height="${h-8}" rx="4" fill="${C.CREAM}" stroke="${C.BURG}" stroke-width="1"/>`;
    s += `<rect x="${cx-w/2-4}" y="${cy-h/2-6}" width="${w+8}" height="14" rx="4" fill="${C.BURG}" stroke="${C.BURG_DK}" stroke-width="0.8" transform="rotate(-8 ${cx} ${cy-h/2})"/>`;
    const cw = (w-16)/cols, ch = (h-22)/rows;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cxx = cx - w/2 + 8 + cw*(c+0.5);
      const cyy = cy - h/2 + 14 + ch*(r+0.5);
      s += `<circle cx="${cxx}" cy="${cyy}" r="${Math.min(cw,ch)*0.32}" fill="${palette[(r*cols+c)%palette.length]}" stroke="${C.SOFT_LINE}" stroke-width="0.5"/>`;
    }
  } else { // open
    s += `<rect x="${cx-w/2}" y="${cy-h/2}" width="${w}" height="${h}" rx="4" fill="${C.BURG}" stroke="${C.BURG_DK}" stroke-width="0.8"/>`;
    s += `<rect x="${cx-w/2+4}" y="${cy-h/2+4}" width="${w-8}" height="${h-8}" rx="2" fill="${C.CREAM}" stroke="${C.SOFT_LINE}" stroke-width="0.4"/>`;
    const cw = (w-16)/cols, ch = (h-16)/rows;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cxx = cx - w/2 + 8 + cw*(c+0.5);
      const cyy = cy - h/2 + 8 + ch*(r+0.5);
      s += `<circle cx="${cxx}" cy="${cyy}" r="${Math.min(cw,ch)*0.32}" fill="${palette[(r*cols+c)%palette.length]}" stroke="${C.SOFT_LINE}" stroke-width="0.5"/>`;
    }
  }
  return s;
}
function box_side(cx, cy, w, h) {
  return `<path d="M${cx-w/2},${cy-h/2} L${cx+w/2-8},${cy-h/2-6} L${cx+w/2},${cy+h/2-6} L${cx-w/2+8},${cy+h/2} Z" fill="${C.BURG_DK}" stroke="${C.BURG_DK}" stroke-width="0.6"/>` +
    `<path d="M${cx-w/2},${cy-h/2} L${cx-w/2+8},${cy+h/2} L${cx+w/2},${cy+h/2-6} L${cx+w/2-8},${cy-h/2-6} Z" fill="${C.BURG}" stroke="${C.BURG_DK}" stroke-width="0.6"/>` +
    `<rect x="${cx-w/2+18}" y="${cy-h/2-4}" width="6" height="${h+2}" fill="${C.GOLD}" opacity="0.95" transform="skewY(8)"/>`;
}
function ribbon_bow(cx, cy, w = 22, h = 10) {
  return `<ellipse cx="${cx-w/3}" cy="${cy}" rx="${w/3}" ry="${h/2}" fill="${C.GOLD}" stroke="${C.GOLD_SOFT}" stroke-width="0.5"/>` +
    `<ellipse cx="${cx+w/3}" cy="${cy}" rx="${w/3}" ry="${h/2}" fill="${C.GOLD}" stroke="${C.GOLD_SOFT}" stroke-width="0.5"/>` +
    `<circle cx="${cx}" cy="${cy}" r="3" fill="${C.GOLD_SOFT}"/>`;
}
function hand(x, y, side = 'right', w = 36, h = 16) {
  const color = C.SKIN;
  if (side === 'right') {
    return `<path d="M${x},${y} Q${x-w*0.3},${y-h*0.3} ${x-w*0.7},${y} Q${x-w},${y+h*0.3} ${x-w*0.6},${y+h} Q${x-w*0.2},${y+h*0.8} ${x},${y+h*0.4} Z" fill="${color}" stroke="${C.SOFT_LINE}" stroke-width="0.5"/>`;
  }
  return `<path d="M${x},${y} Q${x+w*0.3},${y-h*0.3} ${x+w*0.7},${y} Q${x+w},${y+h*0.3} ${x+w*0.6},${y+h} Q${x+w*0.2},${y+h*0.8} ${x},${y+h*0.4} Z" fill="${color}" stroke="${C.SOFT_LINE}" stroke-width="0.5"/>`;
}
function light_arrow(x1, y1, x2, y2) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#F5D580" stroke-width="1.4" stroke-dasharray="2.5,2" marker-end="url(#light-arrow)"/>` +
    `<circle cx="${x1}" cy="${y1}" r="3" fill="#F5D580" opacity="0.55"/>`;
}
function camera_label(x, y, label = '俯拍') {
  return `<rect x="${x-9}" y="${y-6}" width="18" height="12" rx="2" fill="${C.BURG}" stroke="${C.GOLD}" stroke-width="0.6"/>` +
    `<circle cx="${x}" cy="${y}" r="3.2" fill="none" stroke="${C.GOLD}" stroke-width="0.8"/>` +
    `<text x="${x+14}" y="${y+3}" fill="${C.CREAM}" font-size="8" font-family="-apple-system,sans-serif">${label}</text>`;
}
function coffee_cup(cx, cy, w = 22, h = 18) {
  return `<ellipse cx="${cx}" cy="${cy-h/2}" rx="${w/2}" ry="${w/6}" fill="${C.INK}" stroke="${C.SOFT_LINE}" stroke-width="0.4"/>` +
    `<path d="M${cx-w/2},${cy-h/2} L${cx-w/2+2},${cy+h/2-2} Q${cx},${cy+h/2+1} ${cx+w/2-2},${cy+h/2-2} L${cx+w/2},${cy-h/2}" fill="${C.WHITE}" stroke="${C.SOFT_LINE}" stroke-width="0.6"/>` +
    `<path d="M${cx+w/2-1},${cy-2} q6,0 4,8 q-2,3 -6,1" fill="none" stroke="${C.SOFT_LINE}" stroke-width="0.8"/>`;
}
function petal(x, y, color = C.ROSE) {
  return `<ellipse cx="${x}" cy="${y}" rx="3.5" ry="2" fill="${color}" opacity="0.7"/>`;
}
function petals(positions = [], color = C.ROSE) {
  return positions.map(([x, y]) => petal(x, y, color)).join('');
}
function card(cx, cy, w = 80, h = 50, angle = -6) {
  let s = `<g transform="rotate(${angle} ${cx} ${cy})">`;
  s += `<rect x="${cx-w/2}" y="${cy-h/2}" width="${w}" height="${h}" rx="2" fill="${C.WHITE}" stroke="${C.SOFT_LINE}" stroke-width="0.4"/>`;
  for (let i = 0; i < 3; i++) s += `<line x1="${cx-w/2+8}" y1="${cy-h/2+12+i*10}" x2="${cx+w/2-8}" y2="${cy-h/2+12+i*10}" stroke="${C.INK}" stroke-width="0.6" opacity="0.45"/>`;
  s += '</g>';
  return s;
}
function person_head(cx, cy, r = 22) {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${C.FACE}" stroke="${C.SOFT_LINE}" stroke-width="0.5"/>` +
    `<path d="M${cx-5},${cy+2} q5,5 10,0" fill="none" stroke="${C.INK}" stroke-width="1"/>` +
    `<circle cx="${cx-6}" cy="${cy-4}" r="1.5" fill="${C.INK}"/>` +
    `<circle cx="${cx+6}" cy="${cy-4}" r="1.5" fill="${C.INK}"/>`;
}
function brand_strip(cx, cy, w = 160, h = 22, label = '溫點 WarmPlace') {
  return `<rect x="${cx-w/2}" y="${cy-h/2}" width="${w}" height="${h}" fill="${C.BURG}" stroke="${C.GOLD}" stroke-width="0.5"/>` +
    `<text x="${cx}" y="${cy+4}" text-anchor="middle" fill="${C.CREAM}" font-size="9" font-family="-apple-system,sans-serif" font-weight="600">${label}</text>`;
}
function backdrop(x, y, w, h, color = '#3C2A20') {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}"/>`;
}
function text(cx, cy, label, size = 10, color = C.BURG, weight = 600) {
  return `<text x="${cx}" y="${cy}" text-anchor="middle" fill="${color}" font-size="${size}" font-family="-apple-system,sans-serif" font-weight="${weight}">${label}</text>`;
}
function steam(cx, cy, height = 18) {
  return `<path d="M${cx},${cy} q3,-${height*0.45} 0,-${height}" fill="none" stroke="${C.CREAM}" stroke-width="1.2" opacity="0.6"/>`;
}

const PRIMS = {
  macaron_top: (a) => macaron_top(a.cx, a.cy, a.r || 30, a.color || C.ROSE),
  macaron_side: (a) => macaron_side(a.cx, a.cy, a.w || 26, a.h || 26, a.color || C.ROSE),
  financier_top: (a) => financier_top(a.cx, a.cy, a.w || 36, a.h || 24),
  box_top: (a) => box_top(a.cx, a.cy, a.w || 110, a.h || 130, a.state || 'closed', a.rows || 2, a.cols || 3, a.palette || 'classic'),
  box_side: (a) => box_side(a.cx, a.cy, a.w || 90, a.h || 55),
  ribbon_bow: (a) => ribbon_bow(a.cx, a.cy, a.w || 22, a.h || 10),
  hand: (a) => hand(a.x, a.y, a.side || 'right', a.w || 36, a.h || 16),
  light_arrow: (a) => light_arrow(a.x1, a.y1, a.x2, a.y2),
  camera_label: (a) => camera_label(a.x, a.y, a.label || '俯拍'),
  coffee_cup: (a) => coffee_cup(a.cx, a.cy),
  petals: (a) => petals(a.positions || [], a.color || C.ROSE),
  card: (a) => card(a.cx, a.cy, a.w || 80, a.h || 50, a.angle || -6),
  person_head: (a) => person_head(a.cx, a.cy, a.r || 22),
  brand_strip: (a) => brand_strip(a.cx, a.cy, a.w || 160, a.h || 22, a.label || '溫點 WarmPlace'),
  backdrop: (a) => backdrop(a.x, a.y, a.w, a.h, a.color || '#3C2A20'),
  text: (a) => text(a.cx, a.cy, a.label, a.size || 10, a.color || C.BURG, a.weight || 600),
  steam: (a) => steam(a.cx, a.cy, a.height || 18),
};

function renderScene(elements = []) {
  return elements.map(e => {
    const fn = PRIMS[e.type];
    if (!fn) return '';
    try { return fn(e); } catch { return ''; }
  }).join('');
}

function esc(s) { return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderProductCard(shot, i) {
  const ratio = RATIOS[shot.ratio] ? shot.ratio : '1:1';
  const [fw, fh] = RATIOS[ratio];
  const inc = (shot.include || []).map(x => `<li>${esc(x)}</li>`).join('');
  const exc = (shot.exclude || []).map(x => `<li>${esc(x)}</li>`).join('');
  const svg = `<svg viewBox="0 0 ${fw} ${fh}" xmlns="http://www.w3.org/2000/svg">${DEFS}${frame(fw, fh, ratio)}${renderScene(shot.elements)}</svg>`;
  return `<div class="sd-card">
<div class="sd-head"><span class="sd-badge">${ratio}</span><h4>${i+1}. ${esc(shot.name || '拍攝示意')}</h4></div>
<div class="sd-frame">${svg}</div>
<div class="sd-specs">
<div class="sd-row"><span class="sd-k">鏡位</span><span class="sd-v">${esc(shot.angle || '俯拍')}</span></div>
<div class="sd-row"><span class="sd-k">光線</span><span class="sd-v">${esc(shot.light || '左上自然光')}</span></div>
${inc ? `<div class="sd-row"><span class="sd-k">該入鏡</span><ul class="sd-bul good">${inc}</ul></div>` : ''}
${exc ? `<div class="sd-row"><span class="sd-k">不該</span><ul class="sd-bul bad">${exc}</ul></div>` : ''}
${shot.tips ? `<div class="sd-row tips"><span class="sd-k">技術</span><span class="sd-v">${esc(shot.tips)}</span></div>` : ''}
</div></div>`;
}

function renderReelsCard(shot, i) {
  const [fw, fh] = RATIOS['9:16'];
  const svg = `<svg viewBox="0 0 ${fw} ${fh}" xmlns="http://www.w3.org/2000/svg">${DEFS}${frame(fw, fh, '9:16')}${renderScene(shot.elements)}</svg>`;
  return `<div class="sd-card sd-r">
<div class="sd-head"><span class="sd-badge sec">${esc(shot.sec || ((i*3)+'-'+((i+1)*3)+' 秒'))}</span><h4>${esc(shot.name || ('鏡頭 ' + (i+1)))}</h4></div>
<div class="sd-frame">${svg}</div>
<div class="sd-specs">
<div class="sd-row"><span class="sd-k">鏡位</span><span class="sd-v">${esc(shot.angle || '俯拍 / 9:16')}</span></div>
${shot.copy ? `<div class="sd-row"><span class="sd-k">字卡</span><span class="sd-v quote">「${esc(shot.copy)}」</span></div>` : ''}
${shot.tips ? `<div class="sd-row tips"><span class="sd-k">拍攝</span><span class="sd-v">${esc(shot.tips)}</span></div>` : ''}
</div></div>`;
}

const CARD_CSS = `<style>
.sd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin-top:10px;}
.sd-card{background:#2a1a1d;border:1px solid rgba(176,141,87,.3);border-radius:8px;padding:10px;}
.sd-head{display:flex;align-items:center;gap:6px;margin-bottom:8px;}
.sd-head h4{font-size:13px;margin:0;color:#FCF6F5;font-weight:600;flex:1;}
.sd-badge{background:#6D2E46;color:#FCF6F5;border:1px solid #B08D57;padding:2px 7px;border-radius:9px;font-size:10px;font-weight:600;}
.sd-badge.sec{background:#B08D57;color:#4a1f30;}
.sd-frame{background:#1a1010;border-radius:5px;padding:6px;display:flex;justify-content:center;margin-bottom:8px;}
.sd-frame svg{width:100%;max-width:200px;height:auto;}
.sd-r .sd-frame svg{max-width:120px;}
.sd-specs{font-size:11px;line-height:1.5;}
.sd-row{display:flex;gap:6px;padding:3px 0;border-bottom:1px dashed rgba(176,141,87,.15);}
.sd-row:last-child{border-bottom:none;}
.sd-row .sd-k{flex:0 0 38px;color:#B08D57;font-weight:600;font-size:10px;padding-top:1px;}
.sd-row .sd-v{flex:1;color:rgba(252,246,245,.85);}
.sd-row .sd-v.quote{font-style:italic;color:rgba(252,246,245,.95);}
.sd-bul{margin:0;padding-left:0;list-style:none;flex:1;}
.sd-bul li{position:relative;padding-left:12px;color:rgba(252,246,245,.85);font-size:10.5px;}
.sd-bul.good li::before{content:"\\2713";color:#3fb27f;position:absolute;left:0;font-weight:700;}
.sd-bul.bad li::before{content:"\\d7";color:#e76b6b;position:absolute;left:0;font-weight:700;}
.sd-tips .sd-v{color:rgba(252,246,245,.7);}
.sd-empty{color:rgba(252,246,245,.5);font-size:12px;padding:8px;}
</style>`;

// ───── SCOUT tail ─────
function scoutTail() {
  try {
    const i = _scout && _scout.getMarketIntelligence && _scout.getMarketIntelligence();
    if (!i) return '';
    const wf = typeof i.weekly_focus === 'string' ? i.weekly_focus : JSON.stringify(i.weekly_focus || '');
    return '\n\n[本週 SCOUT 重點] ' + String(wf).slice(0, 200);
  } catch { return ''; }
}

// ───── AI prompt ─────
const DIRECTOR_PROMPT = `你是 溫點 WarmPlace 的 AI 拍攝指導 (Shot Director)。
品牌：精品馬卡龍 + 費南雪韓系禮贈，主力 6 入 NT$880 / 12 入 NT$1,580。風格：韓系精品、溫柔得體、片刻儀式感、給選擇不壓迫。

你的任務：讀使用者給你的文案或腳本，設計拍攝清單。每一個鏡頭都要對應到文案的某個重點/情緒/場景。**畫面內容、角度、光線必須跟文案的氣口走** — 母親節用柔順光＋玫瑰調，企業送禮用平拍＋深色背景，開箱 Reels 用半開蓋＋手入鏡。

**只能用下列元素類型**組成畫面（其他都不行）：
- macaron_top {cx, cy, r, color}          // 馬卡龍俯視 (color 用十六進制色碼)
- macaron_side {cx, cy, w, h, color}      // 馬卡龍側面
- financier_top {cx, cy, w, h}            // 費南雪俯視（金黃）
- box_top {cx, cy, w, h, state, rows, cols, palette}  // state: closed/half/open  palette: classic/rose/spring/pastel/earthy/vivid/pistachio_focus
- box_side {cx, cy, w, h}                 // 禮盒側面
- ribbon_bow {cx, cy, w, h}               // 緞帶蝴蝶結
- hand {x, y, side, w, h}                 // 手 (side: left/right)
- light_arrow {x1, y1, x2, y2}            // 光線方向箭頭（從 1 點射向 2 點）
- camera_label {x, y, label}              // 相機圖示+角度標籤 (label: 俯拍/側拍/特寫/平拍 等)
- coffee_cup {cx, cy}                     // 咖啡杯
- petals {positions: [[x,y],...], color}  // 花瓣（多個位置）
- card {cx, cy, w, h, angle}              // 手寫卡片
- person_head {cx, cy, r}                 // 人像頭部（收禮人/媽媽 等）
- brand_strip {cx, cy, w, h, label}       // 品牌橫條
- backdrop {x, y, w, h, color}            // 背景塊
- text {cx, cy, label, size, color}       // 框內文字
- steam {cx, cy, height}                  // 蒸氣（剛出爐感）

**畫面座標範圍**（依比例不同）：
- 1:1 (200×200) — 商品照、特寫
- 4:5 (160×200) — IG 直式、送禮情境
- 1.91:1 (240×126) — FB 橫式、櫃位、檔期主視覺
- 9:16 (160×200) — Reels 分鏡 (跟 4:5 一樣畫，後製是直式)

**鐵則**：
1. 每張卡裡必有 1 個 light_arrow + 1 個 camera_label，告訴使用者光從哪打、相機在哪。
2. 角度 angle 用：正俯拍 90° / 側拍 30° / 略斜俯 70° / 特寫 / 平拍 / 微仰 5° 等具體描述。
3. include / exclude 各 2-3 條，要具體可執行。
4. tips 寫手機可重現的技術參數（對焦點、距離、白平衡、人像模式等）。
5. 文案如果情緒是「儀式感」就用半開蓋+手入鏡；如果是「量感」就堆疊或排陣；如果是「送禮對象」就帶人像/手寫卡。
6. **只輸出純 JSON**（一個物件就好，第一個字元是左大括號，最後一個字元是右大括號。絕對不要用 markdown 三個反引號包裝、不要任何說明文字、不要 markdown）。schema：
   {"shots": [{"name":"...", "ratio":"1:1|4:5|1.91:1|9:16", "angle":"...", "light":"...", "elements":[...], "include":["..."], "exclude":["..."], "tips":"...", "sec":"0–3 秒（reels模式才有）", "copy":"字卡文字（reels模式才有）"}]}`;

async function callDirector({ copy, mode = 'social', count = 3 }) {
  const c = getClient();
  if (!c) throw new Error('ANTHROPIC_API_KEY 未設');
  const isReels = mode === 'reels';
  const want = isReels ? '請設計 5 個鏡頭組成一支約 18 秒的 Reels 分鏡（直式 9:16）。每鏡有 sec 秒數段、copy 字卡。'
    : '請設計 ' + Math.max(1, Math.min(count, 5)) + ' 個拍攝建議卡（可混合 1:1 / 4:5 / 1.91:1，依文案主題選比例）。';
  const user = (isReels ? '【Reels 腳本】\n' : '【社群文案】\n') + (copy || '').slice(0, 2000)
    + '\n\n' + want + scoutTail() + '\n\n直接輸出 JSON，不要其他文字。';

  const r = await c.messages.create({
    model: MODEL,
    max_tokens: 3500,
    system: DIRECTOR_PROMPT,
    messages: [{ role: 'user', content: user }],
  });
  const raw = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  // 嘗試從輸出抓 JSON (處理 markdown code fence / 前後雜訊)
  let json = null;
  let cleaned = raw.trim();
  // 1. 剝 markdown code fence
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // 2. 直接 parse
  try { json = JSON.parse(cleaned); } catch {}
  // 3. 抓最外層 {...}
  if (!json) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { json = JSON.parse(cleaned.slice(start, end + 1)); } catch {}
    }
  }
  // 4. 全文 regex 抓 JSON 片段
  if (!json) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { json = JSON.parse(m[0]); } catch {} }
  }
  if (!json || !Array.isArray(json.shots)) {
    console.error('[shot-director] raw response preview:', raw.slice(0, 300));
    throw new Error('DIRECTOR 輸出非預期 JSON');
  }
  return json;
}

async function generateShotsFor({ copy, mode = 'social', count = 3 } = {}) {
  if (!copy || !copy.trim()) throw new Error('copy 必填');
  const out = await callDirector({ copy, mode, count });
  const cards = (out.shots || []).map((s, i) => isReelsShot(s, mode) ? renderReelsCard(s, i) : renderProductCard(s, i)).join('\n');
  return { ok: true, shots: out.shots, html: '<div class="sd-grid">' + cards + '</div>', css: CARD_CSS };
}
function isReelsShot(s, mode) { return mode === 'reels' || s.ratio === '9:16' || s.sec || s.copy; }

// ───── routes ─────
router.post('/from-copy', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const { copy, mode = 'social', count = 3 } = req.body || {};
    const out = await generateShotsFor({ copy, mode, count });
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/css', (req, res) => { res.type('text/css').send(CARD_CSS.replace(/^<style>|<\/style>$/g, '')); });

router.get('/ping', (req, res) => res.json({ ok: true, model: MODEL, has_key: !!process.env.ANTHROPIC_API_KEY }));

module.exports = router;
module.exports.generateShotsFor = generateShotsFor;
module.exports.CARD_CSS = CARD_CSS;
