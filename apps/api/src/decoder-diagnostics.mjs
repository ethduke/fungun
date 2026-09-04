import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { verifyDecoderRuntime } from "./decoder-runtime.mjs";

export function assessDecoderIsolation({ baseline = false, status = "", mounts = "", memory = "" } = {}) {
  const root = mounts.split("\n").find((line) => line.split(" ")[4] === "/");
  const memoryBytes = /^\d+$/.test(memory.trim()) ? Number(memory.trim()) : NaN;
  return {
    baselineRuntime: baseline === true,
    effectiveCapabilitiesDropped: /^CapEff:\s+0+$/m.test(status),
    noNewPrivileges: /^NoNewPrivs:\s+1$/m.test(status),
    rootReadOnly: root?.split(" ")[5]?.split(",").includes("ro") === true,
    memoryCapped: Number.isSafeInteger(memoryBytes) && memoryBytes > 0 && memoryBytes <= 512 * 1024 * 1024,
    networkIsolation: "unverified",
    publicationReady: false,
  };
}

export function decoderDiagnostics() {
  const read = (path) => {
    try { return readFileSync(path, "utf8"); }
    catch { return ""; }
  };
  let baseline = false;
  try { verifyDecoderRuntime(); baseline = true; }
  catch { /* Report failed checks without exposing process configuration. */ }
  const memoryPath = ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"].find(existsSync);
  return assessDecoderIsolation({ baseline, status: read("/proc/self/status"),
    mounts: read("/proc/self/mountinfo"), memory: memoryPath ? read(memoryPath) : "" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    console.error("Decoder diagnostics accepts no arguments and cannot enable publication.");
    process.exitCode = 1;
  } else console.log(JSON.stringify(decoderDiagnostics()));
}
