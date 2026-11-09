/**
 * lust's optimised builds in the recipe host (mcp/recipe-opt.ts), against real lust and zig.
 *
 * The same recipe built three ways sends the same calls, byte for byte: tcc (LIME_LUST_OPT=0), a foreground `--opt`
 * (LIME_LUST_OPT=now), and the default `--opt=bg` once zig's cache is warm and the background build has landed (the
 * first build after the warm-up is tcc, a later one is the cached optimised program). Then the untrusted-build rule.
 *
 * Needs lust (LIME_LUST) and zig (LIME_ZIG, or zig bundled beside lust); skips without them. LIME_RECIPE_REQUIRED=1 with
 * LIME_ZIG set (CI's opt steps) makes a missing one a failure. LIME_LUST_OPT_CACHE names zig's cache (else a temp
 * folder, where the warm-up takes about a minute).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { findLust, RecipeHost, type RecipeCallSite, type RecipeReply } from "./recipe.ts";
import { distrustRunning, dropUntrusted, lustOptCacheRoot, zigFor } from "./recipe-opt.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const crateDir = join(root, "crates", "lime-recipe");
const required = process.env.LIME_RECIPE_REQUIRED === "1" && !!process.env.LIME_ZIG;
const lust = findLust();
const zig = lust ? zigFor(lust) : null;
if (!lust || !zig) {
  const missing = !lust ? "lust (LIME_LUST)" : "zig (LIME_ZIG)";
  if (required) {
    console.error(`recipe-opt: ${missing} is required here`);
    process.exit(1);
  }
  console.log(`recipe-opt: skipped (no ${missing})`);
  process.exit(0);
}
process.env.LIME_LUST_OPT_CACHE ??= mkdtempSync(join(tmpdir(), "lime-opt-cache-"));

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

const hostRoot = mkdtempSync(join(tmpdir(), "lime-recipe-opt-"));
const host = new RecipeHost({ crateDir, root: hostRoot, lust });
const source = readFileSync(join(crateDir, "examples", "mounting_bar.rs"), "utf8");

async function calls(mode: string | undefined): Promise<{ compiler?: string; calls: string; ok: boolean; ms: number }> {
  if (mode === undefined) delete process.env.LIME_LUST_OPT;
  else process.env.LIME_LUST_OPT = mode;
  const built = await host.build("bar", source, false);
  if (!built.ok || !built.exe) return { ok: false, calls: JSON.stringify(built.diagnostics) + (built.reason ?? ""), ms: built.ms };
  const log: RecipeCallSite[] = [];
  const out = await host.run(built.exe, {}, async (site): Promise<RecipeReply> => {
    log.push(site);
    if (site.tool === "solid_new") return { ok: true, result: { ok: true, object: "obj_1" } };
    return { ok: true, result: { ok: true } };
  });
  return { ok: out.ok, compiler: built.compiler, calls: JSON.stringify(log), ms: built.ms };
}

async function until(what: () => boolean, limitMs: number): Promise<boolean> {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    if (what()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return what();
}

const tcc = await calls("0");
check("tcc build runs", tcc.ok && tcc.compiler === "tcc", tcc);
const now = await calls("now");
check("--opt build runs the optimised program", now.ok && now.compiler === "opt", now);
check("--opt sends the same calls as tcc, byte for byte", now.calls === tcc.calls, { tcc: tcc.calls.length, opt: now.calls.length });

// The default: tcc until zig's cache is warm (the warm-up runs on its own), then --opt=bg.
const cache = lustOptCacheRoot();
const warm = () => existsSync(cache) && readdirNames(cache).some((n) => n.startsWith("warm-mcp-"));
const first = await calls(undefined);
check("the default builds and runs", first.ok, first);
check("zig's cache warms up in the background", await until(warm, 15 * 60_000), cache);
const second = await calls(undefined);
check("a warm build is tcc while the optimised one builds", second.ok && second.compiler === "tcc", second);
const opt = join(hostRoot, "cache", "opt");
const landed = await until(() => existsSync(opt) && readdirNames(opt).some((n) => n.endsWith(".ok")) && !existsSync(join(opt, "running.lock")), 10 * 60_000);
check("the background build lands in the host's lust cache", landed, existsSync(opt) ? readdirNames(opt) : opt);
const third = await calls(undefined);
check("a later build installs the optimised program", third.ok && third.compiler === "opt", third);
check("the cached optimised program sends the same calls", third.calls === tcc.calls);
console.log(`recipe-opt: builds ${tcc.ms} ms tcc, ${now.ms} ms --opt, ${third.ms} ms cached`);

// Untrusted builds: one in flight when a slot's file changed is dropped once it ends; others stay.
{
  const dir = mkdtempSync(join(tmpdir(), "lime-opt-untrusted-"));
  mkdirSync(join(dir, "opt"));
  for (const f of ["opt-a.exe.lock", "running.lock", "opt-b.exe", "opt-b.exe.ok"]) writeFileSync(join(dir, "opt", f), "");
  distrustRunning(dir);
  check("a running build is listed as untrusted", readFileSync(join(dir, "opt-untrusted.txt"), "utf8") === "opt-a.exe\n");
  dropUntrusted(dir);
  check("it stays listed while it runs", existsSync(join(dir, "opt-untrusted.txt")));
  writeFileSync(join(dir, "opt", "opt-a.exe"), "");
  writeFileSync(join(dir, "opt", "opt-a.exe.ok"), "");
  rmSync(join(dir, "opt", "opt-a.exe.lock"));
  dropUntrusted(dir);
  check("its binary goes when it ends", !existsSync(join(dir, "opt", "opt-a.exe")) && !existsSync(join(dir, "opt", "opt-a.exe.ok")) && !existsSync(join(dir, "opt-untrusted.txt")));
  check("a trusted binary stays", existsSync(join(dir, "opt", "opt-b.exe")));
}

function readdirNames(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

if (failed) {
  console.error(`recipe-opt: ${failed} failed`);
  process.exit(1);
}
console.log("recipe-opt: all passed");
