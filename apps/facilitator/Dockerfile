FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
ENV NODE_ENV=production
WORKDIR /service
COPY apps/facilitator/package.json apps/facilitator/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY apps/facilitator/src ./src
USER node
EXPOSE 8788
CMD ["node", "src/index.mjs"]
