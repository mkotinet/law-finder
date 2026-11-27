FROM node:20-alpine

WORKDIR /app

# 기본 패키지 설치
RUN apk add --no-cache curl tzdata && \
    cp /usr/share/zoneinfo/Asia/Seoul /etc/localtime && \
    echo "Asia/Seoul" > /etc/timezone

COPY package*.json ./
RUN npm install --production --no-audit --no-fund

COPY . .

ENV PORT=80
ENV NODE_ENV=production
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:80/api/health || exit 1

CMD ["node", "server.js"]
