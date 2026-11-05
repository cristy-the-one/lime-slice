// Size budget for the first chunk, the way TOTAL_BUDGET guards the MCP schema.
//   node tools/ci/bundle-budget.mjs           check dist/ against tools/ci/bundle-budget.json (CI runs this after `vite build`)
//   node tools/ci/bundle-budget.mjs --update  store the current size as the new budget (do this on purpose, in the PR that grows or trims the chunk)
// The first chunk is the module script that dist/index.html loads, plus any chunk it lists as a modulepreload.
// It fails when the minified size is more than 5 % over the stored figure.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const TOLERANCE = 0.05;
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const budgetFile = join(root, "tools/ci/bundle-budget.json");

/** Paths of the first-load scripts named by index.html, entry first. */
export function firstChunkFiles(html) {
  const files = [];
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
    const isEntry = /^<script\b/.test(tag) && /type="module"/.test(tag);
    const isPreload = /^<link\b/.test(tag) && /rel="modulepreload"/.test(tag);
    if (!isEntry && !isPreload) continue;
    const ref = /(?:src|href)="([^"]+)"/.exec(tag)?.[1];
    if (ref) files.push(ref.replace(/^\//, ""));
  }
  return files;
}

/** The verdict for a measured size against the stored figure. */
export function judge(bytes, budgetBytes, tolerance = TOLERANCE) {
  const limit = Math.floor(budgetBytes * (1 + tolerance));
  return { ok: bytes <= limit, limit, overBy: bytes - budgetBytes, percent: ((bytes - budgetBytes) / budgetBytes) * 100 };
}

export function measure(distDir = join(root, "dist")) {
  const files = firstChunkFiles(readFileSync(join(distDir, "index.html"), "utf8"));
  if (files.length === 0) throw new Error("dist/index.html names no module script; run `npx vite build` first");
  let bytes = 0;
  let gzip = 0;
  for (const file of files) {
    const code = readFileSync(join(distDir, file));
    bytes += code.length;
    gzip += gzipSync(code).length;
  }
  return { files, bytes, gzip };
}

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const size = measure();
  if (process.argv.includes("--update")) {
    writeFileSync(budgetFile, JSON.stringify({ firstChunkBytes: size.bytes, firstChunkGzipBytes: size.gzip }, null, 2) + "\n");
    console.log(`bundle budget set to ${size.bytes} bytes (${kb(size.bytes)}, ${kb(size.gzip)} gzip)`);
  } else {
    const budget = JSON.parse(readFileSync(budgetFile, "utf8")).firstChunkBytes;
    const verdict = judge(size.bytes, budget);
    console.log(`first chunk ${size.files.join(", ")}: ${size.bytes} bytes (${kb(size.bytes)}, ${kb(size.gzip)} gzip)`);
    console.log(`budget ${budget} bytes, limit ${verdict.limit} bytes (+${TOLERANCE * 100} %); now ${verdict.percent >= 0 ? "+" : ""}${verdict.percent.toFixed(2)} %`);
    if (!verdict.ok) {
      console.error(
        `FAIL the first chunk grew more than ${TOLERANCE * 100} % over its budget. ` +
          `Keep the new code in a lazy chunk, or if the growth is intended run: node tools/ci/bundle-budget.mjs --update`,
      );
      process.exit(1);
    }
  }
}
