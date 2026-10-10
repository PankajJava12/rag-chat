FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig*.json ./
RUN npm ci
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /data/documents && chown -R node:node /data
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/packages/database/migrations ./packages/database/migrations
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000 3001
CMD ["node", "dist/apps/api/src/server.js"]

FROM nginxinc/nginx-unprivileged:stable-alpine AS web
ENV API_UPSTREAM=api:3000
COPY docker/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
