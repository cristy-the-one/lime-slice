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

/**
 * Four side walls of a 40 × 30 × h box, drafted `angleDeg` about the bottom, pull +Z.
 * At height z the section loses `2 z tan` on every side. The top is not a scaled copy of the
 * bottom, so the volume is the integral of that rectangle.
 */
function draftedBox(h: number, angleDeg: number): { volume: number; top: number } {
  const t = Math.tan((angleDeg * Math.PI) / 180);
  const top = (40 - 2 * h * t) * (30 - 2 * h * t);
  const volume = 40 * 30 * h - (40 + 30) * h * h * t + (4 / 3) * h * h * h * t * t;
  return { volume, top };
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

async function flatFace(object: string, normal: V3): Promise<{ index: number; areaMm2: number; min: V3; max: V3 }> {
  const found = await call("faces_find", { object, normal, bbox: true, limit: 2 });
  const face = found.faces?.[0];
  const box = face?.bbox as { min?: V3; max?: V3 } | undefined;
  if (typeof face?.index !== "number" || typeof face.areaMm2 !== "number" || !box?.min || !box.max) {
    throw new Error(`no face ${normal}: ${JSON.stringify(found).slice(0, 300)}`);
  }
  return { index: face.index, areaMm2: face.areaMm2, min: box.min, max: box.max };
}

async function topArea(object: string): Promise<number> {
  return (await flatFace(object, [0, 0, 1])).areaMm2;
}

async function bottomArea(object: string): Promise<number> {
  return (await flatFace(object, [0, 0, -1])).areaMm2;
}

try {
  const bare = await call("model_build", { name: "bare", base: { primitive: "box", dx: 40, dy: 30, dz: 20 }, ops: [] });
  check("a bare box builds", bare.ok === true && typeof bare.object === "string", JSON.stringify(bare).slice(0, 300));
  const walls = await wallsOf(bare.object);
  const draft = { kind: "draft", faces: walls, angleDeg: 3 };
  const built = await call("model_build", { name: "mould", base: { primitive: "box", dx: 40, dy: 30, dz: 20 }, ops: [draft] });
  const want = draftedBox(20, 3);
  const builtVolume = volumeOf(built.object);
  check(
    "four walls at 3° match the frustum",
    built.ok === true && builtVolume !== undefined && close(builtVolume, want.volume) && close(await topArea(built.object), want.top),
    `volume ${builtVolume} want ${want.volume}; top want ${want.top}; ${JSON.stringify(built.reason ?? "").slice(0, 200)}`,
  );

  const grown = await call("model_build", { name: "grown", base: { primitive: "box", dx: 40, dy: 30, dz: 20 }, ops: [{ ...draft, angleDeg: -3 }] });
  const wantGrown = draftedBox(20, -3);
  const grownVolume = volumeOf(grown.object);
  check(
    "minus 3° grows the top by the same frustum",
    grown.ok === true && grownVolume !== undefined && close(grownVolume, wantGrown.volume) && close(await topArea(grown.object), wantGrown.top),
    `volume ${grownVolume} want ${wantGrown.volume}`,
  );

  const taller = await call("model_build", { name: "taller", base: { primitive: "box", dx: 40, dy: 30, dz: 25 }, ops: [draft] });
  const wantTall = draftedBox(25, 3);
  const tallVolume = volumeOf(taller.object);
  check(
    "the same wall picks draft a taller box",
    taller.ok === true && tallVolume !== undefined && close(tallVolume, wantTall.volume),
    `volume ${tallVolume} want ${wantTall.volume}; ${JSON.stringify(taller.reason ?? "").slice(0, 200)}`,
  );

  // A refusal names the face by its index on the solid, as faces_find lists it, not by its place in the list.
  const top = await flatFace(bare.object, [0, 0, 1]);
  const floor = await call("model_apply", { object: bare.object, probe: true, op: { kind: "draft", faces: [{ normal: [0, 0, 1], nearPoint: [0, 0, 20] }], angleDeg: 3 } });
  check(
    "a floor is refused by its index and the box is unchanged",
    floor.ok === false && String(floor.reason).includes(`Face ${top.index} is a floor`) && close(volumeOf(bare.object) ?? NaN, 40 * 30 * 20),
    `top is face ${top.index}: ${JSON.stringify(floor).slice(0, 300)}`,
  );
  const mixed = await call("model_apply", {
    object: bare.object,
    probe: true,
    op: { kind: "draft", faces: [walls[0], { normal: [0, 0, 1], nearPoint: [0, 0, 20] }, walls[2]], angleDeg: 3 },
  });
  check(
    "one bad face, second in the list, refuses its own index",
    mixed.ok === false && String(mixed.reason).includes(`Face ${top.index} is a floor`) && close(volumeOf(bare.object) ?? NaN, 40 * 30 * 20),
    `top is face ${top.index}: ${JSON.stringify(mixed).slice(0, 300)}`,
  );
  const twice = await call("model_apply", { object: bare.object, probe: true, op: { kind: "draft", faces: [walls[0], walls[0]], angleDeg: 3 } });
  const east = await call("faces_find", { object: bare.object, normal: [1, 0, 0], limit: 1 });
  check(
    "a face listed twice is named by its index",
    twice.ok === false && String(twice.reason) === `Face ${east.faces?.[0]?.index} is listed twice.`,
    JSON.stringify(twice).slice(0, 300),
  );

  // The +X wall alone, three ways. `t` is tan 3°; the box is 40 wide in X, 30 deep, 20 high.
  const t = Math.tan((3 * Math.PI) / 180);
  const box = await flatFace(bare.object, [1, 0, 0]);
  const midZ = (box.min[2] + box.max[2]) / 2;
  const topZ = box.max[2];
  const one = (name: string, extra: Record<string, unknown>) =>
    call("model_build", { name, base: { primitive: "box", dx: 40, dy: 30, dz: 20 }, ops: [{ kind: "draft", faces: [walls[0]], angleDeg: 3, ...extra }] });

  // About a plane at mid-height the wall removes above what it adds below: the volume stays, the top and bottom do not.
  const mid = await one("mid", { neutral: { origin: [0, 0, midZ], normal: [0, 0, 1] } });
  const midVolume = mid.ok === true ? volumeOf(mid.object) : undefined;
  const midTop = mid.ok === true ? await topArea(mid.object) : NaN;
  const midBottom = mid.ok === true ? await bottomArea(mid.object) : NaN;
  check(
    "a neutral plane at mid-height drafts: same volume, top 40 - 10 tan 3°, bottom 40 + 10 tan 3° wide",
    mid.ok === true && midVolume !== undefined && close(midVolume, 40 * 30 * 20) && close(midTop, 30 * (40 - 10 * t)) && close(midBottom, 30 * (40 + 10 * t)),
    `volume ${midVolume} top ${midTop} want ${30 * (40 - 10 * t)} bottom ${midBottom} want ${30 * (40 + 10 * t)}; ${JSON.stringify(mid.reason ?? "").slice(0, 200)}`,
  );

  // About the top face: the top stays, the bottom grows by 20 tan 3°.
  const aboutTop = await one("about-top", { neutral: { normal: [0, 0, 1], nearPoint: [(top.min[0] + top.max[0]) / 2, (top.min[1] + top.max[1]) / 2, topZ] } });
  const aboutVolume = aboutTop.ok === true ? volumeOf(aboutTop.object) : undefined;
  const aboutTopArea = aboutTop.ok === true ? await topArea(aboutTop.object) : NaN;
  const aboutBottom = aboutTop.ok === true ? await bottomArea(aboutTop.object) : NaN;
  check(
    "a neutral face keeps that face: top 40 wide, bottom 40 + 20 tan 3°",
    aboutTop.ok === true && aboutVolume !== undefined && close(aboutVolume, 40 * 30 * 20 + 6000 * t) && close(aboutTopArea, 30 * 40) && close(aboutBottom, 30 * (40 + 20 * t)),
    `volume ${aboutVolume} want ${40 * 30 * 20 + 6000 * t}; top ${aboutTopArea} bottom ${aboutBottom}; ${JSON.stringify(aboutTop.reason ?? "").slice(0, 200)}`,
  );

  // Pulled down, the wall opens toward the bottom about the top: the bottom loses 20 tan 3°.
  const down = await one("pull-down", { pull: [0, 0, -1] });
  const downVolume = down.ok === true ? volumeOf(down.object) : undefined;
  const downTop = down.ok === true ? await topArea(down.object) : NaN;
  const downBottom = down.ok === true ? await bottomArea(down.object) : NaN;
  check(
    "a pull down drafts about the top: top 40 wide, bottom 40 - 20 tan 3°",
    down.ok === true && downVolume !== undefined && close(downVolume, 40 * 30 * 20 - 6000 * t) && close(downTop, 30 * 40) && close(downBottom, 30 * (40 - 20 * t)),
    `volume ${downVolume} want ${40 * 30 * 20 - 6000 * t}; top ${downTop} bottom ${downBottom}; ${JSON.stringify(down.reason ?? "").slice(0, 200)}`,
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
