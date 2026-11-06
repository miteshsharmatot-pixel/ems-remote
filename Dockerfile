FROM node:20-bookworm-slim

# HOST=0.0.0.0: reachable by the platform's proxy. CHROMIUM_LOW_MEM: no-sandbox + small /dev/shm flags for containers.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    CHROMIUM_LOW_MEM=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY package.json package-lock.json ./
# skip the postinstall; install Chromium plus the system libraries it needs explicitly
RUN npm ci --omit=dev --ignore-scripts \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

COPY . .

# Render sets PORT (10000) and RENDER_EXTERNAL_URL; the app reads both.
CMD ["node", "server.js"]
