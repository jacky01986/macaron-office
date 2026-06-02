# 溫點 WarmPlace · Virtual Office — Docker image
FROM node:20-alpine

WORKDIR /app

# 只複製 package.json 先安裝（善用 Docker cache）
COPY package.json ./
RUN npm install --omit=dev

# 從 npm package 複製 NotoSansTC TTF 字型到 /app/fonts/ (PDF 中文支援)
RUN mkdir -p /app/fonts && \
    cp /app/node_modules/@expo-google-fonts/noto-sans-tc/400Regular/NotoSansTC_400Regular.ttf \
       /app/fonts/NotoSansTC-Regular.ttf && \
    ls -la /app/fonts/

# 複製其餘原始碼
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
