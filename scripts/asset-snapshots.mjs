import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { snapshotArguments, snapshotEnvironment } from "../apps/api/src/asset-snapshot-cli.mjs";

try {
  let local = {};
  if (process.env.NODE_ENV !== "production") {
    try { local = parseEnv(readFileSync(new URL("../.env", import.meta.url), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const args = process.argv.slice(2);
  snapshotArguments(args);
  const child = spawn(process.execPath, ["src/asset-snapshot-cli.mjs", ...args], {
    cwd: fileURLToPath(new URL("../apps/api/", import.meta.url)),
    env: snapshotEnvironment(process.env, local), stdio: "inherit",
  });
  child.once("error", () => {
    console.error("Asset snapshot tool could not start.");
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (["SIGINT", "SIGTERM"].includes(signal) ? 0 : 1);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
} catch {
  console.error("Asset snapshot configuration or arguments are invalid. No snapshot was requested.");
  process.exitCode = 1;
}
