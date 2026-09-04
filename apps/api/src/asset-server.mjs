import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { AssetStore } from "./asset-store.mjs";
import { AssetDecoder } from "./asset-decoder.mjs";
import { createAssetHandler } from "./asset-service.mjs";
import { createImageHandler, readImageConfig } from "./image-service.mjs";
import { ImageJobStore, imageJobsPath } from "./image-job-store.mjs";
import { createImageWorker } from "./image-generation.mjs";
import { createGrokImageProvider } from "./grok-image-provider.mjs";
import { createImagePayments } from "./x402-payments.mjs";
import { createImageSettlementReader } from "./image-settlement-reader.mjs";

try {
  const production = process.env.NODE_ENV === "production";
  if (
    production &&
    (!process.env.ASSETS_MACHINE_ID || process.env.ASSETS_MACHINE_ID !== process.env.FLY_MACHINE_ID)
  )
    throw new Error();
  const uploadsEnabled = process.env.ASSET_UPLOADS === "true";
  const config = {
    root: process.env.ASSET_STORE_ROOT,
    publicOrigin: process.env.ASSET_PUBLIC_ORIGIN,
    appOrigin: process.env.APP_ORIGIN,
    production,
    uploadsEnabled,
  };
  const store = new AssetStore(config);
  const imageConfig = readImageConfig();
  const processor =
    uploadsEnabled || imageConfig.enabled
      ? new AssetDecoder(process.env.ASSET_DECODER_ORIGIN)
      : null;
  const imagePath = imageJobsPath(config.root, production);
  const images = imageConfig.enabled || existsSync(imagePath) ? new ImageJobStore(imagePath) : null;
  const payments = imageConfig.enabled
    ? createImagePayments({
        asset: imageConfig.asset,
        facilitatorUrl: process.env.X402_FACILITATOR_URL,
        bearerToken: process.env.X402_FACILITATOR_TOKEN,
      })
    : null;
  const settlementReader = imageConfig.enabled
    ? createImageSettlementReader({ asset: imageConfig.asset, rpcUrl: process.env.ROBINHOOD_RPC })
    : null;
  const worker = imageConfig.enabled
    ? createImageWorker(
        images,
        createGrokImageProvider({ apiKey: process.env.OPENROUTER_API_KEY }),
        processor,
        payments,
        settlementReader,
      )
    : null;
  const imageHandler = createImageHandler(imageConfig, images, worker, payments, settlementReader);
  const assetHandler = createAssetHandler(config, store, processor);
  const server = createServer({ maxHeaderSize: 16384 }, async (request, response) => {
    if (!request.url?.startsWith("/v1/images/")) return assetHandler(request, response);
    const deadline = setTimeout(() => {
      request.destroy();
      response.destroy();
    }, 40000);
    try {
      store.budget.request(request.socket.remoteAddress);
      if (request.method === "POST" && !request.headers["payment-signature"])
        store.budget.debit([["image-quotes", 60, 3600000]]);
      const input = new Request(`${config.appOrigin}${request.url}`, {
        method: request.method,
        headers: request.headers,
        ...(["GET", "HEAD"].includes(request.method)
          ? {}
          : { body: Readable.toWeb(request), duplex: "half" }),
      });
      const result = await imageHandler(input);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      if (!response.destroyed) {
        response.writeHead(503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end('{"error":"image_service_unavailable"}');
      }
    } finally {
      clearTimeout(deadline);
    }
  });
  server.maxConnections = 32;
  server.requestTimeout = 40000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 2000;
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("error", () => {
    store.close();
    console.error("Asset service could not listen.");
    process.exitCode = 1;
  });
  server.listen(8790, production ? "::" : "127.0.0.1", () => console.log("Asset service ready."));
  worker?.kick();
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () =>
      server.close(async () => {
        await worker?.stop();
        images?.close();
        store.close();
        process.exit(0);
      }),
    );
} catch {
  console.error(
    "Asset service refused to start. Verify its dedicated volume, schema migrations, origins and Machine identity.",
  );
  process.exitCode = 1;
}
