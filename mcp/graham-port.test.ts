/**
 * src/graham.ts against lime_recipe::horology (docs/plan-hinge-dynamics.md, section 2): a recipe built by lust prints
 * horology's Graham numbers (pivot distance, both pallets, pallet thickness, rest pose, the anchor's and the wheel's
 * outline points, the wheel's arcs at 2.9 degrees) for four escapements and its refusals for six bad ones; the TypeScript port must give the same
 * numbers to 1e-9 mm (the crate computes its trig its own way) and the same sentences. Skips without lust;
 * LIME_RECIPE_REQUIRED=1 makes that a failure.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { findLust, RecipeHost, type RecipeCallSite, type RecipeReply } from "./recipe.ts";
import { anchorOutline, escapeWheel, graham, grahamRefusal, layout, outlinePoints, pivotDistance, restPose, wheelOutline, type Graham } from "../src/graham.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") { console.error("graham-port: lust is required here (LIME_LUST)"); process.exit(1); }
  console.log("graham-port: skipped (set LIME_LUST to a lust build)");
  process.exit(0);
}

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) { console.log(`ok   ${name}`); return; }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`);
}

const CASES: [number, number, number, number, number][] = [[30, 22.5, 17.5, 12, 7.5], [30, 22.5, 18, 10, 8.5], [40, 30, 25, 14, 10.5], [24, 15, 11, 12, 6.5]];
const source = `use lime_recipe::{ops, Json, Session};
use lime_recipe::horology::*;

fn push(out: &mut Vec<String>, v: f64) {
    out.push(format!("{}", v));
}
fn pts(out: &mut Vec<String>, p: &[[f64; 2]]) {
    for q in p.iter() {
        push(out, q[0]);
        push(out, q[1]);
    }
}

fn main() {
    let mut s = Session::start();
    let part = s.solid_new(ops::cuboid(10.0, 10.0, 4.0)).unwrap();
    let mut rows: Vec<String> = Vec::new();
    for (teeth, tip, root, lean, span) in [${CASES.map((c) => `(${c[0]}u32, ${c[1].toFixed(1)}, ${c[2].toFixed(1)}, ${c[3].toFixed(1)}, ${c[4].toFixed(1)})`).join(", ")}] {
        let g = Graham::new(EscapeWheel::new(teeth, tip, root, lean), span);
        let mut out: Vec<String> = Vec::new();
        push(&mut out, g.pivot_distance());
        let (e, x) = g.pallets().unwrap();
        pts(&mut out, &[e.locking_corner, e.letoff_corner, e.face_end, x.locking_corner, x.letoff_corner, x.face_end]);
        push(&mut out, e.locking_radius);
        push(&mut out, x.locking_radius);
        push(&mut out, g.pallet_thickness().unwrap());
        let (phase, deg) = g.rest_pose().unwrap();
        push(&mut out, phase);
        push(&mut out, deg);
        pts(&mut out, &g.anchor_points(1.0).unwrap());
        pts(&mut out, &outline_points(&g.wheel.outline(phase).unwrap(), 2.9));
        rows.push(out.join(","));
    }
    let g = Graham::new(EscapeWheel::new(30, 22.5, 17.5, 12.0), 7.5);
    for refused in [g.drop(0.0), g.drop(6.0), g.impulse(8.0).friction(0.6), g.hub_radius(9.5), Graham::new(EscapeWheel::new(30, 22.5, 21.5, 12.0), 7.5), Graham::new(EscapeWheel::new(30, 22.5, 17.5, 12.0), 7.0)] {
        rows.push(refused.refusal().unwrap_or_default());
    }
    s.done_with(&part, Json::obj().set("rows", rows.join(";")));
}
`;

const dir = mkdtempSync(join(tmpdir(), "lime-graham-port-"));
const host = new RecipeHost({ crateDir: join(root, "crates", "lime-recipe"), root: join(dir, "host"), lust });
const built = await host.build("graham_port", source, false);
check("lust builds the Graham numbers recipe", built.ok, built.diagnostics.length ? built.diagnostics : built.reason);
if (built.ok) {
  const stub = async (site: RecipeCallSite): Promise<RecipeReply> => (site.tool === "solid_new" ? { ok: true, result: { ok: true, object: "obj_1" } } : { ok: true, result: { ok: true } });
  const run = await host.run(built.exe!, { params: {}, context: { units: "mm" } }, stub);
  check("the recipe runs to done", run.ok, run.reason ?? run.stderr);
  const rows = String((run.done?.metrics as { rows?: string } | undefined)?.rows ?? "").split(";");
  const base = (c: [number, number, number, number, number]): Graham => graham(escapeWheel(c[0], c[1], c[2], c[3]), c[4]);
  for (const [i, c] of CASES.entries()) {
    const crate = rows[i]!.split(",").map(Number);
    const g = base(c);
    const l = layout(g);
    const anchor = anchorOutline(g);
    const rest = restPose(g);
    if ("reason" in l || "reason" in anchor || "reason" in rest) { check(`port builds ${c.join("/")}`, false, l); continue; }
    const wheel = wheelOutline(g.wheel, rest[0]);
    if ("reason" in wheel) { check("port wheel", false, wheel); continue; }
    const mine: number[] = [pivotDistance(g)];
    for (const p of [l.entry.lockingCorner, l.entry.letoffCorner, l.entry.faceEnd, l.exit.lockingCorner, l.exit.letoffCorner, l.exit.faceEnd]) mine.push(p[0], p[1]);
    mine.push(l.entry.lockingRadius, l.exit.lockingRadius, l.rhoOut - l.rhoIn, rest[0], rest[1]);
    for (const p of outlinePoints(anchor, 1)) mine.push(p[0], p[1]);
    // 2.9 degrees: a 3 degree step ties on a 6 degree root arc, and rounding then picks the point count.
    for (const p of outlinePoints(wheel, 2.9)) mine.push(p[0], p[1]);
    let worst = 0;
    const bad = mine.flatMap((v, k) => (Math.abs(v - (crate[k] ?? NaN)) > 1e-9 ? [[k, v, crate[k]]] : [])).slice(0, 6);
    if (bad.length) console.log("differ at", JSON.stringify(bad));
    for (let k = 0; k < Math.max(mine.length, crate.length); k += 1) worst = Math.max(worst, Math.abs((mine[k] ?? NaN) - (crate[k] ?? NaN)));
    check(`${c[0]} teeth, tip ${c[1]}, span ${c[4]}: ${crate.length} numbers, the port's within ${worst.toExponential(1)} of horology's (< 1e-9)`, mine.length === crate.length && worst < 1e-9, { mine: mine.length, crate: crate.length, worst });
  }
  const g = base([30, 22.5, 17.5, 12, 7.5]);
  const bad: Graham[] = [{ ...g, dropDeg: 0 }, { ...g, dropDeg: 6 }, { ...g, impulseDeg: 8, friction: 0.6 }, { ...g, hubRadius: 9.5 }, base([30, 22.5, 21.5, 12, 7.5]), base([30, 22.5, 17.5, 12, 7])];
  bad.forEach((one, k) => check(`refusal ${k + 1} in horology's words: "${rows[CASES.length + k]}"`, grahamRefusal(one) === rows[CASES.length + k] && !!rows[CASES.length + k], grahamRefusal(one)));
}

if (failed > 0) { console.error(`graham-port: ${failed} failed`); process.exit(1); }
console.log("graham-port: all passed");
process.exit(0);
