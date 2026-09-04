import { closeSync, openSync } from "node:fs";
import { Budget } from "./budget.mjs";

process.umask(0o077);
try {
  if (process.argv[2] !== "--initialize-new-volume") throw new Error();
  const path = "/data/read-budget.sqlite";
  closeSync(openSync(path, "wx", 0o600));
  const budget = new Budget(path);
  budget.close();
  console.log("New budget database initialized. Existing databases are never replaced.");
} catch {
  console.error(
    "Initialization refused. Verify the new volume and permissions; do not reset an existing budget.",
  );
  process.exitCode = 1;
}
