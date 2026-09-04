import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { assetEnvironment } from "../apps/api/src/asset-environment.mjs";

try {
  let local = {};
  if (process.env.NODE_ENV !== "production") {
    try {
      local = parseEnv(readFileSync(new URL("../.env", import.meta.url), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const initialize = process.argv.slice(2);
  if (initialize.length && (initialize.length !== 1 || initialize[0] !== "--initialize-new-volume"))
    throw new Error();
  const child = spawn(
    process.execPath,
    [initialize.length ? "src/init-assets.mjs" : "src/asset-server.mjs", ...initialize],
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
