FROM node:22.22.0-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/game/package.json packages/game/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci
COPY packages packages

FROM base AS web-build
ARG VITE_SERVER_URL
ENV VITE_SERVER_URL=$VITE_SERVER_URL
COPY scripts/hash-dist.ts scripts/dist-hash.ts scripts/
RUN npm run build -w @playpot/web && node scripts/hash-dist.ts packages/web/dist

FROM base AS referee
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "packages/server/src/main.ts"]

FROM caddy:2 AS web
COPY --from=web-build /app/packages/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
