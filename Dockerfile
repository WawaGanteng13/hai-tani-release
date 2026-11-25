# Hai Tani backend+frontend — Cloud Run (region default asia-southeast2).
# Build: vite + esbuild -> dist/. Jalan: node dist/server.cjs (NODE_ENV=production).
# DATA_DIR di-mount dari bucket GCS (/mnt/data) saat deploy; lihat cloudbuild.yaml.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-slim AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
# server.cjs dibundle --packages=external -> butuh node_modules prod saat jalan.
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
CMD ["node", "dist/server.cjs"]
