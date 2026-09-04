import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { ServiceError } from "./errors.mjs";

const filesystem = { lstatSync, readFileSync, realpathSync };

export function verifyProductionMount(io = filesystem) {
  const mounts = io
    .readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .map((line) => line.split(" "))
    .filter((fields) => fields[4] === "/data");
  const mount = mounts[0];
  const separator = mount?.indexOf("-") ?? -1;
  if (
    mounts.length !== 1 ||
    separator < 6 ||
    !["ext4", "xfs", "btrfs"].includes(mount[separator + 1]) ||
    !mount[separator + 2]?.startsWith("/dev/") ||
    !mount[5]?.split(",").includes("rw") ||
    !mount[separator + 3]?.split(",").includes("rw") ||
    io.realpathSync("/data") !== "/data" ||
    !io.lstatSync("/data").isDirectory()
  )
    throw new ServiceError("persistent_budget_storage_required");
}

export function verifyProductionStorage(path, io = filesystem) {
  verifyProductionMount(io);
  if (
    path !== "/data/read-budget.sqlite" ||
    io.realpathSync(path) !== path ||
    !io.lstatSync(path).isFile()
  )
    throw new ServiceError("persistent_budget_storage_required");
}
