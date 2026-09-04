import { createServer } from "node:http";
import { AssetStore } from "./asset-store.mjs";
import { AssetDecoder } from "./asset-decoder.mjs";
import { createAssetHandler } from "./asset-service.mjs";

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
  const processor = uploadsEnabled ? new AssetDecoder(process.env.ASSET_DECODER_ORIGIN) : null;
  const server = createServer(
    { maxHeaderSize: 8192 },
    createAssetHandler(config, store, processor),
  );
  server.maxConnections = 32;
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 2000;
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("error", () => {
    store.close();
    console.error("Asset service could not listen.");
    process.exitCode = 1;
  });
  server.listen(8790, production ? "::" : "127.0.0.1", () => console.log("Asset service ready."));
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () =>
      server.close(() => {
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
