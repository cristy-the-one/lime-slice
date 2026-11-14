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
import { centreDistance, classify, classifyInternal, classifyRack, drivenTurn, internalTurn, matePhase, matePhaseInternal, rackTurn, type PairReport, type Spur } from "../src/gear-pair.ts";

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
    let wide_driver = Gear::new(12, 2.0);
    let wide_driven = Gear::new(24, 2.0);
    let wide_phase = mate_phase(0.0, 12, 0.0, 24);
    for (name, distance) in [("w362", 36.2_f64), ("w37", 37.0), ("w38", 38.0), ("w399", 39.9)] {
        let deg = wide_phase + (0.16 / wide_driven.pitch_radius()) * (180.0 / std::f64::consts::PI);
        let report = classify(&wide_driver, &wide_driven, [0.0, 0.0], [distance, 0.0], 0.0, deg);
        rows.push(row(name, report.verdict.as_str(), report.narrow, report.hit));
    }
    let pointed = Gear::new(6, 1.0).pressure(30.0).shift(1.0);
    let pointed_mate = Gear::new(12, 1.0).pressure(30.0);
    let pointed_phase = mate_phase(0.0, 6, 0.0, 12);
    let pointed_report = classify(&pointed, &pointed_mate, [0.0, 0.0], [pointed.centre_distance(&pointed_mate), 0.0], 0.0, pointed_phase);
    rows.push(row("pointed", pointed_report.verdict.as_str(), pointed_report.narrow, pointed_report.hit));
    let apart = classify(&Gear::new(12, 2.0), &Gear::new(24, 2.0), [0.0, 0.0], [1000.0, 0.0], 0.0, 0.0);
    rows.push(row("apart", apart.verdict.as_str(), apart.narrow, apart.hit));
    let modules = classify(&Gear::new(12, 2.0), &Gear::new(24, 1.5), [0.0, 0.0], [30.0, 0.0], 0.0, 0.0);
    rows.push(row("modules", modules.verdict.as_str(), modules.narrow, modules.hit));
    let stages = classify(&Gear::new(12, 2.0), &Gear::new(24, 1.5), [0.0, 0.0], [36.0, 0.0], 0.0, 0.0);
    rows.push(row("stages", stages.verdict.as_str(), stages.narrow, stages.hit));
    let pitch_mm = std::f64::consts::PI * 2.0;
    for (name, distance, tooth) in [("l39", 39.0_f64, 0.2_f64), ("l395", 39.5, 0.26), ("t39", 39.0, 0.5), ("t38", 38.0, 0.2), ("c359", 35.9, 0.0), ("c35", 35.0, 0.0)] {
        let deg = wide_phase + (tooth * pitch_mm / wide_driven.pitch_radius()) * (180.0 / std::f64::consts::PI);
        let report = classify(&wide_driver, &wide_driven, [0.0, 0.0], [distance, 0.0], 0.0, deg);
        rows.push(row(name, report.verdict.as_str(), report.narrow, report.hit));
    }
    s.done_with(&part, Json::obj().set("rows", rows.join(";")));
}
`;

// A pinion inside a ring (docs/plan-gear-kinds.md, stage 2): classify_internal and internal_turn, the same rows from
// lust, rustc and the window's copy.
const ringSource = `use lime_recipe::{ops, Json, Session};
use lime_recipe::gears::{mate_phase_internal, Gear, Ring};
use lime_recipe::gear_pair::{classify_internal, internal_turn};

fn row(name: &str, verdict: &str, narrow: bool, hit: bool) -> String {
    let n = if narrow { "1" } else { "0" };
    let h = if hit { "1" } else { "0" };
    format!("{name}:{verdict}:{n}:{h}")
}

fn main() {
    let mut s = Session::start();
    let part = s.solid_new(ops::cuboid(2.0, 2.0, 2.0)).unwrap();
    let mut rows: Vec<String> = Vec::new();
    for (zp, zr, module, dir) in [(12u32, 36u32, 1.0, 0.0), (18, 48, 2.0, 120.0), (15, 60, 1.5, -75.0)] {
        let pinion = Gear::new(zp, module);
        let ring = Ring::new(zr, module);
        let working = module * (zr - zp) as f64 / 2.0;
        let (sn, cs) = ((dir * std::f64::consts::PI / 180.0).sin(), (dir * std::f64::consts::PI / 180.0).cos());
        let at = [working * cs, working * sn];
        let phase = mate_phase_internal(0.0, zp, dir, zr);
        for turn in [0.0, 0.04, -0.04, 0.3, -0.3] {
            let deg = phase + (turn / ring.pitch_radius()) * (180.0 / std::f64::consts::PI);
            let report = classify_internal(&pinion, &ring, at, [0.0, 0.0], 0.0, deg);
            rows.push(row(&format!("{zp}-{zr}-{turn}"), report.verdict.as_str(), report.narrow, report.hit));
        }
        for angle in [7.0, 45.0, 200.0] {
            let report = internal_turn(&pinion, &ring, at, [0.0, 0.0], 0.0, phase, angle);
            rows.push(row(&format!("{zp}-{zr}-turn-{angle}"), report.verdict.as_str(), report.narrow, report.hit));
        }
        for (name, d) in [("out", working + 0.5), ("in", working - 0.5)] {
            let report = classify_internal(&pinion, &ring, [d * cs, d * sn], [0.0, 0.0], 0.0, mate_phase_internal(0.0, zp, dir, zr));
            rows.push(row(&format!("{zp}-{zr}-{name}"), report.verdict.as_str(), report.narrow, report.hit));
        }
    }
    let apart = classify_internal(&Gear::new(12, 2.0), &Ring::new(48, 2.0), [0.0, 0.0], [0.0, 0.0], 0.0, 0.0);
    rows.push(row("apart", apart.verdict.as_str(), apart.narrow, apart.hit));
    let small = classify_internal(&Gear::new(12, 2.0), &Ring::new(12, 2.0), [0.0, 0.0], [0.0, 0.0], 0.0, 0.0);
    rows.push(row("small", small.verdict.as_str(), small.narrow, small.hit));
    s.done_with(&part, Json::obj().set("rows", rows.join(";")));
}
`;

// A pinion against a rack (docs/plan-gear-kinds.md, stage 3): classify_rack and rack_turn, the same rows everywhere.
const rackSource = `use lime_recipe::{ops, Json, Session};
use lime_recipe::gears::{Gear, Rack};
use lime_recipe::gear_pair::{classify_rack, rack_turn};

fn row(name: &str, verdict: &str, narrow: bool, hit: bool) -> String {
    let n = if narrow { "1" } else { "0" };
    let h = if hit { "1" } else { "0" };
    format!("{name}:{verdict}:{n}:{h}")
}

fn main() {
    let mut s = Session::start();
    let part = s.solid_new(ops::cuboid(2.0, 2.0, 2.0)).unwrap();
    let mut rows: Vec<String> = Vec::new();
    for (z, module) in [(12u32, 1.0), (18, 2.0), (9, 1.5)] {
        let pinion = Gear::new(z, module);
        let rack = Rack::new(40, module);
        let x = 10.0 * rack.pitch_mm();
        let at = [x, pinion.pitch_radius()];
        let phase = -90.0;
        let rack_phase = rack.pitch_mm() / 2.0;
        for turn in [0.0, 0.06, -0.06, 0.3, -0.3] {
            let report = classify_rack(&pinion, &rack, at, phase + turn / pinion.pitch_radius() * (180.0 / std::f64::consts::PI), rack_phase);
            rows.push(row(&format!("{z}-{turn}"), report.verdict.as_str(), report.narrow, report.hit));
        }
        for angle in [7.0, 45.0, -80.0] {
            let report = rack_turn(&pinion, &rack, at, phase, rack_phase, angle);
            rows.push(row(&format!("{z}-turn-{angle}"), report.verdict.as_str(), report.narrow, report.hit));
        }
        for (name, d) in [("near", -0.5), ("far", 0.5)] {
            let report = classify_rack(&pinion, &rack, [x, at[1] + d], phase, rack_phase);
            rows.push(row(&format!("{z}-{name}"), report.verdict.as_str(), report.narrow, report.hit));
        }
    }
    let apart = classify_rack(&Gear::new(12, 1.0), &Rack::new(10, 1.0), [5.0, 30.0], 0.0, 0.0);
    rows.push(row("apart", apart.verdict.as_str(), apart.narrow, apart.hit));
    let modules = classify_rack(&Gear::new(12, 2.0), &Rack::new(10, 1.0), [5.0, 12.0], 0.0, 0.0);
    rows.push(row("modules", modules.verdict.as_str(), modules.narrow, modules.hit));
    s.done_with(&part, Json::obj().set("rows", rows.join(";")));
}
`;

/** The rows `rackSource` prints, from the window's copy. */
function windowRackRows(): string {
  const spur = (teeth: number, module: number): Spur => ({ teeth, module, pressureDeg: 20, backlash: 0.1, shift: 0 });
  const row = (name: string, report: PairReport) => `${name}:${report.verdict}:${report.narrow ? 1 : 0}:${report.hit ? 1 : 0}`;
  const rows: string[] = [];
  for (const [z, module] of [[12, 1], [18, 2], [9, 1.5]] as const) {
    const pinion = spur(z, module);
    const rack = spur(40, module);
    const x = 10 * Math.PI * module;
    const at: [number, number] = [x, (module * z) / 2];
    const phase = -90;
    const rackPhase = (Math.PI * module) / 2;
    for (const turn of [0, 0.06, -0.06, 0.3, -0.3]) rows.push(row(`${z}-${turn}`, classifyRack(pinion, rack, at, phase + (turn / ((module * z) / 2)) * (180 / Math.PI), rackPhase)));
    for (const angle of [7, 45, -80]) rows.push(row(`${z}-turn-${angle}`, rackTurn(pinion, rack, at, phase, rackPhase, angle)));
    for (const [name, d] of [["near", -0.5], ["far", 0.5]] as const) rows.push(row(`${z}-${name}`, classifyRack(pinion, rack, [x, at[1] + d], phase, rackPhase)));
  }
  rows.push(row("apart", classifyRack(spur(12, 1), spur(10, 1), [5, 30], 0, 0)));
  rows.push(row("modules", classifyRack(spur(12, 2), spur(10, 1), [5, 12], 0, 0)));
  return rows.join(";");
}

/** The rows `ringSource` prints, from the window's copy. */
function windowRingRows(): string {
  const spur = (teeth: number, module: number): Spur => ({ teeth, module, pressureDeg: 20, backlash: 0.1, shift: 0 });
  const row = (name: string, report: PairReport) => `${name}:${report.verdict}:${report.narrow ? 1 : 0}:${report.hit ? 1 : 0}`;
  const rows: string[] = [];
  for (const [zp, zr, module, dir] of [[12, 36, 1, 0], [18, 48, 2, 120], [15, 60, 1.5, -75]] as const) {
    const pinion = spur(zp, module);
    const ring = spur(zr, module);
    const working = (module * (zr - zp)) / 2;
    const at: [number, number] = [working * Math.cos((dir * Math.PI) / 180), working * Math.sin((dir * Math.PI) / 180)];
    const phase = matePhaseInternal(0, zp, dir, zr);
    for (const turn of [0, 0.04, -0.04, 0.3, -0.3]) rows.push(row(`${zp}-${zr}-${turn}`, classifyInternal(pinion, ring, at, [0, 0], 0, phase + (turn / ((module * zr) / 2)) * (180 / Math.PI))));
    for (const angle of [7, 45, 200]) rows.push(row(`${zp}-${zr}-turn-${angle}`, internalTurn(pinion, ring, at, [0, 0], 0, phase, angle)));
    for (const [name, d] of [["out", working + 0.5], ["in", working - 0.5]] as const) {
      rows.push(row(`${zp}-${zr}-${name}`, classifyInternal(pinion, ring, [d * Math.cos((dir * Math.PI) / 180), d * Math.sin((dir * Math.PI) / 180)], [0, 0], 0, matePhaseInternal(0, zp, dir, zr))));
    }
  }
  rows.push(row("apart", classifyInternal(spur(12, 2), spur(48, 2), [0, 0], [0, 0], 0, 0)));
  rows.push(row("small", classifyInternal(spur(12, 2), spur(12, 2), [0, 0], [0, 0], 0, 0)));
  return rows.join(";");
}

/**
 * The rows `pairSource` prints, from the window's copy of the check (`src/gear-pair.ts`). The gear card and
 * `model_check` run that copy and a recipe runs the crate's, so the two are held to the same verdicts here.
 */
function windowPairRows(): string {
  const spur = (teeth: number, module: number, pressureDeg = 20, shift = 0): Spur => ({ teeth, module, pressureDeg, backlash: 0.1, shift });
  const row = (name: string, report: PairReport) => `${name}:${report.verdict}:${report.narrow ? 1 : 0}:${report.hit ? 1 : 0}`;
  const deg = 180 / Math.PI;
  const rows: string[] = [];
  for (const [z1, z2, module] of [[12, 24, 2], [17, 31, 1.5], [9, 40, 1], [24, 24, 1]] as const) {
    const driver = spur(z1, module);
    const driven = spur(z2, module);
    const distance = centreDistance(driver, driven);
    const phase = matePhase(0, z1, 0, z2);
    const radius = (module * z2) / 2;
    for (const turn of [0, 0.06, -0.06, 0.16, -0.16]) rows.push(row(`${z1}-${z2}-${turn}`, classify(driver, driven, [0, 0], [distance, 0], 0, phase + (turn / radius) * deg)));
    rows.push(row(`${z1}-${z2}-half`, classify(driver, driven, [0, 0], [distance, 0], 0, phase + ((Math.PI * module) / 2 / radius) * deg)));
    for (const angle of [0, 15, 90]) rows.push(row(`${z1}-${z2}-turn-${angle}`, drivenTurn(driver, driven, [0, 0], [distance, 0], 0, phase, angle)));
  }
  const wideDriver = spur(12, 2);
  const wideDriven = spur(24, 2);
  const widePhase = matePhase(0, 12, 0, 24);
  for (const [name, distance] of [["w362", 36.2], ["w37", 37], ["w38", 38], ["w399", 39.9]] as const) {
    rows.push(row(name, classify(wideDriver, wideDriven, [0, 0], [distance, 0], 0, widePhase + (0.16 / 24) * deg)));
  }
  const pointed = spur(6, 1, 30, 1);
  const pointedMate = spur(12, 1, 30);
  rows.push(row("pointed", classify(pointed, pointedMate, [0, 0], [centreDistance(pointed, pointedMate), 0], 0, matePhase(0, 6, 0, 12))));
  rows.push(row("apart", classify(spur(12, 2), spur(24, 2), [0, 0], [1000, 0], 0, 0)));
  rows.push(row("modules", classify(spur(12, 2), spur(24, 1.5), [0, 0], [30, 0], 0, 0)));
  rows.push(row("stages", classify(spur(12, 2), spur(24, 1.5), [0, 0], [36, 0], 0, 0)));
  const pitchMm = Math.PI * 2;
  for (const [name, distance, tooth] of [["l39", 39, 0.2], ["l395", 39.5, 0.26], ["t39", 39, 0.5], ["t38", 38, 0.2], ["c359", 35.9, 0], ["c35", 35, 0]] as const) {
    rows.push(row(name, classify(wideDriver, wideDriven, [0, 0], [distance, 0], 0, widePhase + ((tooth * pitchMm) / 24) * deg)));
  }
  return rows.join(";");
}

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
  const pairText = JSON.stringify(pairs.lustDone);
  check("gear_pair: lust and rustc print the same verdicts", pairText === JSON.stringify(pairs.rustcDone) && pairText.includes("meshing") && pairText.includes("loose") && pairText.includes("unbuildable"), { lust: pairs.lustDone, rustc: pairs.rustcDone });
  const crateRows = String((pairs.rustcDone as { rows?: string } | null)?.rows ?? "").split(";");
  const windowRows = windowPairRows().split(";");
  const differ = windowRows.filter((line, at) => line !== crateRows[at]);
  check("gear_pair: the window's copy gives the crate's verdicts", crateRows.length === windowRows.length && differ.length === 0, { differ, crate: crateRows.filter((line, at) => line !== windowRows[at]) });

  const rings = await runBoth("gear_ring", ringSource);
  const ringText = JSON.stringify(rings.lustDone);
  check("ring gears: lust and rustc print the same verdicts", ringText === JSON.stringify(rings.rustcDone) && ringText.includes("meshing") && ringText.includes("toothOnTooth") && ringText.includes("tooClose"), { lust: rings.lustDone, rustc: rings.rustcDone });
  const crateRing = String((rings.rustcDone as { rows?: string } | null)?.rows ?? "").split(";");
  const windowRing = windowRingRows().split(";");
  const ringDiffer = windowRing.filter((line, at) => line !== crateRing[at]);
  check("ring gears: the window's copy gives the crate's verdicts", crateRing.length === windowRing.length && ringDiffer.length === 0, { ringDiffer, crate: crateRing.filter((line, at) => line !== windowRing[at]) });

  const racks = await runBoth("gear_rack", rackSource);
  const rackText = JSON.stringify(racks.lustDone);
  check("racks: lust and rustc print the same verdicts", rackText === JSON.stringify(racks.rustcDone) && rackText.includes("meshing") && rackText.includes("toothOnTooth") && rackText.includes("tooClose") && rackText.includes("loose"), { lust: racks.lustDone, rustc: racks.rustcDone });
  const crateRack = String((racks.rustcDone as { rows?: string } | null)?.rows ?? "").split(";");
  const windowRack = windowRackRows().split(";");
  const rackDiffer = windowRack.filter((line, at) => line !== crateRack[at]);
  check("racks: the window's copy gives the crate's verdicts", crateRack.length === windowRack.length && rackDiffer.length === 0, { rackDiffer, crate: crateRack.filter((line, at) => line !== windowRack[at]) });
}

if (failed > 0) {
  console.error(`recipe-gears: ${failed} failed`);
  process.exit(1);
}
console.log("recipe-gears: all passed");
