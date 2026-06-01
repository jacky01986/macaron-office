# 溫點 WarmPlace · Virtual Office — Docker image
FROM node:20-alpine

WORKDIR /app

# 安裝 wget 用於下載 CJK 字型（PDF 中文支援用）
RUN apk add --no-cache wget ca-certificates

# 只複製 package.json 先安裝（善用 Docker cache）
COPY package.json ./
RUN npm install --omit=dev

# 下載 NotoSansTC 字型供 PDF 中文使用 (~5MB)
RUN mkdir -p /app/fonts && \
    wget -q -O /app/fonts/NotoSansTC-Regular.ttf \
      "https://github.com/googlefonts/noto-cjk/raw/main/Sans/TTF/TraditionalChinese/NotoSansCJKtc-Regular.ttf" \
    || echo "字型下載失敗，PDF 中文會用替代字"

# 複製其餘原始碼
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
