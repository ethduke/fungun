import {
  closeSync,
  openSync,
  readSync,
  readFileSync,
  accessSync,
  constants,
  existsSync,
} from "node:fs";
import { isIP } from "node:net";

export function verifyDecoderEnvironment(env = process.env) {
  for (const [name, value] of Object.entries(env)) {
    if (name === "FLY_PRIVATE_IP") {
      if (typeof value !== "string" || isIP(value) !== 6 || !/^fdaa:/i.test(value) || value.includes("%"))
        throw new Error("Invalid decoder platform metadata.");
      continue;
    }
    if (/(?:SECRET|PRIVATE|SIGNATURE|MNEMONIC|RPC|KEY|TOKEN|PASSWORD|AUTH|CREDENTIAL|WALLET|SEED)/i.test(name))
      throw new Error("Unexpected decoder credentials.");
  }
}

export function verifyDecoderExecutable(path = process.execPath) {
  const file = openSync(path, "r");
  try {
    const header = Buffer.alloc(64);
    if (
      readSync(file, header, 0, 64, 0) !== 64 ||
      header.subarray(0, 4).toString("hex") !== "7f454c46" ||
      header[4] !== 2 ||
      header[5] !== 1 ||
      header.readUInt16LE(16) !== 3
    )
      throw new Error("Decoder requires PIE-enabled Linux Node.");
    const offset = Number(header.readBigUInt64LE(32));
    const entrySize = header.readUInt16LE(54),
      count = header.readUInt16LE(56);
    if (
      entrySize !== 56 ||
      count < 1 ||
      count > 256 ||
      !Number.isSafeInteger(offset) ||
      offset < 64 ||
      offset > 1048576
    )
      throw new Error("Invalid decoder executable.");
    const entries = Buffer.alloc(entrySize * count);
    if (readSync(file, entries, 0, entries.length, offset) !== entries.length)
      throw new Error("Invalid decoder executable.");
    let safeStack = false;
    for (let index = 0; index < count; index++) {
      const start = index * entrySize;
      if (entries.readUInt32LE(start) === 0x6474e551) {
        if (entries.readUInt32LE(start + 4) & 1) throw new Error("Executable decoder stack.");
        safeStack = true;
      }
    }
    if (!safeStack) throw new Error("Missing decoder stack policy.");
  } finally {
    closeSync(file);
  }
}

export function verifyDecoderRuntime() {
  verifyDecoderExecutable();
  if (
    process.getuid() === 0 ||
    readFileSync("/proc/sys/kernel/randomize_va_space", "utf8").trim() !== "2" ||
    existsSync("/data")
  )
    throw new Error("Unsafe decoder runtime.");
  for (const path of [
    new URL("./decoder-server.mjs", import.meta.url),
    new URL("./launch-image-worker.mjs", import.meta.url),
  ]) {
    let writable = true;
    try {
      accessSync(path, constants.W_OK);
    } catch {
      writable = false;
    }
    if (writable) throw new Error("Writable decoder source.");
  }
  verifyDecoderEnvironment();
}
