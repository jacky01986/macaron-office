# MACARON DE LUXE · Virtual Office — Zeabur / Docker image
FROM node:20-alpine

WORKDIR /app

# 只複製 package.json 先安裝（善用 Docker cache）
COPY package.json ./
RUN npm install --omit=dev

# 複製其餘原始碼
COPY . .

# Zeabur 預設會注入 PORT 環境變數
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
