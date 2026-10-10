FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    libx11-xcb1 libxcb-dri3-0 libdrm2 libgbm1 \
    libasound2 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libgtk-3-0 libnss3 libxcomposite1 libxdamage1 \
    libxrandr2 libxss1 libxtst6 libpango-1.0-0 \
    libcairo2 libgdk-pixbuf-2.0-0 libdbus-1-3 \
    git ca-certificates xauth \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The driver prepares a root-owned application too, but every VS Code process
# and extension test runs as the unprivileged node user (UID 1000).
CMD ["node", "scripts/debian/verify.mjs"]
