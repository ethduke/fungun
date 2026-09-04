FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
ENV NODE_ENV=production
WORKDIR /service
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY apps/api/src ./src
USER node
EXPOSE 8787
CMD ["node", "src/server.mjs"]
