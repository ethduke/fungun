import { pathToFileURL } from "node:url";
import { backupAssets, restoreAssetBackup, verifyAssetBackup } from "./asset-snapshot.mjs";
import { recoverCompleteAssets } from "./asset-recovery.mjs";
import { ServiceError } from "./errors.mjs";

export function snapshotArguments(args) {
  const [mode, ...flags] = args;
  if (!["backup", "verify", "restore", "recover-complete"].includes(mode) ||
      new Set(flags).size !== flags.length ||
      flags.some((flag) => !["--execute", "--service-stopped"].includes(flag)) ||
      (flags.includes("--execute") && !flags.includes("--service-stopped")) ||
      (mode === "verify" && flags.length))
    throw new ServiceError("invalid_snapshot_arguments");
  return { mode, execute: flags.includes("--execute"), serviceStopped: flags.includes("--service-stopped") };
}

export function snapshotEnvironment(inherited = {}, local = {}) {
  const result = {};
  for (const name of ["NODE_ENV", "ASSET_STORE_ROOT", "ASSET_BACKUP_ROOT", "ASSET_BACKUP_SHA256",
    "ASSET_RESTORE_ROOT", "ASSETS_MACHINE_ID", "FLY_MACHINE_ID"]) {
    const source = Object.hasOwn(inherited, name) ? inherited : local;
    if (typeof source[name] === "string") result[name] = source[name];
  }
  return result;
}

export async function snapshotMain(args, env = process.env) {
  try {
    const options = snapshotArguments(args);
    const production = env.NODE_ENV === "production";
    if (production && (!env.ASSETS_MACHINE_ID || env.ASSETS_MACHINE_ID !== env.FLY_MACHINE_ID))
      throw new ServiceError("asset_machine_mismatch");
    const shared = { ...options, production, root: env.ASSET_STORE_ROOT,
      backupRoot: env.ASSET_BACKUP_ROOT, expectedSha256: env.ASSET_BACKUP_SHA256 };
    const result = options.mode === "backup"
      ? await backupAssets({ ...shared, output: env.ASSET_BACKUP_ROOT })
      : options.mode === "restore"
        ? restoreAssetBackup({ ...shared, output: env.ASSET_RESTORE_ROOT })
        : options.mode === "recover-complete"
          ? recoverCompleteAssets(shared)
          : verifyAssetBackup(shared);
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    console.error(error?.code === "asset_backup_outdated"
      ? "The backup no longer matches the asset store. Keep the service stopped and create a fresh verified backup before recovery. No recovery was committed."
      : "Asset snapshot refused. Check private paths, permissions, space, schema and the separately recorded digest. Writes need --execute --service-stopped. Never overwrite a live store; restored stores remain locked.");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await snapshotMain(process.argv.slice(2));
