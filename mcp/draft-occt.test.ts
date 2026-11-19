/**
 * Draft on existing faces against real Open CASCADE.
 * A synthetic box only. Skips without LIME_OCCT_BRIDGE; fails in CI when it is unset.
 * Runs on the folded-shell job so the shared Open CASCADE job stays inside its limit.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("draft-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("draft-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-draft-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "180";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Record<string, any>;
type V3 = [number, number, number];
const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Reply;
interface Held {
  solid?: { volumeMm3: number };
}
const volumeOf = (object: string) => (session as unknown as { find(id: string): Held | undefined }).find(object)?.solid?.volumeMm3;

/** Four side walls of a 40 × 30 × h box, drafted `angle` degrees about the bottom, pull +Z. */
function frustum(h: number, angleDeg: number): { volume: number; top: number } {
  const shrink = 2 * h * Math.tan((angleDeg * Math.PI) / 180);
  const topW = 40 - shrink;
  const topD = 30 - shrink;
  const bottom = 40 * 30;
  const top = topW * topD;
  return { volume: (h / 3) * (bottom + top + Math.sqrt(bottom * top)), top };
}

function close(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-6 * Math.abs(expected);
}

async function wallsOf(object: string): Promise<{ normal: V3; nearPoint: V3 }[]> {
  const selectors: { normal: V3; nearPoint: V3 }[] = [];
  for (const normal of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]] as V3[]) {
    const found = await call("faces_find", { object, normal, bbox: true, limit: 4 });
    const face = (found.faces ?? [])[0];
    const box = face?.bbox as { min?: number[]; max?: number[] } | undefined;
    if (!box?.min || !box.max) throw new Error(`no wall ${normal}: ${JSON.stringify(found).slice(0, 300)}`);
    selectors.push({ normal, nearPoint: [0, 1, 2].map((axis) => (box.min![axis]! + box.max![axis]!) / 2) as V3 });
  }
  return selectors;
}

async function topArea(object: string): Promise<number> {
  const found = await call("faces_find", { object, normal: [0, 0, 1], limit: 2 });
  const area = found.faces?.[0]?.areaMm2;
  if (typeof area !== "number") throw new Error(`no top: ${JSON.stringify(found).slice(0, 300)}`);
  return area;
}

try {
  const bare = await call("model_build", { name: "bare", base: { primitive: "box", dx: 40, dy: 30, dz: 20 }, ops: [] });
  check("a bare box builds", bare.ok === true && typeof bare.object === "string", JSON.stringify(bare).slice(0, 300));
  const walls = await wallsOf(bare.object);
  const draft = { kind: "draft", faces: walls, angleDeg: 3 };
  const built = await call("model_build", { name: "mould", base: { primitive: "box", dx: 40, dy: 30, dz: 20 }, ops: [draft] });
  const want = frustum(20, 3);
  const builtVolume = volumeOf(built.object);
  check(
    "four walls at 3° match the frustum",
    built.ok === true && builtVolume !== undefined && close(builtVolume, want.volume) && close(await topArea(built.object), want.top),
    `volume ${builtVolume} want ${want.volume}; top want ${want.top}; ${JSON.stringify(built.reason ?? "").slice(0, 200)}`,
  );

  const grown = await call("model_build", { name: "grown", base: { primitive: "box", dx: 40, dy: 30, dz: 20 }, ops: [{ ...draft, angleDeg: -3 }] });
  const wantGrown = frustum(20, -3);
  const grownVolume = volumeOf(grown.object);
  check(
    "minus 3° grows the top by the same frustum",
    grown.ok === true && grownVolume !== undefined && close(grownVolume, wantGrown.volume) && close(await topArea(grown.object), wantGrown.top),
    `volume ${grownVolume} want ${wantGrown.volume}`,
  );

  const taller = await call("model_build", { name: "taller", base: { primitive: "box", dx: 40, dy: 30, dz: 25 }, ops: [draft] });
  const wantTall = frustum(25, 3);
  const tallVolume = volumeOf(taller.object);
  check(
    "the same wall picks draft a taller box",
    taller.ok === true && tallVolume !== undefined && close(tallVolume, wantTall.volume),
    `volume ${tallVolume} want ${wantTall.volume}; ${JSON.stringify(taller.reason ?? "").slice(0, 200)}`,
  );

  const floor = await call("model_apply", { object: bare.object, op: { kind: "draft", faces: [{ normal: [0, 0, 1], nearPoint: [0, 0, 20] }], angleDeg: 3 } });
  check(
    "a floor is refused and the box is unchanged",
    floor.ok === false && String(floor.reason).includes("Face 0") && String(floor.reason).includes("floor") && close(volumeOf(bare.object) ?? NaN, 40 * 30 * 20),
    JSON.stringify(floor).slice(0, 300),
  );
  const mixed = await call("model_apply", {
    object: bare.object,
    op: { kind: "draft", faces: [walls[0], { normal: [0, 0, 1], nearPoint: [0, 0, 20] }, walls[2]], angleDeg: 3 },
  });
  check(
    "one bad face refuses that index",
    mixed.ok === false && String(mixed.reason).includes("Face 1") && close(volumeOf(bare.object) ?? NaN, 40 * 30 * 20),
    JSON.stringify(mixed).slice(0, 300),
  );
} catch (error) {
  failed += 1;
  console.error(`FAIL draft threw ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
if (failed > 0) {
  console.error(`draft-occt: ${failed} failed`);
  process.exit(1);
}
console.log("draft-occt: ok");
process.exit(0);
