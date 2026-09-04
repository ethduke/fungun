import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { ServiceError } from "./errors.mjs";

export function verifyProductionStorage(path) {
  const mounts = readFileSync("/proc/self/mountinfo", "utf8").split("\n");
  const mounted = mounts.some(
    (line) => line.split(" ")[4] === "/data" && !line.includes(" - tmpfs "),
  );
  if (
    !mounted ||
    realpathSync("/data") !== "/data" ||
    realpathSync(path) !== "/data/read-budget.sqlite" ||
    !lstatSync(path).isFile()
  )
    throw new ServiceError("persistent_budget_storage_required");
}
