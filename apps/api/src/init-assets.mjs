import { initializeAssetStore } from "./asset-store.mjs";

try {
  if (process.argv.length !== 3 || process.argv[2] !== "--initialize-new-volume") throw new Error();
  initializeAssetStore(process.env.ASSET_STORE_ROOT, process.env.NODE_ENV === "production");
  console.log("New asset storage initialized.");
} catch {
  console.error(
    "Asset initialization refused. Use an empty, private directory outside Git on the dedicated asset volume.",
  );
  process.exitCode = 1;
}
