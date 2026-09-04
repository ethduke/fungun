import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { join, sep } from "node:path";
import { checkAssetStorage } from "./asset-store.mjs";
import { checkAssetSnapshotSource, verifyAssetBackup, verifyRecoverySource } from "./asset-snapshot.mjs";
import { ServiceError } from "./errors.mjs";

function distinctStores(roots) {
  for (const root of roots) checkAssetStorage(root);
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      const a = roots[i], b = roots[j];
      if (a === b || a.startsWith(b + sep) || b.startsWith(a + sep))
        throw new ServiceError("asset_reconciliation_alias");
      for (const name of ["", "assets.sqlite", "objects"]) {
        const left = lstatSync(join(a, name));
        const right = lstatSync(join(b, name));
        if (left.dev === right.dev && left.ino === right.ino)
          throw new ServiceError("asset_reconciliation_alias");
      }
    }
  }
}

export function reconcileRestoredAssets({ root, backupRoot, restoreRoot, expectedSha256,
  production = false, now = Date.now }) {
  distinctStores([root, backupRoot, restoreRoot]);
  checkAssetSnapshotSource(root, production);
  const db = new DatabaseSync(join(root, "assets.sqlite"), { readOnly: true, timeout: 1000 });
  let transaction = false;
  try {
    db.exec("PRAGMA trusted_schema = OFF; BEGIN");
    transaction = true;
    const source = verifyRecoverySource({ db, root, backupRoot, expectedSha256, now });
    const restored = verifyAssetBackup({ backupRoot: restoreRoot, expectedSha256, now });
    db.exec("COMMIT");
    transaction = false;
    return { mode: "reconcile-restore", matched: true, counts: source.counts,
      reservedBytes: source.reservedBytes, files: restored.files, objectBytes: restored.bytes,
      activationAllowed: false, requiresVerifiedCutoverIdentity: true, requiresCutoverRecheck: true };
  } catch (error) {
    if (transaction) db.exec("ROLLBACK");
    throw error;
  } finally { db.close(); }
}
