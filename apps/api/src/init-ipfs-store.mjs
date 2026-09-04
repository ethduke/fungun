import { initializeIpfsStore } from "./ipfs-store.mjs";

try {
  initializeIpfsStore(process.env.ASSET_STORE_ROOT, process.env.NODE_ENV === "production");
  console.log("IPFS publication journal initialized.");
} catch {
  console.error("IPFS journal initialization refused. Use an empty destination on the dedicated asset volume.");
  process.exitCode = 1;
}
