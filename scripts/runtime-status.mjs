import { runtimeStatus } from "../apps/api/src/runtime-status.mjs";

const report = runtimeStatus(process.env);
console.log(report.message);
for (const feature of report.features) {
  const details = [
    feature.missing.length ? `missing: ${feature.missing.join(", ")}` : "",
    feature.disabled.length ? `off: ${feature.disabled.join(", ")}` : "",
  ].filter(Boolean);
  console.log(
    `${feature.id}: ${feature.status}${details.length ? ` (${details.join("; ")})` : ""}`,
  );
}
if (report.configuration === "invalid") process.exitCode = 1;
