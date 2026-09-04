import { readFacilitatorConfig } from "./config.mjs";
import { createPrivateFacilitator } from "./facilitator.mjs";
import { createFacilitatorServer } from "./server.mjs";

let server;
try {
  const config = readFacilitatorConfig();
  const runtime = await createPrivateFacilitator(config);
  server = createFacilitatorServer({
    ...runtime,
    config: {
      bearerToken: config.bearerToken,
      asset: config.asset,
      payTo: config.payTo,
      maxAmount: config.maxAmount,
    },
  });
  server.listen(config.port, "0.0.0.0", () => {
    console.info({
      event: "facilitator_started",
      port: config.port,
      network: "eip155:4663",
      relayerAddress: runtime.relayerAddress,
    });
  });
} catch (error) {
  const code =
    typeof error?.message === "string" && /^[a-z0-9_]{1,96}$/.test(error.message)
      ? error.message
      : "startup_validation_failed";
  console.error({ event: "facilitator_start_failed", code });
  process.exitCode = 1;
}

const stop = signal => {
  if (!server) return;
  console.info({ event: "facilitator_stopping", signal });
  server.close(error => {
    if (error) console.error({ event: "facilitator_stop_failed" });
    process.exitCode = error ? 1 : 0;
  });
};
process.once("SIGTERM", () => stop("SIGTERM"));
process.once("SIGINT", () => stop("SIGINT"));
