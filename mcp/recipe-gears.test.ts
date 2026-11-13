/**
 * lime_recipe::gears, adopted from the library's involute-gears v1 (docs/plan-native-recipes.md section 5): built by
 * lust, a recipe that carries the library copy inline (as a kept plugin does) gets the same points, bit for bit, from
 * the crate's functions of the same names, over a sweep of teeth, module, backlash, flank points and phase, and from
 * mate_phase, idler_centre and rack_outline. The same holds built by rustc. The new `Gear` outline sends the same calls
 * under lust and rustc (its own trig). Skips without lust; LIME_RECIPE_REQUIRED=1 makes that a failure.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { findLust, RecipeHost, type RecipeCallSite, type RecipeReply } from "./recipe.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const crateDir = join(root, "crates", "lime-recipe");
const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("recipe-gears: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("recipe-gears: skipped (set LIME_LUST to a lust build)");
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

const dir = mkdtempSync(join(tmpdir(), "lime-recipe-gears-"));
const host = new RecipeHost({ crateDir, root: join(dir, "host"), lust });
const exe = process.platform === "win32" ? ".exe" : "";

// The library ingredient as it was adopted, inline as a kept plugin carries it (its header lines are comments).
const library = readFileSync(join(crateDir, "tests", "fixtures", "involute_gears_v1.rs"), "utf8")
  .split("\n")
  .filter((line) => !line.startsWith("//!"))
  .join("\n");

const compare = `use lime_recipe::{ops, Json, Session};
use lime_recipe::gears;

mod ingredients {
    pub mod involute_gears {
${library}
    }
}
use ingredients::involute_gears as library;

fn same(a: &[[f64; 2]], b: &[[f64; 2]]) -> bool {
    a.len() == b.len() && a.iter().zip(b.iter()).all(|(p, q)| p[0].to_bits() == q[0].to_bits() && p[1].to_bits() == q[1].to_bits())
}

fn main() {
    let mut s = Session::start();
    let part = s.solid_new(ops::cuboid(2.0, 2.0, 2.0)).unwrap();
    let mut compared = 0u64;
    let mut differ = 0u64;
    let mut hash = 0xcbf29ce484222325u64;
    let mut eat = |pts: &[[f64; 2]]| {
        for p in pts.iter() {
            for v in [p[0], p[1]] {
                hash ^= v.to_bits();
                hash = hash.wrapping_mul(0x100000001b3);
            }
        }
    };
    for z in 6..=120u32 {
        for m in [0.5, 1.0, 1.25, 2.0, 3.175] {
            for b in [0.0, 0.1, 0.25] {
                for flank in [2usize, 3, 5] {
                    for phase in [0.0, 7.5, -33.3, 180.0] {
                        let ours = gears::gear_outline_with(z, m, b, flank, phase);
                        let theirs = library::gear_outline_with(z, m, b, flank, phase);
                        compared += 1;
                        if !same(&ours, &theirs) { differ += 1; }
                        eat(&ours);
                    }
                }
            }
            compared += 1;
            if !same(&gears::gear_outline(z, m, 12.5), &library::gear_outline(z, m, 12.5)) { differ += 1; }
        }
        for mate in [6u32, 13, 24, 60] {
            for dir in [-97.25, 0.0, 33.0, 179.999] {
                compared += 1;
                if gears::mate_phase(3.3, z, dir, mate).to_bits() != library::mate_phase(3.3, z, dir, mate).to_bits() { differ += 1; }
            }
        }
    }
    for (d1, d2) in [(12.0, 18.0), (24.5, 31.25), (30.0, 1.0)] {
        for left in [true, false] {
            compared += 1;
            let a = gears::idler_centre([0.0, 0.0], [35.0, -7.0], d1, d2, left);
            let b = library::idler_centre([0.0, 0.0], [35.0, -7.0], d1, d2, left);
            if a.map(|p| [p[0].to_bits(), p[1].to_bits()]) != b.map(|p| [p[0].to_bits(), p[1].to_bits()]) { differ += 1; }
        }
    }
    for m in [0.5, 1.0, 2.0] {
        let centres: Vec<f64> = (0..9).map(|i| -10.0 + 3.141592653589793 * m * i as f64).collect();
        compared += 1;
        if !same(&gears::rack_outline(m, &centres, 4.0), &library::rack_outline(m, &centres, 4.0)) { differ += 1; }
    }
    s.done_with(&part, Json::obj().set("compared", compared as f64).set("differ", differ as f64).set("hash", format!("{hash:016x}")));
}
`;

// The new outline, sent as an extrude: the same bytes under lust and rustc.
const outline = `use lime_recipe::{ops, Json, Session};
use lime_recipe::gears::{Gear, mate_phase};

fn main() {
    let mut s = Session::start();
    let part = s.solid_new(ops::cuboid(80.0, 80.0, 4.0)).unwrap();
    for (z, x, a) in [(9u32, 0.0, 20.0), (12, 0.0, 20.0), (24, 0.25, 20.0), (31, -0.2, 14.5), (60, 0.0, 25.0)] {
        let g = Gear::new(z, 1.5).shift(x).pressure(a);
        let lp = g.outline(mate_phase(0.0, 12, 0.0, z)).unwrap().to_loop();
        s.apply(&part, Json::obj().set("kind", "extrude").set("op", "cut").set("origin", [0.0, 0.0, 4.0]).set("depth", -1.0).set("loops", vec![lp])).unwrap();
        s.apply(&part, ops::gear("fuse", &g, 3.0, [0.0, 0.0, 4.0]).set("bore", 4.0)).unwrap();
    }
    s.done_with(&part, Json::obj().set("area", Gear::new(24, 1.5).area().unwrap()));
}
`;

function stub(log: RecipeCallSite[]) {
  return async (site: RecipeCallSite): Promise<RecipeReply> => {
    log.push(site);
    if (site.tool === "solid_new") return { ok: true, result: { ok: true, object: "obj_1" } };
    return { ok: true, result: { ok: true, volumeMm3: 1000 } };
  };
}

// The pair classifier, including a driven turn. The string is the verdicts; lust and rustc must print the same one.
const pairSource = `use lime_recipe::{ops, Json, Session};
use lime_recipe::gears::{mate_phase, Gear};
use lime_recipe::gear_pair::{classify, driven_turn};

fn row(name: &str, verdict: &str, narrow: bool, hit: bool) -> String {
    let n = if narrow { "1" } else { "0" };
    let h = if hit { "1" } else { "0" };
    format!("{name}:{verdict}:{n}:{h}")
}

fn main() {
    let mut s = Session::start();
    let part = s.solid_new(ops::cuboid(2.0, 2.0, 2.0)).unwrap();
    let mut rows: Vec<String> = Vec::new();
    for (z1, z2, module) in [(12u32, 24u32, 2.0), (17, 31, 1.5), (9, 40, 1.0), (24, 24, 1.0)] {
        let driver = Gear::new(z1, module);
        let driven = Gear::new(z2, module);
        let distance = driver.centre_distance(&driven);
        let phase = mate_phase(0.0, z1, 0.0, z2);
        for turn in [0.0, 0.06, -0.06, 0.16, -0.16] {
            let deg = phase + (turn / driven.pitch_radius()) * (180.0 / std::f64::consts::PI);
            let report = classify(&driver, &driven, [0.0, 0.0], [distance, 0.0], 0.0, deg);
            rows.push(row(&format!("{z1}-{z2}-{turn}"), report.verdict.as_str(), report.narrow, report.hit));
        }
        let half = std::f64::consts::PI * module / 2.0;
        let deg = phase + (half / driven.pitch_radius()) * (180.0 / std::f64::consts::PI);
        let report = classify(&driver, &driven, [0.0, 0.0], [distance, 0.0], 0.0, deg);
        rows.push(row(&format!("{z1}-{z2}-half"), report.verdict.as_str(), report.narrow, report.hit));
        for angle in [0.0, 15.0, 90.0] {
            let report = driven_turn(&driver, &driven, [0.0, 0.0], [distance, 0.0], 0.0, phase, angle);
            rows.push(row(&format!("{z1}-{z2}-turn-{angle}"), report.verdict.as_str(), report.narrow, report.hit));
        }
    }
    let apart = classify(&Gear::new(12, 2.0), &Gear::new(24, 2.0), [0.0, 0.0], [1000.0, 0.0], 0.0, 0.0);
    rows.push(row("apart", apart.verdict.as_str(), apart.narrow, apart.hit));
    let modules = classify(&Gear::new(12, 2.0), &Gear::new(24, 1.5), [0.0, 0.0], [36.0, 0.0], 0.0, 0.0);
    rows.push(row("modules", modules.verdict.as_str(), modules.narrow, modules.hit));
    s.done_with(&part, Json::obj().set("rows", rows.join(";")));
}
`;

const rlib = join(dir, "liblime_recipe.rlib");
const lib = spawnSync("rustc", ["--edition", "2024", "-O", "--crate-type", "rlib", "--crate-name", "lime_recipe", join(crateDir, "src", "lib.rs"), "-o", rlib], { encoding: "utf8" });
check("rustc builds lime_recipe", lib.status === 0, lib.stderr);

async function runBoth(name: string, source: string): Promise<{ lust: RecipeCallSite[]; rustc: RecipeCallSite[]; lustDone: unknown; rustcDone: unknown }> {
  const built = await host.build(name, source, false);
  check(`${name}: lust builds it`, built.ok, built.diagnostics.length ? built.diagnostics : built.reason);
  const src = join(dir, `${name}.rs`);
  writeFileSync(src, source);
  const rustcExe = join(dir, `${name}${exe}`);
  const r = spawnSync("rustc", ["--edition", "2024", "-O", src, "--extern", `lime_recipe=${rlib}`, "-o", rustcExe], { encoding: "utf8" });
  check(`${name}: rustc builds it`, r.status === 0, r.stderr);
  const viaLust: RecipeCallSite[] = [];
  const viaRustc: RecipeCallSite[] = [];
  if (!built.ok || r.status !== 0) return { lust: viaLust, rustc: viaRustc, lustDone: null, rustcDone: null };
  const a = await host.run(built.exe!, { params: {}, context: { units: "mm" } }, stub(viaLust));
  const b = await host.run(rustcExe, { params: {}, context: { units: "mm" } }, stub(viaRustc));
  check(`${name}: both runs reach done`, a.ok && b.ok, { lust: a.reason ?? a.stderr, rustc: b.reason ?? b.stderr });
  console.log(`     ${name}: lust run ${a.ms} ms, rustc run ${b.ms} ms`);
  return { lust: viaLust, rustc: viaRustc, lustDone: a.done?.metrics, rustcDone: b.done?.metrics };
}

if (lib.status === 0) {
  const adopted = await runBoth("gears_adopted", compare);
  const lustMetrics = adopted.lustDone as { compared?: number; differ?: number; hash?: string } | null;
  const rustcMetrics = adopted.rustcDone as { compared?: number; differ?: number; hash?: string } | null;
  check(`built by lust, the crate's gears give the library's points bit for bit (${lustMetrics?.compared ?? 0} comparisons)`, (lustMetrics?.compared ?? 0) > 20_000 && lustMetrics?.differ === 0, lustMetrics);
  check(`built by rustc, the same (${rustcMetrics?.compared ?? 0} comparisons)`, (rustcMetrics?.compared ?? 0) > 20_000 && rustcMetrics?.differ === 0, rustcMetrics);
  // The adopted functions use the platform's trig, as the library did: lust and rustc may differ in the last bit. Said, not checked.
  console.log(`     v1 outlines: lust hash ${lustMetrics?.hash}, rustc hash ${rustcMetrics?.hash}${lustMetrics?.hash === rustcMetrics?.hash ? " (the same here)" : " (they differ here, as the library copy's do)"}`);

  const outlines = await runBoth("gears_outline", outline);
  const textA = outlines.lust.map((c) => JSON.stringify([c.tool, c.args, c.line]));
  const textB = outlines.rustc.map((c) => JSON.stringify([c.tool, c.args, c.line]));
  const first = textA.findIndex((t, i) => t !== textB[i]);
  check(`Gear outlines: ${textA.length} calls, the same under lust and rustc`, textA.length === 11 && textA.length === textB.length && first < 0, first >= 0 ? { call: first + 1, lust: textA[first]?.slice(0, 400), rustc: textB[first]?.slice(0, 400) } : textA.length);
  check("Gear outlines: the same area under lust and rustc", JSON.stringify(outlines.lustDone) === JSON.stringify(outlines.rustcDone), { lust: outlines.lustDone, rustc: outlines.rustcDone });
  const gearCall = outlines.lust.find((c) => (c.args.op as { kind?: string } | undefined)?.kind === "gear");
  check("ops::gear sends the gear op", JSON.stringify(gearCall?.args.op).startsWith('{"kind":"gear","op":"fuse","teeth":9,"module":1.5,"thickness":3'), gearCall?.args);

  const pairs = await runBoth("gear_pair", pairSource);
  check("gear_pair: lust and rustc print the same verdicts", JSON.stringify(pairs.lustDone) === JSON.stringify(pairs.rustcDone) && JSON.stringify(pairs.lustDone).includes("meshing"), { lust: pairs.lustDone, rustc: pairs.rustcDone });
}

if (failed > 0) {
  console.error(`recipe-gears: ${failed} failed`);
  process.exit(1);
}
console.log("recipe-gears: all passed");
