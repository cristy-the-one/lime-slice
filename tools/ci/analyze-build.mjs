// Dev only: `npm run build:analyze` builds with the bundle report switched on (vite.config.ts) and prints
// what each large chunk is made of. The full per-module list lands in dist-analysis.json.
import { spawnSync } from "node:child_process";

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(npx, ["vite", "build"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, LIME_ANALYZE: "1" },
});
process.exit(result.status ?? 1);
