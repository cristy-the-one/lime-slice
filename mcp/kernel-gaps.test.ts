/**
 * Kernel gaps from the LED-cover notes (items 8, 12, 13, 14, 17), through the MCP server against real Open CASCADE:
 * rounded pockets and bosses and the wall check, chamfers by two sizes, merged coplanar faces, no sliver faces, fillet
 * edges that survive an edit that moves them, and a project saved by 4.0.0 that still rebuilds to the same volume.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
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
    console.error("kernel-gaps: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("kernel-gaps: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-kernel-gaps-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "25";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}
const near = (value: unknown, expected: number, tol = 1e-3) => typeof value === "number" && Math.abs(value - expected) < tol;

type Row = { index: number; mid: number[]; centre: number[]; areaMm2: number; normal: number[]; lengthMm: number };
const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Record<string, any>;
const volume = async (object: string) => Number((await call("model_describe", { object, limit: 1 })).volumeMm3);
const apply = (object: string, op: Record<string, unknown>) => call("model_apply", { object, probe: true, op });
const roundedArea = (w: number, h: number, r: number) => w * h - (4 - Math.PI) * r * r;

/** A 150 × 60 × 8 cover with its four upright corners rounded r 5. */
async function cover(): Promise<string> {
  const made = await call("solid_new", { primitive: "box", dx: 150, dy: 60, dz: 8 });
  const object = String(made.object);
  const upright = await call("edges_find", { object, direction: [0, 0, 1], limit: 10 });
  await apply(object, { kind: "fillet", edges: (upright.edges as Row[]).map((edge) => edge.index), size: 5 });
  return object;
}

// --- Item 8. A sharp pocket that would leave a 1 mm wall breaks through the r 5 corners: refused, with where, the
// thinnest wall, and the corner radius that keeps the wall. With that radius it applies, as one rounded cut.
{
  const object = await cover();
  const top = await call("faces_find", { object, normal: [0, 0, 1], limit: 1 });
  const face = (top.faces as Row[])[0]!.index;
  const before = await volume(object);
  const sharp = await call("model_apply", { object, op: { kind: "pocket", faceIndex: face, width: 148, height: 58, depth: 4 } });
  const why = String(sharp.failed?.reason ?? sharp.reason ?? "");
  check("a sharp pocket that breaks through the rounded corner is refused", sharp.ok === false && /breaks through the wall of the part near \(/.test(why), JSON.stringify(sharp));
  check("the refusal names the thinnest wall and the corner radius that keeps the wall", /thinnest wall it leaves elsewhere is [\d.]+ mm/.test(why) && /cornerRadius of 4 mm keeps the wall 1 mm thick all round/.test(why), why);
  check("the refused pocket changed nothing", near(await volume(object), before), String(await volume(object)));
  const rounded = await call("model_apply", { object, op: { kind: "pocket", faceIndex: face, width: 148, height: 58, depth: 4, cornerRadius: 4 } });
  check("a pocket with cornerRadius 4 applies", rounded.ok === true, JSON.stringify(rounded));
  check("its volume is the rounded rectangle's", near(await volume(object), before - roundedArea(148, 58, 4) * 4, 0.01), String(await volume(object)));
  const thin = await call("model_check", { object });
  check("it leaves no wall thinner than two nozzle widths", Array.isArray(thin.thinWalls?.regions) && thin.thinWalls.regions.length === 0, JSON.stringify(thin.thinWalls));
  const history = await call("model_history", { object });
  check("the history row names the radius", (history.nodes as { label: string }[]).some((node) => node.label === "Pocket 148 × 58 r 4"), JSON.stringify(history.nodes));
  const tooRound = await call("model_apply", { object, op: { kind: "pocket", faceIndex: face, width: 20, height: 10, depth: 1, cornerRadius: 6 } });
  check("a corner radius over half the shorter side is refused", tooRound.ok === false && /at most half the shorter side, 5 mm/.test(String(tooRound.failed?.reason ?? tooRound.reason)), JSON.stringify(tooRound));
  const arch = await call("model_apply", { object, op: { kind: "pocket", faceIndex: face, shape: "circle", diameter: 6, depth: 1, cornerRadius: 1 } });
  check("only a rect takes a corner radius", arch.ok === false && /Only a rect/.test(String(arch.failed?.reason ?? arch.reason)), JSON.stringify(arch));
  // A rounded boss on the floor: what it adds is its rounded footprint by its height, the 0.2 mm it sinks being solid already.
  const floor = await call("faces_find", { object, normal: [0, 0, 1], nearPoint: [0, 0, 4], limit: 1 });
  const under = await volume(object);
  const boss = await call("model_apply", { object, op: { kind: "boss", faceIndex: (floor.faces as Row[])[0]!.index, at: { u: -30, v: 0 }, width: 20, height: 12, depth: 3, cornerRadius: 3 } });
  check("a boss with cornerRadius 3 applies", boss.ok === true, JSON.stringify(boss));
  check("it adds the rounded rectangle's volume", near(await volume(object), under + roundedArea(20, 12, 3) * 3, 0.01), String((await volume(object)) - under));
}

// --- Item 13. A 20 mm cube's top edge at −Y: 2.7 along the top and 5 down the side, the owner's barb slope.
{
  const made = await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 });
  const object = String(made.object);
  const along = await call("edges_find", { object, direction: [1, 0, 0], limit: 10 });
  const edge = (along.edges as Row[]).find((row) => row.mid[1] === -10 && row.mid[2] === 20)!;
  const probe = await call("model_probe", { object, op: { kind: "chamfer", edges: [edge.index], size: 2.7, size2: 5 } });
  check("a chamfer by two sizes fits", probe.ok === true, JSON.stringify(probe));
  check("the probe says which face takes the first size", /size runs along face \d+ \(normal 0, 0, 1\); flip: true puts it on the other face\./.test(String(probe.reason)) && probe.firstFaces?.[0]?.normal?.join(",") === "0,0,1", JSON.stringify(probe));
  const flipped = await call("model_probe", { object, op: { kind: "chamfer", edges: [edge.index], size: 2.7, size2: 5, flip: true } });
  check("flip puts it on the side", flipped.firstFaces?.[0]?.normal?.join(",") === "0,-1,0", JSON.stringify(flipped.firstFaces));
  const applied = await apply(object, { kind: "chamfer", edges: [edge.index], size: 2.7, size2: 5 });
  check("it applies and takes off ½ · 2.7 · 5 · 20", applied.ok === true && near(await volume(object), 8000 - 135), String(await volume(object)));
  const tops = await call("faces_find", { object, normal: [0, 0, 1], limit: 5 });
  const side = await call("faces_find", { object, normal: [0, -1, 0], limit: 5 });
  check("the top keeps 17.3 of its 20 mm, the side 15", near((tops.faces as Row[])[0]!.areaMm2, 20 * 17.3) && near((side.faces as Row[])[0]!.areaMm2, 20 * 15), JSON.stringify([tops.faces?.[0], side.faces?.[0]]));
  const history = await call("model_history", { object });
  check("the history row names both sizes", (history.nodes as { label: string }[]).some((node) => node.label === "Chamfer 1 edge 2.7 × 5"), JSON.stringify(history.nodes));
  await call("model_undo", { object });
  const angled = await apply(object, { kind: "chamfer", edges: [edge.index], size: 2, angleDeg: 45 });
  check("a distance and an angle: 2 at 45° takes off ½ · 2 · 2 · 20", angled.ok === true && near(await volume(object), 8000 - 40), String(await volume(object)));
  await call("model_undo", { object });
  const both = await call("model_probe", { object, op: { kind: "chamfer", edges: [edge.index], size: 2, size2: 3, angleDeg: 45 } });
  check("size2 and angleDeg together are refused", both.ok === false && /not both/.test(String(both.reason)), JSON.stringify(both));
  const equal = await apply(object, { kind: "chamfer", edges: [edge.index], size: 2 });
  check("equal sides stay the default", equal.ok === true && near(await volume(object), 8000 - 40), String(await volume(object)));
}

// --- Item 14. A boolean flush with the part leaves one top face, and a chamfer runs the whole edge across where the
// seam was. A boss flush with a rim leaves one top face with it.
{
  const made = await call("solid_new", { primitive: "box", dx: 40, dy: 20, dz: 10 });
  const object = String(made.object);
  const fused = await apply(object, { kind: "boolean", op: "fuse", primitive: "box", origin: [-20, 10, 0], dx: 40, dy: 20, dz: 10 });
  check("a flush fuse applies", fused.ok === true, JSON.stringify(fused));
  const ups = await call("faces_find", { object, normal: [0, 0, 1], limit: 10 });
  check("its top is one face", (ups.faces as Row[]).length === 1 && near((ups.faces as Row[])[0]!.areaMm2, 1600), JSON.stringify(ups.faces));
  const long = await call("edges_find", { object, direction: [0, 1, 0], lengthMinMm: 39.9, limit: 10 });
  const edge = (long.edges as Row[]).find((row) => row.mid[0] === 20 && row.mid[2] === 10);
  check("the edge along the old seam is one 40 mm edge", !!edge && near(edge.lengthMm, 40), JSON.stringify(long.edges));
  const chamfer = edge ? await apply(object, { kind: "chamfer", edges: [edge.index], size: 2 }) : { ok: false };
  check("a chamfer runs the whole 40 mm", chamfer.ok === true && near(await volume(object), 16000 - 0.5 * 2 * 2 * 40), String(await volume(object)));

  const rim = await call("solid_new", { primitive: "box", dx: 60, dy: 40, dz: 10 });
  const rimId = String(rim.object);
  const top = await call("faces_find", { object: rimId, normal: [0, 0, 1], limit: 1 });
  await call("model_apply", { object: rimId, op: { kind: "pocket", faceIndex: (top.faces as Row[])[0]!.index, width: 40, height: 20, depth: 4 } });
  const floor = await call("faces_find", { object: rimId, normal: [0, 0, 1], nearPoint: [0, 0, 6], limit: 1 });
  const pad = await call("model_apply", { object: rimId, op: { kind: "boss", faceIndex: (floor.faces as Row[])[0]!.index, width: 40, height: 6, depth: 4 } });
  check("a pad flush with the rim applies", pad.ok === true, JSON.stringify(pad));
  const level = await call("faces_find", { object: rimId, normal: [0, 0, 1], limit: 10 });
  const atTop = (level.faces as Row[]).filter((face) => near(face.centre[2], 10, 1e-6));
  check("the rim top and the pad top are one face", atTop.length === 1 && near(atTop[0]!.areaMm2, 2400 - 800 + 240), JSON.stringify(level.faces));
}

// --- Item 17. A pad on the pocket floor out to the outside wall, sunk 0.2 mm as a boss is: no sliver faces, and the
// outside wall stays one face.
{
  const object = await cover();
  const top = await call("faces_find", { object, normal: [0, 0, 1], limit: 1 });
  await call("model_apply", { object, op: { kind: "pocket", faceIndex: (top.faces as Row[])[0]!.index, width: 148, height: 58, depth: 4, cornerRadius: 4 } });
  const floor = await call("faces_find", { object, normal: [0, 0, 1], nearPoint: [0, 0, 4], limit: 1 });
  const pad = await call("model_apply", { object, op: { kind: "boss", faceIndex: (floor.faces as Row[])[0]!.index, from: "corner", at: { u: 144, v: 19 }, width: 8, height: 20, depth: 4 } });
  check("a pad out to the outside wall applies", pad.ok === true, JSON.stringify(pad));
  const all = await call("faces_find", { object, limit: 100 });
  const tiny = (all.faces as Row[]).filter((face) => face.areaMm2 < 1);
  check("no face is under 1 mm²", tiny.length === 0, JSON.stringify(tiny));
  const outside = await call("faces_find", { object, normal: [1, 0, 0], limit: 10 });
  const wall = (outside.faces as Row[]).filter((face) => near(face.centre[0], 75, 1e-6));
  check("the outside wall at +X is one face", wall.length === 1, JSON.stringify(outside.faces));
}

// --- Item 12. A fillet on the corner a fuse made, then the fuse made 10 mm longer: the same corner is filleted, where
// it moved to.
{
  const made = await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 10 });
  const object = String(made.object);
  const longer = (dx: number) => ({ kind: "boolean", op: "fuse", primitive: "box", origin: [5, -10, 0], dx, dy: 20, dz: 10 });
  await apply(object, longer(15));
  const upright = await call("edges_find", { object, direction: [0, 0, 1], limit: 10 });
  const corner = (upright.edges as Row[]).find((edge) => edge.mid[0] === 20 && edge.mid[1] === -10)!;
  const roundOff = 10 * 4 * (1 - Math.PI / 4);
  const fillet = await apply(object, { kind: "fillet", edges: [corner.index], size: 2 });
  check("the corner is filleted", fillet.ok === true && near(await volume(object), 30 * 20 * 10 - roundOff), String(await volume(object)));
  const probe = await call("model_probe", { object, node: "node_1", op: longer(25) });
  const edited = probe.ok === true ? await call("model_edit", { object, node: "node_1", op: longer(25) }) : probe;
  check("the fuse is edited and the fillet replayed", edited.ok === true && edited.broken === false, JSON.stringify(edited));
  check("the same corner is filleted, 10 mm further out", near(await volume(object), 40 * 20 * 10 - roundOff), String(await volume(object)));
  const after = await call("edges_find", { object, direction: [0, 0, 1], limit: 10 });
  const sharp = (after.edges as Row[]).map((edge) => edge.mid.slice(0, 2).join(","));
  check("the other three corners stay sharp", ["-10,-10", "-10,10", "30,10"].every((at) => sharp.includes(at)) && !sharp.includes("30,-10"), JSON.stringify(sharp));
}

// --- A project saved by 4.0.0, with fillets, a chamfer, a pocket and a boss stored as they were then: opened and
// rebuilt from its first step, it comes to the same volume.
{
  const saved = join(workspace, "model-4.0.0-fillets.lime");
  copyFileSync(fileURLToPath(new URL("../samples/model-4.0.0-fillets.lime", import.meta.url)), saved);
  const opened = await call("project_open", { path: saved });
  check("the 4.0.0 project opens", opened.ok === true, JSON.stringify(opened));
  const object = String((await call("plate_list", {})).objects?.[0]?.object ?? "");
  // Each step's volume as the 4.0.0 server and engine built it, read with model_goto there. Each step not held is
  // replayed from the one before; the last is the committed solid, so it is rebuilt by going back to the root first.
  const built: [string, number][] = [["node_1", 47725.309649], ["node_3", 41965.309649], ["node_5", 42265.309649], ["node_6", 41705.309649], ["node_7", 41491.569607]];
  await call("model_goto", { object, node: "node_0" });
  for (const [node, mm3] of built) {
    const went = await call("model_goto", { object, node });
    check(`4.0.0's ${node} rebuilds to ${mm3} mm³`, went.ok === true && near(await volume(object), mm3, 1e-4), String(await volume(object)));
  }
  await call("model_goto", { object, node: "node_0" });
  const back = await call("model_goto", { object, node: "node_8" });
  check("its last step rebuilds from the first", back.ok === true, JSON.stringify(back));
  check("to the volume 4.0.0 built, 41450.424152 mm³", near(await volume(object), 41450.424152, 1e-4), String(await volume(object)));
}

if (failed > 0) {
  console.error(`kernel-gaps: ${failed} failed`);
  process.exit(1);
}
console.log("kernel-gaps: ok");
process.exit(0);
