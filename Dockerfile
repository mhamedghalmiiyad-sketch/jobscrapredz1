FROM node:20-bookworm

# Chromium + libs
RUN apt-get update && apt-get install -y \
  chromium \
  ca-certificates \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  xdg-utils \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

ENV NODE_ENV=production
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

CMD ["node", "server.mjs"]
