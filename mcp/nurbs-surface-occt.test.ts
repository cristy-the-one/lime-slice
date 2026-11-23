/**
 * Organic surfaces S6 against real Open CASCADE, through the MCP session as a client sends it: a part that starts from a
 * NURBS surface (solid_new {feature}), thickened, sewn, saved and reopened, and its root edited under a thicken.
 * Same harness as mcp/organic-contract-occt.test.ts (on organic-surfaces/fix-mcp). Synthetic geometry only. Skips
 * without LIME_OCCT_BRIDGE; fails in CI when it is unset.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";
import { bicubicGrid, evalNurbsSurface3D, type Vec3 } from "../src/modeling/nurbs-eval.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("nurbs-surface-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("nurbs-surface-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-s6-occt-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "180";

let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  failures.push(name);
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Record<string, any>;
type V3 = [number, number, number];
interface SolidView { volumeMm3: number; editable: boolean; bounds: { min: V3; max: V3 }; faces: unknown[] }

const engine = loadEngineWorker(root);
let session = new Session(engine);
async function call(name: string, args: unknown): Promise<Reply> {
  try {
    return (await session.call(name, args)) as Reply;
  } catch (err) {
    return { ok: false, reason: `threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}
const solidOf = (object: string): SolidView | undefined => (session as unknown as { find(id: string): { solid?: SolidView } | undefined }).find(object)?.solid;
const why = (reply: Reply) => JSON.stringify(reply.failed?.reason ?? reply.reason ?? reply.error ?? reply).slice(0, 400);
const near = (actual: number | undefined, want: number, tol: number) => actual !== undefined && Number.isFinite(actual) && Math.abs(actual - want) <= tol;
const rel = (actual: number | undefined, want: number, fraction: number) => near(actual, want, Math.abs(want) * fraction);
async function apply(object: string, op: unknown): Promise<{ reply: Reply; solid?: SolidView }> {
  const reply = await call("model_apply", { object, op, probe: true });
  return { reply, solid: reply.ok === true ? solidOf(object) : undefined };
}
async function testCase(name: string, body: () => Promise<void>) {
  try {
    await body();
  } catch (err) {
    check(name, false, `threw ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
}

/**
 * The volume between a surface z(u, v) and z = 0, ∫∫ z dx dy, from the TS evaluator (which matches the kernel's
 * Geom_BSplineSurface within 1e-6 mm, mcp/nurbs-parity-occt.test.ts): the projected area of each small quad times its
 * mean height, on a grid fine enough that the sum is within 1e-5 of the integral.
 */
function volumeUnder(poles: Vec3[][], steps = 400): number {
  const at = (i: number, j: number) => evalNurbsSurface3D({ poles }, i / steps, j / steps).point;
  const rows: Vec3[][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const row: Vec3[] = [];
    for (let j = 0; j <= steps; j += 1) row.push(at(i, j));
    rows.push(row);
  }
  let total = 0;
  for (let i = 0; i < steps; i += 1) {
    for (let j = 0; j < steps; j += 1) {
      const quad = [rows[i]![j]!, rows[i + 1]![j]!, rows[i + 1]![j + 1]!, rows[i]![j + 1]!];
      let twice = 0;
      for (let k = 0; k < 4; k += 1) twice += quad[k]![0] * quad[(k + 1) % 4]![1] - quad[(k + 1) % 4]![0] * quad[k]![1];
      total += (Math.abs(twice) / 2) * ((quad[0]![2] + quad[1]![2] + quad[2]![2] + quad[3]![2]) / 4);
    }
  }
  return total;
}

const flat = bicubicGrid(8, 8); // 70 × 70 mm at z = 0, poles 10 mm apart
/** A 30 mm bicubic dome: its rim is flat at z = 0, its four inner poles 6 mm up. */
const dome: Vec3[][] = [-15, -5, 5, 15].map((x, iu) => [-15, -5, 5, 15].map((y, iv) => [x, y, iu > 0 && iu < 3 && iv > 0 && iv < 3 ? 6 : 0] as Vec3));

try {
  check("Open CASCADE is loaded", (await engine.occt()) === true);

  let flatObject = "";
  await testCase("an 8 × 8 bicubic root is a 70 mm open sheet with 4 open edges", async () => {
    const made = await call("solid_new", { feature: { kind: "nurbsSurface", poles: flat }, name: "flat" });
    flatObject = typeof made.object === "string" ? made.object : "";
    const solid = flatObject ? solidOf(flatObject) : undefined;
    check(
      "an 8 × 8 bicubic root is a 70 mm open sheet with 4 open edges",
      made.ok === true && made.root === "nurbsSurface" && made.openEdges === 4 && solid?.editable === false
        && near(solid?.bounds.min[0], -35, 0.05) && near(solid?.bounds.max[0], 35, 0.05) && near(solid?.bounds.min[1], -35, 0.05) && near(solid?.bounds.max[1], 35, 0.05)
        && near(solid?.bounds.max[2], 0, 1e-6) && near(solid?.bounds.min[2], 0, 1e-6),
      `${JSON.stringify({ openEdges: made.openEdges, editable: solid?.editable, bounds: solid?.bounds })}; ${why(made)}`,
    );
  });

  await testCase("thickened 2 mm it is a 70 × 70 × 2 solid, 9800 mm³", async () => {
    if (!flatObject) throw new Error("no flat surface");
    const { reply, solid } = await apply(flatObject, { kind: "thicken", thickness: 2, direction: "normal" });
    // The box itself is checked by its bounds: a clamped bicubic's border runs through its corner poles, so the sheet is
    // exactly ±35 mm, and the wall exactly 2 mm. Mesh corners are B-rep vertices, kept in float32 (35 to about 4e-6).
    // The volume is the kernel's BRepGProp integral over NURBS faces: on CI it read 9799.866507, 1.4e-5 under 9800,
    // so it is held to 1e-4 relative. A wall that missed the box would fail the bounds, not hide in that tolerance.
    const box = solid?.bounds;
    const exact = (value: number | undefined, want: number) => near(value, want, 1e-5);
    check(
      "thickened 2 mm it is a 70 × 70 × 2 solid, 9800 mm³",
      reply.ok === true && solid?.editable === true && rel(solid?.volumeMm3, 9800, 1e-4)
        && exact(box?.min[0], -35) && exact(box?.max[0], 35) && exact(box?.min[1], -35) && exact(box?.max[1], 35) && exact(box?.min[2], 0) && exact(box?.max[2], 2),
      `volume ${solid?.volumeMm3}; bounds ${JSON.stringify(box)}; ${why(reply)}`,
    );
  });

  await testCase("editing the root's grid under the thicken raises the solid's top", async () => {
    if (!flatObject) throw new Error("no flat surface");
    const raised = flat.map((row, iu) => row.map((pole, iv) => (iu === 3 && iv === 3 ? [pole[0], pole[1], 9] : pole) as Vec3));
    const edited = await call("model_edit", { object: flatObject, node: "node_0", op: { kind: "nurbsSurface", poles: raised } });
    const solid = solidOf(flatObject);
    // The thicken replayed on the raised grid: a 2 mm wall that follows the bump, so its top passes 2 mm (the flat
    // wall's) and its volume grows with the surface's area.
    check(
      "editing the root's grid under the thicken raises the solid's top",
      edited.ok === true && edited.current === "node_1" && solid?.editable === true && (solid?.bounds.max[2] ?? 0) > 3 && (solid?.volumeMm3 ?? 0) > 9800 + 1
        && rel(edited.volumeMm3, solid?.volumeMm3 ?? NaN, 1e-9),
      `current ${edited.current} top ${solid?.bounds.max[2]} volume ${solid?.volumeMm3} (reply ${edited.volumeMm3}); ${why(edited)}`,
    );
  });

  await testCase("a dome sewn shut on its flat rim holds the volume under it", async () => {
    const made = await call("solid_new", { feature: { kind: "nurbsSurface", poles: dome }, name: "dome" });
    if (made.ok !== true) throw new Error(why(made));
    const { reply, solid } = await apply(made.object, { kind: "sew", tolerance: 0.01, capPlanar: true, makeSolid: true });
    const want = volumeUnder(dome);
    check(
      "a dome sewn shut on its flat rim holds the volume under it",
      made.openEdges === 4 && reply.ok === true && solid?.editable === true && rel(solid?.volumeMm3, want, 1e-3),
      `volume ${solid?.volumeMm3} want ${want}; ${why(reply)}`,
    );
  });

  await testCase("saved and reopened, the thickened surface part keeps its root and its solid", async () => {
    if (!flatObject) throw new Error("no flat surface");
    const before = solidOf(flatObject)?.volumeMm3;
    const saved = await call("project_save", { name: "s6-surface.lime" });
    session = new Session(engine);
    const opened = await call("project_open", { path: String(saved.path) });
    const rows = (opened.objects ?? []) as { object?: string; id?: string; name?: string }[];
    const row = rows.find((one) => one.name === "flat");
    const id = row?.object ?? row?.id ?? "";
    const obj = (session as unknown as { find(id: string): { tree?: { root: { kind: string; op?: { kind?: string } } }; solid?: SolidView } | undefined }).find(id);
    check(
      "saved and reopened, the thickened surface part keeps its root and its solid",
      saved.ok === true && opened.ok === true && obj?.tree?.root.kind === "feature" && obj.tree.root.op?.kind === "nurbsSurface" && rel(obj.solid?.volumeMm3, before ?? NaN, 1e-6),
      `root ${JSON.stringify(obj?.tree?.root.kind)} ${obj?.tree?.root.op?.kind}; volume ${obj?.solid?.volumeMm3} want ${before}; ${why(saved)} ${why(opened)}`,
    );
  });
} catch (error) {
  failed += 1;
  console.error(`FAIL nurbs-surface-occt threw ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
if (failed > 0) {
  console.error(`nurbs-surface-occt: ${failed} failed: ${failures.join(" | ")}`);
  process.exit(1);
}
console.log("nurbs-surface-occt: ok");
process.exit(0);
