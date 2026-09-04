import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readConfig } from "./config.mjs";
import { Budget } from "./budget.mjs";
import { Upstream } from "./upstream.mjs";
import { Adapters } from "./adapters.mjs";
import { createHandler } from "./service.mjs";
import { verifyProductionStorage } from "./storage.mjs";

process.umask(0o077);
try {
  const config = readConfig();
  if (!config.production) mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
  if (config.production) verifyProductionStorage(config.databasePath);
  const budget = new Budget(config.databasePath, Date.now, !config.production);
  const adapters = new Adapters(config, new Upstream(budget));
  const server = createServer({ maxHeaderSize: 8192 }, createHandler(config, budget, adapters));
  server.requestTimeout = 10_000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 30;
  server.maxConnections = 64;
  server.on("error", () => {
    console.error("Read service unavailable.");
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () =>
    console.log(
      `Read service listening on port ${config.port}; upstream reads ${config.readsEnabled ? "enabled" : "disabled"}.`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      server.close(() => {
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
