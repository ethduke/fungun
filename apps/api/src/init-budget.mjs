import { closeSync, openSync } from "node:fs";
import { Budget } from "./budget.mjs";
import { verifyProductionMount } from "./storage.mjs";
import { pathToFileURL } from "node:url";

export function initializeBudget({
  verifyMount = verifyProductionMount,
  openFile = openSync,
  closeFile = closeSync,
  createBudget = (path) => new Budget(path),
} = {}) {
  verifyMount();
  const path = "/data/read-budget.sqlite";
  closeFile(openFile(path, "wx", 0o600));
  const budget = createBudget(path);
  budget.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--initialize-new-volume")
      throw new Error();
    initializeBudget();
    console.log("New budget database initialized. Existing databases are never replaced.");
  } catch {
    console.error(
      "Initialization refused. Verify the new volume and permissions; do not reset an existing budget.",
    );
    process.exitCode = 1;
  }
}
