import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { apiEnvironment } from "../apps/api/src/runtime-env.mjs";

let local = {};
try {
  if (process.env.NODE_ENV !== "production") {
    try {
      local = parseEnv(readFileSync(new URL("../.env", import.meta.url), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: fileURLToPath(new URL("../apps/api/", import.meta.url)),
    env: apiEnvironment(process.env, local),
    stdio: "inherit",
  });
  child.once("error", () => {
    console.error("Read service could not start.");
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
} catch {
  console.error("Read service environment could not be loaded. Check the ignored local file.");
  process.exitCode = 1;
}
