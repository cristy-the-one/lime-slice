/**
 * Rule zero for a recipe's own float maths: a recipe that calls f64::sin, cos, tan, asin, acos, atan, atan2, exp, ln
 * and the rest (and their f32 forms) itself sends the same bits built by lust and by rustc. Before lust's fix
 * (cristy-the-one/lust-lang, "Float maths: call the same C runtime as rustc on Windows") lust called msvcrt's
 * functions on Windows and rustc the UCRT's, and these differed in the last bit on up to a few inputs in a hundred.
 * The recipe hashes each function's result bits over 2,000 inputs and logs one line per function, plus a few values
 * in full, so a slip names the function. Skips without lust; LIME_RECIPE_REQUIRED=1 (the CI jobs that build lust)
 * makes that a failure.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { findLust, RecipeHost, type RecipeCallSite, type RecipeReply } from "./recipe.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const crateDir = join(root, "crates", "lime-recipe");
const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("recipe-floatmath: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("recipe-floatmath: skipped (set LIME_LUST to a lust build)");
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

const RECIPE = `use lime_recipe::{ops, Session};

struct Rng {
    s: u64,
}

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.s;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.s = x;
        x
    }
    fn uni(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * ((self.next() >> 11) as f64 * (1.0 / 9007199254740992.0))
    }
}

fn input(f: usize, i: usize, rng: &mut Rng) -> f64 {
    let pi = std::f64::consts::PI;
    if i < 81 {
        return (i as f64 - 40.0) * pi / 4.0;
    }
    let r = i % 5;
    if f == 3 || f == 4 || r == 0 {
        if r == 1 { 1.0 - rng.uni(0.0, 1e-6) } else { rng.uni(-1.0, 1.0) }
    } else if r == 1 {
        rng.uni(-10.0, 10.0)
    } else if r == 2 {
        rng.uni(-1000.0, 1000.0)
    } else if r == 3 {
        rng.uni(0.0, 2.0)
    } else {
        rng.uni(-700.0, 700.0)
    }
}

fn op64(f: usize, x: f64, y: f64) -> f64 {
    match f {
        0 => x.sin(),
        1 => x.cos(),
        2 => x.tan(),
        3 => x.asin(),
        4 => x.acos(),
        5 => x.atan(),
        6 => x.atan2(y),
        7 => x.sinh(),
        8 => x.cosh(),
        9 => x.tanh(),
        10 => x.exp(),
        11 => x.ln(),
        12 => x.log10(),
        13 => x.powf(y),
        14 => x.hypot(y),
        15 => x.exp2(),
        16 => x.exp_m1(),
        _ => x.ln_1p(),
    }
}

fn op32(f: usize, x: f32, y: f32) -> f32 {
    match f {
        0 => x.sin(),
        1 => x.cos(),
        2 => x.tan(),
        3 => x.asin(),
        4 => x.acos(),
        5 => x.atan(),
        6 => x.atan2(y),
        7 => x.sinh(),
        8 => x.cosh(),
        9 => x.tanh(),
        10 => x.exp(),
        11 => x.ln(),
        12 => x.log10(),
        13 => x.powf(y),
        14 => x.hypot(y),
        15 => x.exp2(),
        16 => x.exp_m1(),
        _ => x.ln_1p(),
    }
}

const NAMES: [&str; 18] = [
    "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh", "exp", "ln", "log10", "powf",
    "hypot", "exp2", "exp_m1", "ln_1p",
];

fn main() {
    let mut s = Session::start();
    let part = s.solid_new(ops::cuboid(10.0, 10.0, 10.0)).unwrap();
    let mut f = 0;
    while f < NAMES.len() {
        let mut rng = Rng { s: 0x9E3779B97F4A7C15 ^ (f as u64 + 1) };
        let (mut h64, mut h32) = (0xcbf29ce484222325u64, 0xcbf29ce484222325u64);
        let mut i = 0;
        while i < 2000 {
            let x = input(f, i, &mut rng);
            let y = if f == 13 { rng.uni(-4.0, 4.0) } else { rng.uni(-100.0, 100.0) };
            h64 = (h64 ^ op64(f, x, y).to_bits()).wrapping_mul(0x100000001b3);
            h32 = (h32 ^ op32(f, x as f32, y as f32).to_bits() as u64).wrapping_mul(0x100000001b3);
            i += 1;
        }
        s.log(&format!("{} f64 {:016x} f32 {:016x}", NAMES[f], h64, h32));
        f += 1;
    }
    // A gear tooth's involute point, as a recipe computes it, sent as numbers.
    let (rb, t) = (15.0f64, 0.3f64);
    let (px, py) = (rb * (t.cos() + t * t.sin()), rb * (t.sin() - t * t.cos()));
    s.log(&format!("involute {:?} {:?} {:?} {:?}", px, py, py.atan2(px).to_degrees(), (px * px + py * py).ln().exp()));
    s.done(&part);
}
`;

const dir = mkdtempSync(join(tmpdir(), "lime-recipe-floatmath-"));
const host = new RecipeHost({ crateDir, root: join(dir, "host"), lust });
const exe = process.platform === "win32" ? ".exe" : "";

// The crate as rustc builds it for a recipe: one rlib, no dev-dependencies.
const rlib = join(dir, "liblime_recipe.rlib");
const lib = spawnSync("rustc", ["--edition", "2024", "-O", "--crate-type", "rlib", "--crate-name", "lime_recipe", join(crateDir, "src", "lib.rs"), "-o", rlib], { encoding: "utf8" });
check("rustc builds lime_recipe", lib.status === 0, lib.stderr);

function stub(log: RecipeCallSite[]) {
  return async (site: RecipeCallSite): Promise<RecipeReply> => {
    log.push(site);
    if (site.tool === "solid_new") return { ok: true, result: { ok: true, object: "obj_1" } };
    return { ok: true, result: { ok: true } };
  };
}

if (lib.status === 0) {
  const built = await host.build("floatmath", RECIPE, false);
  check("lust builds the recipe", built.ok, built.diagnostics.length ? built.diagnostics : built.reason);
  const src = join(dir, "floatmath.rs");
  writeFileSync(src, RECIPE);
  const rustcExe = join(dir, `floatmath${exe}`);
  const r = spawnSync("rustc", ["--edition", "2024", "-O", src, "--extern", `lime_recipe=${rlib}`, "-o", rustcExe], { encoding: "utf8" });
  check("rustc builds the recipe", r.status === 0, r.stderr);
  if (built.ok && r.status === 0) {
    const viaLust: RecipeCallSite[] = [];
    const viaRustc: RecipeCallSite[] = [];
    const a = await host.run(built.exe!, { params: {}, context: { units: "mm" } }, stub(viaLust));
    const b = await host.run(rustcExe, { params: {}, context: { units: "mm" } }, stub(viaRustc));
    check("both runs reach done", a.ok && b.ok, { lust: a.reason ?? a.stderr, rustc: b.reason ?? b.stderr });
    const lines = (log: RecipeCallSite[]) => log.filter((c) => c.tool === "log").map((c) => JSON.stringify(c.args));
    const la = lines(viaLust);
    const lb = lines(viaRustc);
    check("19 log lines under each", la.length === 19 && lb.length === 19, { lust: la.length, rustc: lb.length });
    for (let i = 0; i < Math.max(la.length, lb.length); i++) {
      const name = String(la[i] ?? lb[i]).match(/"(\w+) /)?.[1] ?? `line ${i + 1}`;
      check(`${name}: the same bits under lust and rustc`, la[i] === lb[i], { lust: la[i], rustc: lb[i] });
    }
  }
}

if (failed > 0) {
  console.error(`recipe-floatmath: ${failed} failed`);
  process.exit(1);
}
console.log("recipe-floatmath: ok");
