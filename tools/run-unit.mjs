/**
 * Run tools/unit-tests.txt one file at a time.
 * A single `npm run test:unit` command that names every file is longer than Windows allows.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = readFileSync(join(root, "tools/unit-tests.txt"), "utf8")
  .split(/\r?\n/)
  .map((line) => line.replace(/#.*$/, "").trim())
  .filter(Boolean);

if (files.length === 0) {
  console.error("tools/unit-tests.txt has no tests");
  process.exit(1);
}

for (const file of files) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", file], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
