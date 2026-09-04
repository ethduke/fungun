FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS dependencies
RUN apk add --no-cache nodejs=24.18.1-r0 npm
WORKDIR /service
COPY apps/decoder/package.json apps/decoder/package-lock.json ./
RUN npm ci --omit=dev --include=optional --ignore-scripts --no-audit --no-fund

FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
RUN apk add --no-cache nodejs=24.18.1-r0 && addgroup -g 10001 decoder && adduser -D -H -u 10001 -G decoder decoder
ENV NODE_ENV=production
WORKDIR /service
COPY --from=dependencies /service/node_modules ./node_modules
COPY apps/decoder/package.json ./
COPY apps/api/src/launch-image.mjs apps/api/src/launch-image-worker.mjs apps/api/src/errors.mjs apps/api/src/decoder-service.mjs apps/api/src/decoder-server.mjs apps/api/src/decoder-runtime.mjs ./src/
COPY apps/api/src/decoder-diagnostics.mjs ./src/
RUN node --input-type=module -e "import('./src/decoder-runtime.mjs').then(m => m.verifyDecoderExecutable())"
USER decoder
CMD ["node", "src/decoder-server.mjs"]
