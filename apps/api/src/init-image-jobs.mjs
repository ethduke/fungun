import { checkAssetStorage } from "./asset-store.mjs";
import { initializeImageJobs, imageJobsPath } from "./image-job-store.mjs";

process.umask(0o077);
try {
  if (process.argv.length !== 3 || process.argv[2] !== "--initialize-image-jobs") throw new Error();
  const production = process.env.NODE_ENV === "production";
  if (
    production &&
    (!process.env.ASSETS_MACHINE_ID || process.env.ASSETS_MACHINE_ID !== process.env.FLY_MACHINE_ID)
  )
    throw new Error();
  checkAssetStorage(process.env.ASSET_STORE_ROOT, production);
  initializeImageJobs(imageJobsPath(process.env.ASSET_STORE_ROOT, production));
  console.log("Image job storage initialized.");
} catch {
  console.error(
    "Image job initialization refused. Verify the existing asset volume, permissions, and Machine identity; never replace a job ledger.",
  );
  process.exitCode = 1;
}
