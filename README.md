# 🥐 MACARON DE LUXE · 虛擬辦公室

台灣精品馬卡龍禮贈品牌的 AI 行銷團隊。9 位 AI 員工（VICTOR 行銷總監 + 8 位專員）全部接真實 Claude API。

## 9 位 AI 員工

| 員工 | 角色 |
|---|---|
| 👑 VICTOR | AI 行銷總監（拆解任務 · 分派專員 · 統整成果） |
| 🎯 LEON | AI 廣告投手（Meta / Google Ads 投放與優化） |
| ✒️ CAMILLE | AI 文案企劃（IG / FB / EDM / 廣告文案） |
| 🎨 ARIA | AI 視覺指導（Midjourney 提示詞） |
| 📊 DEX | AI 數據分析師（成效報表 · 競品追蹤） |
| 💫 NOVA | AI 社群經營（IG / FB / LINE 內容企劃） |
| 📰 SOFIA | AI 公關媒體（媒體發稿 · 品牌故事） |
| 🤝 MILO | AI KOL 合作（網紅選角 · 業配腳本） |
| 📝 EMI | AI 內容 / SEO（部落格 · 長文 · 關鍵字） |

## 本機開發

```bash
npm install
cp .env.example .env   # 填 ANTHROPIC_API_KEY
npm start              # http://localhost:3000
```

## 部署到 Render

- Root Directory：留空（repo 已扁平化）
- Build Command：`npm install`
- Start Command：`node server.js`
- 環境變數：`ANTHROPIC_API_KEY` 必填,其他依需求加（Meta / LINE / Google Ads token）

## 自動排程

- 每週一 09:00（台北）VICTOR 自動產出《本週策略簡報》
- 每週五 17:00 DEX 自動產出《週成效報告》
