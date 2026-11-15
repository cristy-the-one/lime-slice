/**
 * lime_recipe::mech (recipe API 1.13, docs/plan-mass-properties.md): a pendulum recipe that takes its period as a
 * parameter and solves its own length, built by lust and by rustc, sends the same calls and reports the same bits;
 * and the numbers are the window's (`src/mass.ts`): pendulum_period, pendulum_length, compound_period and
 * equivalent_length over a sweep. The clock note's 139.73 mm pendulum swings in 0.75 s. Skips without lust;
 * LIME_RECIPE_REQUIRED=1 makes that a failure.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { findLust, RecipeHost, type RecipeCallSite, type RecipeReply } from "./recipe.ts";
import { compoundPeriod, pendulumLength, pendulumPeriod } from "../src/mass.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const crateDir = join(root, "crates", "lime-recipe");
const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("recipe-mech: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("recipe-mech: skipped (set LIME_LUST to a lust build)");
  process.exit(0);
}

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`);
}

const dir = mkdtempSync(join(tmpdir(), "lime-recipe-mech-"));
const host = new RecipeHost({ crateDir, root: join(dir, "host"), lust });
const exe = process.platform === "win32" ? ".exe" : "";

const LENGTHS = [1, 50, 139.73, 248.5, 993.6];
const PERIODS = [0.25, 0.75, 1, 2, 3.7];
/** A number as a Rust float literal. */
const float = (v: number) => (Number.isInteger(v) ? `${v}.0` : String(v));
const COMPOUND: [number, number, number][] = [[569712.96, 15.128, 184.836], [40000, 3, 100], [1.5e7, 120.5, 310.25]];

// The period is the parameter; the recipe solves the rod's length and cuts it. The rows are each value's bits.
const source = `use lime_recipe::{ops, Json, Session};
use lime_recipe::mech::{compound_period, equivalent_length, pendulum_length, pendulum_period, G_MM_S2};

fn bits(v: f64) -> String {
    format!("{:016x}", v.to_bits())
}

fn main() {
    let mut s = Session::start();
    let period = s.number("period", 0.75).range(0.1, 5.0).unit("s").label("Period").get();
    let rod = pendulum_length(period);
    let part = s.solid_new(ops::cuboid(4.0, 4.0, rod)).unwrap();
    let mut rows: Vec<String> = Vec::new();
    for l in [${LENGTHS.map(float).join(", ")}] {
        rows.push(bits(pendulum_period(l)));
    }
    for t in [${PERIODS.map(float).join(", ")}] {
        rows.push(bits(pendulum_length(t)));
    }
    for (i, m, d) in [${COMPOUND.map(([i, m, d]) => `(${float(i)}, ${float(m)}, ${float(d)})`).join(", ")}] {
        rows.push(bits(compound_period(i, m, d)));
        rows.push(bits(equivalent_length(i, m, d)));
    }
    rows.push(bits(G_MM_S2));
    s.done_with(&part, Json::obj().set("rod", rod).set("rows", rows.join(";")));
}
`;

function stub(log: RecipeCallSite[]) {
  return async (site: RecipeCallSite): Promise<RecipeReply> => {
    log.push(site);
    if (site.tool === "solid_new") return { ok: true, result: { ok: true, object: "obj_1" } };
    return { ok: true, result: { ok: true, volumeMm3: 1000 } };
  };
}

const bitsOf = (v: number) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, v);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
};
const fromBits = (hex: string) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
};

const rlib = join(dir, "liblime_recipe.rlib");
const lib = spawnSync("rustc", ["--edition", "2024", "-O", "--crate-type", "rlib", "--crate-name", "lime_recipe", join(crateDir, "src", "lib.rs"), "-o", rlib], { encoding: "utf8" });
check("rustc builds lime_recipe", lib.status === 0, lib.stderr);

if (lib.status === 0) {
  const built = await host.build("pendulum", source, false);
  check("lust builds the pendulum recipe", built.ok, built.diagnostics.length ? built.diagnostics : built.reason);
  const src = join(dir, "pendulum.rs");
  writeFileSync(src, source);
  const rustcExe = join(dir, `pendulum${exe}`);
  const r = spawnSync("rustc", ["--edition", "2024", "-O", src, "--extern", `lime_recipe=${rlib}`, "-o", rustcExe], { encoding: "utf8" });
  check("rustc builds the pendulum recipe", r.status === 0, r.stderr);
  if (built.ok && r.status === 0) {
    const runs: { calls: RecipeCallSite[]; metrics: { rod?: number; rows?: string } | undefined }[] = [];
    for (const binary of [built.exe!, rustcExe]) {
      const calls: RecipeCallSite[] = [];
      const ran = await host.run(binary, { params: { period: 1 }, context: { units: "mm" } }, stub(calls));
      check(`${binary === rustcExe ? "rustc" : "lust"}: the run reaches done`, ran.ok, ran.reason ?? ran.stderr);
      runs.push({ calls, metrics: ran.done?.metrics as { rod?: number; rows?: string } | undefined });
    }
    const [viaLust, viaRustc] = runs as [typeof runs[0], typeof runs[0]];
    check("lust and rustc send the same calls", JSON.stringify(viaLust.calls.map((c) => [c.tool, c.args])) === JSON.stringify(viaRustc.calls.map((c) => [c.tool, c.args])), { lust: viaLust.calls, rustc: viaRustc.calls });
    check("lust and rustc report the same bits", !!viaLust.metrics?.rows && viaLust.metrics.rows === viaRustc.metrics?.rows, { lust: viaLust.metrics, rustc: viaRustc.metrics });
    const solved = viaLust.calls.find((c) => c.tool === "solid_new")?.args as { dz?: number } | undefined;
    check("a period of 1 s solves a 248.4 mm rod (g / 4π²)", typeof solved?.dz === "number" && Math.abs(solved.dz - pendulumLength(1)) < 1e-9 && Math.abs(solved.dz - 248.4) < 0.1, solved);
    // The window's numbers: the same functions in src/mass.ts.
    const window = [
      ...LENGTHS.map((l) => pendulumPeriod(l)),
      ...PERIODS.map((t) => pendulumLength(t)),
      ...COMPOUND.flatMap(([i, m, d]) => [compoundPeriod(i, m, d), i / (m * d)]),
      9806.65,
    ];
    const crate = String(viaRustc.metrics?.rows ?? "").split(";");
    const off = window.map((v, at) => ({ at, window: v, crate: crate[at] ? fromBits(crate[at]!) : NaN })).filter((row) => Math.abs(row.window - row.crate) > 1e-12 * Math.abs(row.window));
    check(`the window's src/mass.ts gives the crate's numbers (${window.length} values, ${window.filter((v, at) => bitsOf(v) === crate[at]).length} bit for bit)`, crate.length === window.length && off.length === 0, off);
    check("the clock note: 139.73 mm swings in 0.75 s", Math.abs(fromBits(crate[2]!) - 0.75) < 1e-4, fromBits(crate[2]!));
  }
}

if (failed > 0) {
  console.error(`recipe-mech: ${failed} failed`);
  process.exit(1);
}
console.log("recipe-mech: all passed");
