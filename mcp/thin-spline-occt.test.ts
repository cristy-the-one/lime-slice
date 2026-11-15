/**
 * docs/plan-mcp-reliability.md, item 3, against Open CASCADE. A window cut through a plate as one closed spline (a
 * spline segment that ends where it starts, as recipes' spline_loop made the clock's windows) and the same window as a
 * polyline: model_check {minWallMm} finds no thin wall in either. The kernel builds a closed spline as one periodic
 * curve, smooth through its start, so there is no corner at the seam to find. What the scan used to read was the mesh:
 * near the rims, the spline wall is meshed with facets that lean off vertical, and a ray from one meets the cap beside
 * it. The scan counted that as a knife edge; it now counts only a far face that turns back toward the near one. The
 * readings the old rule gives on this mesh are printed, so the log shows whether this plate reproduces them.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { thinWalls } from "../src/modeling/thin.ts";
import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("thin-spline-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("thin-spline-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-thin-spline-"));
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "25";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail.slice(0, 1500)}` : ""}`);
}
type Reply = Record<string, unknown>;
const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Reply;
await call("project_create", {});

/** A rounded rectangle about (cx, cy), `w` by `h`, corners of radius `r`, as a closed polygon of short steps. */
function rounded(cx: number, cy: number, w: number, h: number, r: number): [number, number][] {
  const out: [number, number][] = [];
  const corners: [number, number, number][] = [[cx + w / 2 - r, cy - h / 2 + r, -90], [cx + w / 2 - r, cy + h / 2 - r, 0], [cx - w / 2 + r, cy + h / 2 - r, 90], [cx - w / 2 + r, cy - h / 2 + r, 180]];
  for (const [x, y, from] of corners) for (let k = 0; k <= 8; k += 1) {
    const a = ((from + (90 * k) / 8) * Math.PI) / 180;
    out.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
  }
  return out;
}

/** The polygon resampled every `spacing` mm along its length, as the clock's spline_loop did. */
function resample(poly: [number, number][], spacing: number): [number, number][] {
  const lengths = poly.map((p, i) => Math.hypot(poly[(i + 1) % poly.length]![0] - p[0], poly[(i + 1) % poly.length]![1] - p[1]));
  const perimeter = lengths.reduce((sum, l) => sum + l, 0);
  const n = Math.max(8, Math.min(180, Math.round(perimeter / spacing)));
  const step = perimeter / n;
  const out: [number, number][] = [];
  let acc = 0, want = 0;
  for (let i = 0; i < poly.length && out.length < n; i += 1) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!, l = lengths[i]!;
    while (want < acc + l && out.length < n) {
      const t = (want - acc) / l;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      want += step;
    }
    acc += l;
  }
  return out;
}

const plate = async (name: string, loop: Reply): Promise<string> => {
  const made = await call("solid_new", { primitive: "box", dx: 60, dy: 40, dz: 4, name });
  if (made.ok !== true) throw new Error(JSON.stringify(made));
  const object = String(made.object);
  const box = session.find(object)!.solid!.bounds;
  const cx = (box.min[0] + box.max[0]) / 2, cy = (box.min[1] + box.max[1]) / 2;
  const shifted = JSON.parse(JSON.stringify(loop, (_key, value) => (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number") ? [value[0] + cx, value[1] + cy] : value)));
  const cut = await call("model_apply", { object, op: { kind: "extrude", op: "cut", origin: [0, 0, box.min[2] - 0.5], depth: box.max[2] - box.min[2] + 1, loops: [shifted], label: "window" }, probe: true });
  if (cut.ok !== true) throw new Error(`${name}: ${JSON.stringify(cut)}`);
  return object;
};

const points = resample(rounded(0, 0, 44, 26, 5), 1);
const splineLoop = { start: points[0], segments: [{ kind: "spline", through: points.slice(1), to: points[0] }] };
const polyLoop = { start: points[0], segments: points.slice(1).concat([points[0]!]).map((to) => ({ kind: "line", to })) };
const spline = await plate("spline window", splineLoop);
const poly = await plate("polyline window", polyLoop);

for (const [name, object] of [["spline", spline], ["polyline", poly]] as const) {
  const checked = await call("model_check", { object, minWallMm: 0.8 });
  const walls = checked.thinWalls as { regions?: unknown[]; areaMm2?: number } | undefined;
  check(`the ${name} window leaves no wall thinner than 0.8 mm`, checked.ok !== false && Array.isArray(walls?.regions) && walls.regions.length === 0, JSON.stringify(walls));
  const positions = session.find(object)!.solid!.positions;
  const old = thinWalls(positions, 0.8, 6000, { facingDeg: 180 });
  console.log(`  ${name}: ${positions.length / 9} triangles; counting every face, the scan reads ${old.regions.length} regions, ${old.areaMm2} mm², thinnest ${old.regions.length ? Math.min(...old.regions.map((row) => row.thinnestMm)) : "none"} mm`);
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("thin-spline-occt: ok");
process.exit(0);
