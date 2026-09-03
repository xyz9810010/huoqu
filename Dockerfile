FROM node:24-bookworm-slim AS native-base
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM native-base AS server-deps
COPY package*.json ./
RUN npm ci

FROM server-deps AS test
COPY server.js db.js auth.js ./
COPY server ./server
COPY tests ./tests
COPY scripts ./scripts
COPY web/src/api-contract.ts ./web/src/api-contract.ts
COPY web/src/services ./web/src/services
COPY web/src/types ./web/src/types
COPY web/public ./web/public
ENV NODE_ENV=test DISABLE_PUSH=1
CMD ["npm", "test"]

FROM node:24-bookworm-slim AS web-build
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
COPY tsconfig.base.json /src/tsconfig.base.json
COPY web/ ./
RUN npm run build

FROM native-base AS runtime
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js db.js auth.js ./
COPY server ./server
COPY scripts/backup-data.js ./scripts/backup-data.js
COPY scripts/generate-push-key.js ./scripts/generate-push-key.js
COPY --from=web-build /src/web/dist ./web/dist
RUN mkdir -p /app/data /app/backups
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
