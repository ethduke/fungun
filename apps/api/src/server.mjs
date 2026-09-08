import { Launches } from "./launches.mjs";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readConfig } from "./config.mjs";
import { Budget } from "./budget.mjs";
import { Upstream } from "./upstream.mjs";
import { Adapters } from "./adapters.mjs";
import { createCatalogRefresher } from "./catalog-refresher.mjs";
import { createHandler } from "./service.mjs";
import { verifyProductionStorage } from "./storage.mjs";
import { Fees } from "./fees.mjs";
import { createFomoRelayHandler } from "./fomo-relay.mjs";
import { createFomoService } from "./fomo-service.mjs";
import { TrackedPrices } from "./tracked-prices.mjs";
import { TokenImages } from "./token-image.mjs";

process.umask(0o077);
try {
  const config = readConfig();
  if (!config.production) mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
  if (config.production) verifyProductionStorage(config.databasePath);
  const budget = new Budget(config.databasePath, Date.now, !config.production);
  const upstream = new Upstream(budget);
  const adapters = new Adapters(config, upstream, Date.now, budget);
  const catalogRefresher = createCatalogRefresher(adapters, {
    enabled: true,
  });
  const fees = new Fees(config, upstream);
  const launches = new Launches(config, upstream, budget);
  const fomo = createFomoService(budget.db);
  const trackedPrices = new TrackedPrices(config, upstream);
  const tokenImages = new TokenImages(config, upstream);
  const server = createServer(
    { maxHeaderSize: 8192 },
    createFomoRelayHandler(fomo, process.env.FOMO_RELAY_TOKEN,
      createHandler(config, budget, adapters, fees, trackedPrices, launches, fomo, tokenImages)),
  );
  server.requestTimeout = 10_000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 30;
  server.maxConnections = 64;
  server.on("error", () => {
    console.error("Read service unavailable.");
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(
      `Read service listening on port ${config.port}; upstream reads ${config.readsEnabled ? "enabled" : "disabled"}.`,
    );
    catalogRefresher.kick();
    fomo.start();
  });
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      const stopped = Promise.all([catalogRefresher.stop(), fomo.stop()]);
      server.close(async () => {
        await stopped;
        budget.close();
        process.exit(0);
      });
      server.closeIdleConnections();
      setTimeout(() => process.exit(1), 26_000).unref();
    });
} catch {
  console.error("Read service configuration or storage unavailable.");
  process.exitCode = 1;
}
