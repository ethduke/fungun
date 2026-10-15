FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /service
COPY apps/web/package.json apps/web/package-lock.json ./
COPY apps/web/vendor ./vendor
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY apps/web/app ./app
COPY apps/web/components ./components
COPY apps/web/lib ./lib
COPY apps/web/public ./public
COPY apps/web/scripts ./scripts
COPY apps/web/tsconfig.json apps/web/vite.config.ts apps/web/next.config.ts ./
RUN npm run build:fly

FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /service
COPY --from=build --chown=node:node /service/dist/standalone ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
