import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { assetEnvironment } from "../apps/api/src/asset-environment.mjs";
import { maintenanceArguments } from "../apps/api/src/asset-maintenance.mjs";

try {
  let local = {};
  if (process.env.NODE_ENV !== "production") {
    try {
      local = parseEnv(readFileSync(new URL("../.env", import.meta.url), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const args = process.argv.slice(2);
  const initialize = args.length === 1 && args[0] === "--initialize-new-volume";
  if (args.length && !initialize) maintenanceArguments(args);
  const child = spawn(
    process.execPath,
    [initialize ? "src/init-assets.mjs" : args.length ? "src/asset-maintenance.mjs" : "src/asset-server.mjs", ...args],
    {
      cwd: fileURLToPath(new URL("../apps/api/", import.meta.url)),
      env: assetEnvironment(process.env, local),
      stdio: "inherit",
    },
  );
  child.once("error", () => {
    console.error("Asset service could not start.");
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (["SIGINT", "SIGTERM"].includes(signal) ? 0 : 1);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
} catch {
  console.error("Asset environment could not be loaded. Check the ignored local configuration.");
  process.exitCode = 1;
}
