import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkAssetStorage } from "./asset-store.mjs";
import { ServiceError } from "./errors.mjs";

export function maintenanceArguments(args) {
  const modes = ["--inspect", "--migrate-schema", "--expire-pending"];
  const selected = args.filter((arg) => modes.includes(arg));
  if (
    new Set(args).size !== args.length ||
    selected.length > 1 ||
    args.some((arg) => ![...modes, "--execute", "--service-stopped"].includes(arg)) ||
    (args.includes("--execute") && !args.includes("--service-stopped"))
  )
    throw new ServiceError("invalid_maintenance_arguments");
  const mode = selected[0]?.slice(2) ?? "inspect";
  if (mode === "inspect" && args.includes("--execute"))
    throw new ServiceError("invalid_maintenance_arguments");
  return {
    mode,
    execute: args.includes("--execute"),
    serviceStopped: args.includes("--service-stopped"),
  };
}

export function inspectAssetDatabase(db, now = Date.now) {
  if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok")
    throw new ServiceError("asset_storage_unavailable");
  const setting = (name) =>
    db.prepare("SELECT value FROM settings WHERE name = ?").get(name)?.value;
  const schema = setting("asset-schema");
  const previous = setting("clock");
  const used = setting("asset-bytes");
  const expected = "id,owner,image_hash,metadata_hash,bytes,created,expires,state";
  const columns = (table) =>
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => column.name)
      .join(",");
  if (
    !["1", "2"].includes(schema) ||
    setting("schema-version") !== "1" ||
    !/^[a-f0-9]{64}$/.test(setting("ip-hmac") ?? "") ||
    !/^\d+$/.test(previous ?? "") ||
    !Number.isSafeInteger(Number(previous)) ||
    !/^\d+$/.test(used ?? "") ||
    !Number.isSafeInteger(Number(used)) ||
    Number(used) > 256 * 1024 * 1024 ||
    columns("asset_challenges") !== expected ||
    columns("counters") !== "scope,expires,used" ||
    columns("asset_objects") !== "name,bytes"
  )
    throw new ServiceError("asset_storage_unavailable");
  const current = now();
  if (!Number.isSafeInteger(current) || current < Number(previous) - 1000)
    throw new ServiceError("asset_clock_unavailable");
  const cutoff = Math.max(current, Number(previous));
  const counts = { pending: 0, reserved: 0, published: 0, expired: 0 };
  for (const row of db
    .prepare("SELECT state, COUNT(*) AS count FROM asset_challenges GROUP BY state")
    .all()) {
    if (!Object.hasOwn(counts, row.state) || (schema === "1" && row.state === "expired"))
      throw new ServiceError("asset_storage_unavailable");
    counts[row.state] = row.count;
  }
  const reserved = db
    .prepare(
      "SELECT COALESCE(SUM(bytes), 0) AS bytes FROM asset_challenges WHERE state IN ('reserved', 'published')",
    )
    .get().bytes;
  if (reserved !== Number(used)) throw new ServiceError("asset_storage_unavailable");
  const eligible = db
    .prepare(
      "SELECT COUNT(*) AS count FROM asset_challenges WHERE state = 'pending' AND expires < ?",
    )
    .get(cutoff).count;
  return { schema: Number(schema), counts, eligible, reservedBytes: reserved, cutoff };
}

export function maintainAssets({
  root,
  mode = "inspect",
  execute = false,
  serviceStopped = false,
  production = false,
  now = Date.now,
}) {
  if (
    !["inspect", "migrate-schema", "expire-pending"].includes(mode) ||
    (execute && (mode === "inspect" || !serviceStopped))
  )
    throw new ServiceError("invalid_maintenance_arguments");
  checkAssetStorage(root, production);
  const db = new DatabaseSync(join(root, "assets.sqlite"), { readOnly: !execute, timeout: 1000 });
  let transaction = false;
  try {
    if (execute) {
      db.exec("PRAGMA synchronous = FULL");
      db.exec("BEGIN IMMEDIATE");
      transaction = true;
    }
    if (execute && db.prepare("SELECT 1 FROM settings WHERE name = 'asset-restore-state'").get())
      throw new ServiceError("asset_restore_quarantined");
    const before = inspectAssetDatabase(db, now);
    if (mode === "expire-pending" && before.schema !== 2)
      throw new ServiceError("asset_migration_required");
    let changed = 0;
    if (execute) {
      if (mode === "migrate-schema" && before.schema === 1) {
        db.exec(
          readFileSync(new URL("../migrations/002-assets-expiry.sql", import.meta.url), "utf8"),
        );
        changed = 1;
      }
      if (mode === "expire-pending") {
        // Terminalize only approvals that never reserved storage.
        changed = db
          .prepare(
            "UPDATE asset_challenges SET state = 'expired' WHERE state = 'pending' AND expires < ?",
          )
          .run(before.cutoff).changes;
      }
      db.prepare("UPDATE settings SET value = ? WHERE name = 'clock'").run(String(before.cutoff));
    }
    const after = inspectAssetDatabase(db, () => before.cutoff);
    if (execute) {
      db.exec("COMMIT");
      transaction = false;
    }
    return {
      mode,
      execute,
      changed,
      schema: after.schema,
      counts: after.counts,
      eligible: after.eligible,
      reservedBytes: after.reservedBytes,
    };
  } catch (error) {
    if (transaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function maintenanceMain(args, env = process.env) {
  try {
    const production = env.NODE_ENV === "production";
    if (production && (!env.ASSETS_MACHINE_ID || env.ASSETS_MACHINE_ID !== env.FLY_MACHINE_ID))
      throw new ServiceError("asset_machine_mismatch");
    const result = maintainAssets({
      ...maintenanceArguments(args),
      root: env.ASSET_STORE_ROOT,
      production,
    });
    console.log(JSON.stringify(result));
    return 0;
  } catch {
    console.error(
      "Asset maintenance refused. Check the dedicated volume, schema and clock. Writes require --execute --service-stopped; stop the asset service first.",
    );
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = maintenanceMain(process.argv.slice(2));
