/**
 * lime_recipe::horology (clock ingredients, API 1.14): a recipe that counts trains, builds a Graham escapement, a ratchet
 * and its click, BS 978-2 wheels and pinions and bores sends the same calls and reports the same numbers, bit for bit,
 * built by lust and by rustc (the module uses the crate's own trig). Skips without lust; LIME_RECIPE_REQUIRED=1 makes
 * that a failure.
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
    console.error("recipe-horology: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("recipe-horology: skipped (set LIME_LUST to a lust build)");
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

const dir = mkdtempSync(join(tmpdir(), "lime-recipe-horology-"));
const host = new RecipeHost({ crateDir, root: join(dir, "host"), lust });
const exe = process.platform === "win32" ? ".exe" : "";

const source = `use lime_recipe::{ops, Json, Session};
use lime_recipe::gears::mate_phase;
use lime_recipe::horology::*;

struct Fnv {
    hash: u64,
    count: u64,
}

impl Fnv {
    fn eat(&mut self, v: f64) {
        self.hash ^= v.to_bits();
        self.hash = self.hash.wrapping_mul(0x100000001b3);
        self.count += 1;
    }
    fn pts(&mut self, pts: &[[f64; 2]]) {
        for p in pts.iter() {
            self.eat(p[0]);
            self.eat(p[1]);
        }
    }
}

fn cut(s: &mut Session, part: &lime_recipe::Part, lp: Json) {
    s.apply(part, Json::obj().set("kind", "extrude").set("op", "cut").set("origin", [0.0, 0.0, 4.0]).set("depth", -1.0).set("loops", vec![lp])).unwrap();
}

fn main() {
    let mut s = Session::start();
    let part = s.solid_new(ops::cuboid(200.0, 200.0, 4.0)).unwrap();
    let mut f = Fnv { hash: 0xcbf29ce484222325, count: 0 };
    let mut rows: Vec<String> = Vec::new();

    // Trains.
    for (period, teeth, stages, limits) in [
        (0.75, 30u32, 3u32, TrainLimits::new(40, 64, 8, 10)),
        (2.0, 30, 2, TrainLimits::new(48, 96, 6, 12)),
        (0.7, 30, 3, TrainLimits::new(30, 120, 6, 14)),
        (0.75, 30, 1, TrainLimits::new(40, 64, 8, 10)),
    ] {
        match train_options(period, teeth, stages, &limits) {
            Ok(trains) => {
                let best = &trains[0];
                let mut text: Vec<String> = Vec::new();
                for st in best.stages.iter() {
                    text.push(format!("{}/{}", st.0, st.1));
                }
                rows.push(format!("train:{}:{}", trains.len(), text.join("x")));
                f.eat(best.period_s());
                f.eat(best.ratio());
            }
            Err(why) => rows.push(format!("train:{why}")),
        }
    }
    f.eat(train_ratio(&[(64, 8), (50, 10), (40, 10)]));
    f.eat(escape_period_s(160.0, 30));

    // Graham escapements.
    for (teeth, tip, root, lean, span) in [(30u32, 22.5, 17.5, 12.0, 7.5), (30, 22.5, 18.0, 10.0, 8.5), (40, 30.0, 25.0, 14.0, 10.5), (24, 15.0, 11.0, 12.0, 6.5)] {
        let g = Graham::new(EscapeWheel::new(teeth, tip, root, lean), span);
        f.eat(g.pivot_distance());
        match g.anchor() {
            Ok(anchor) => {
                f.pts(&outline_points(&anchor, 1.0));
                let (e, x) = g.pallets().unwrap();
                f.pts(&[e.locking_corner, e.letoff_corner, e.face_end, x.locking_corner, x.letoff_corner, x.face_end]);
                f.eat(g.pallet_thickness().unwrap());
                let (phase, deg) = g.rest_pose().unwrap();
                f.eat(phase);
                f.eat(deg);
                cut(&mut s, &part, anchor.to_loop());
                cut(&mut s, &part, g.wheel.outline(phase).unwrap().to_loop());
                rows.push("graham:ok".to_string());
            }
            Err(why) => rows.push(format!("graham:{why}")),
        }
    }
    let g = Graham::new(EscapeWheel::new(30, 22.5, 17.5, 12.0), 7.5);
    for refused in [g.drop(0.0), g.drop(6.0), g.impulse(8.0).friction(0.6), g.hub_radius(9.5), Graham::new(EscapeWheel::new(30, 22.5, 21.5, 12.0), 7.5), Graham::new(EscapeWheel::new(30, 22.5, 17.5, 12.0), 7.0)] {
        rows.push(format!("refused:{}", refused.refusal().unwrap_or_default()));
    }

    // Ratchet and click.
    for (teeth, tip, root, length, phase) in [(24u32, 15.0, 12.5, 18.0, 0.0), (30, 20.0, 17.0, 22.0, 37.5), (12, 10.0, 7.0, 14.0, -90.0)] {
        let r = Ratchet::new(teeth, tip, root);
        f.pts(&r.points(phase).unwrap());
        match r.click(phase, &r.click_size(length)) {
            Ok(c) => {
                f.pts(&outline_points(&c.outline, 2.0));
                f.pts(&[c.pivot, c.nose]);
                f.eat(c.seat_deg);
                f.eat(c.lift_deg);
                cut(&mut s, &part, r.outline(phase).unwrap().to_loop());
                cut(&mut s, &part, c.outline.to_loop());
                rows.push("click:ok".to_string());
            }
            Err(why) => rows.push(format!("click:{why}")),
        }
    }

    // BS 978-2 wheels and pinions.
    for (z, zp, m, top) in [(64u32, 8u32, 1.5, LeafTop::Medium), (50, 10, 1.5, LeafTop::Round), (40, 7, 1.0, LeafTop::High), (96, 12, 0.8, LeafTop::Round)] {
        let w = ClockWheel::new(z, m, zp);
        let p = w.pinion(top);
        f.eat(w.addendum_factor());
        f.eat(w.centre_distance());
        f.pts(&w.points(0.0, 8).unwrap());
        let ph = mate_phase(0.0, z, 0.0, zp);
        f.pts(&p.points(ph).unwrap());
        cut(&mut s, &part, w.outline(0.0).unwrap().to_loop());
        cut(&mut s, &part, p.outline(ph).unwrap().to_loop());
    }

    // Bores.
    for pin in STEEL_PINS {
        for fit in [Fit::Running, Fit::Sliding, Fit::Press] {
            f.eat(pin_bore(pin, fit, 0.2).unwrap());
        }
    }
    for name in BEARINGS {
        let b = bearing(name).unwrap();
        f.eat(b.seat(Fit::Press, 0.1));
        f.eat(b.shaft(Fit::Sliding, 0.05));
    }

    s.done_with(&part, Json::obj().set("hash", format!("{:016x}", f.hash)).set("numbers", f.count as f64).set("rows", rows.join(";")));
}
`;

function stub(log: RecipeCallSite[]) {
  return async (site: RecipeCallSite): Promise<RecipeReply> => {
    log.push(site);
    if (site.tool === "solid_new") return { ok: true, result: { ok: true, object: "obj_1" } };
    return { ok: true, result: { ok: true, volumeMm3: 1000 } };
  };
}

const rlib = join(dir, "liblime_recipe.rlib");
const lib = spawnSync("rustc", ["--edition", "2024", "-O", "--crate-type", "rlib", "--crate-name", "lime_recipe", join(crateDir, "src", "lib.rs"), "-o", rlib], { encoding: "utf8" });
check("rustc builds lime_recipe", lib.status === 0, lib.stderr);

if (lib.status === 0) {
  const built = await host.build("horology", source, false);
  check("lust builds the horology recipe", built.ok, built.diagnostics.length ? built.diagnostics : built.reason);
  const src = join(dir, "horology.rs");
  writeFileSync(src, source);
  const rustcExe = join(dir, `horology${exe}`);
  const r = spawnSync("rustc", ["--edition", "2024", "-O", src, "--extern", `lime_recipe=${rlib}`, "-o", rustcExe], { encoding: "utf8" });
  check("rustc builds the horology recipe", r.status === 0, r.stderr);
  if (built.ok && r.status === 0) {
    const viaLust: RecipeCallSite[] = [];
    const viaRustc: RecipeCallSite[] = [];
    const a = await host.run(built.exe!, { params: {}, context: { units: "mm" } }, stub(viaLust));
    const b = await host.run(rustcExe, { params: {}, context: { units: "mm" } }, stub(viaRustc));
    check("both runs reach done", a.ok && b.ok, { lust: a.reason ?? a.stderr, rustc: b.reason ?? b.stderr });
    console.log(`     lust run ${a.ms} ms, rustc run ${b.ms} ms`);
    const textA = viaLust.map((c) => JSON.stringify([c.tool, c.args, c.line]));
    const textB = viaRustc.map((c) => JSON.stringify([c.tool, c.args, c.line]));
    const first = textA.findIndex((t, i) => t !== textB[i]);
    check(`outlines: ${textA.length} calls, the same bytes under lust and rustc`, textA.length === 23 && textA.length === textB.length && first < 0, first >= 0 ? { call: first + 1, lust: textA[first]?.slice(0, 400), rustc: textB[first]?.slice(0, 400) } : textA.length);
    const lustDone = a.done?.metrics as { hash?: string; numbers?: number; rows?: string } | undefined;
    const rustcDone = b.done?.metrics as { hash?: string; numbers?: number; rows?: string } | undefined;
    check(`numbers: the same ${lustDone?.numbers ?? 0} values bit for bit`, (lustDone?.numbers ?? 0) > 5000 && JSON.stringify(lustDone) === JSON.stringify(rustcDone), { lust: lustDone, rustc: rustcDone });
    const rows = String(rustcDone?.rows ?? "");
    check("the note's train, the escapements, refusals and clicks read as expected", rows.startsWith("train:49:50/9x54/10x48/9;") && rows.includes("gives 160:1 exactly") && rows.split("graham:ok").length - 1 === 4 && rows.includes("drop of nothing") && rows.includes("friction angle") && rows.split("click:ok").length - 1 === 3, rows);
  }
}

if (failed > 0) {
  console.error(`recipe-horology: ${failed} failed`);
  process.exit(1);
}
console.log("recipe-horology: all passed");
