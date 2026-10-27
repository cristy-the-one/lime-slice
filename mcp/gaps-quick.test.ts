/**
 * Quick fixes from the LED-cover modelling notes (lime-mcp-gaps.md): the default anchor of a pocket or boss, root
 * labels, edge convexity, labels of placed parts, and naming a plate object. Against the stand-in engine.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mirrorPlate, type BridgeMessage, type MirrorObject } from "../src/bridge.ts";
import { expand, primitiveFrom, withBoxAnchor, type ExpandContext, type Piece } from "../src/modeling/compose.ts";
import { fakeEngine } from "./engine.ts";
import { validateTool } from "./schema.ts";
import { Session } from "./session.ts";
import { GLOBAL_WORKPLANE, workplaneOnFace } from "../src/workplane.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-gaps-quick-"));
process.env.LIME_MCP_WORKSPACE = workspace;

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const toPart = (op: Record<string, unknown>): Piece | { reason: string } => {
  const spec = primitiveFrom(op);
  return "reason" in spec ? spec : { op: op.op === "fuse" ? "fuse" : "cut", spec };
};

// Item 7. A wall 200 mm wide (X from -100 to 100) whose frame origin is its centre of area. A feature already on the
// face moves that centre, so the same wall is read twice: with the frame at x = 0, and with it at x = 6.3.
const wall = (centreX: number): ExpandContext => ({
  plane: GLOBAL_WORKPLANE,
  face: (index) => index === 5
    ? { plane: workplaneOnFace({ point: [centreX, -20, 17.5], normal: [0, -1, 0] }), extent: { u: [-100 - centreX, 100 - centreX], v: [-17.5, 17.5] } }
    : { reason: "That face is not on this solid." },
  faceBy: () => 5,
});
const boss = (u: number, from?: string): Record<string, unknown> => ({ kind: "boss", faceIndex: 5, ...(from ? { from } : {}), at: { u, v: 0 }, width: 10, height: 6, depth: 2 });
const worldX = (pieces: Piece[]): number => pieces[0]!.spec.origin[0] + pieces[0]!.spec.size[0] / 2;
const pair = (centreX: number, from?: string): [number, number] => {
  const ctx = wall(centreX);
  const op = (u: number) => expand(withBoxAnchor(boss(u, from)), ctx, toPart) as Piece[];
  return [worldX(op(73.25)), worldX(op(-73.25))];
};
for (const centreX of [0, 6.3, -11.9]) {
  const [right, left] = pair(centreX);
  check(`two bosses at u ±73.25 are symmetric about the face's box centre with the frame at ${centreX}`, near(right + left, 0, 1e-6) && near(right - left, 146.5, 1e-6), JSON.stringify([right, left]));
}
const [oldRight, oldLeft] = pair(6.3, "centre");
check("from: centre still means the centre of area", near(oldRight + oldLeft, 2 * 6.3, 1e-6), JSON.stringify([oldRight, oldLeft]));
const bare = expand(boss(73.25), wall(6.3), toPart) as Piece[];
check("an op with no from, as an older file stored it, still reads from the centre of area", near(worldX(bare), 6.3 + 73.25, 1e-6), String(worldX(bare)));
check("a fresh boss on a face gets from: box written in", (withBoxAnchor(boss(1)) as { from?: string }).from === "box");
check("a fresh pocket inside a mirror gets it too", ((withBoxAnchor({ kind: "mirror", plane: "x", op: { kind: "pocket", faceIndex: 5, depth: 1 } }) as { op: { from?: string } }).op.from) === "box");
check("an explicit from is left alone", (withBoxAnchor(boss(1, "corner")) as { from?: string }).from === "corner" && (withBoxAnchor(boss(1, "centre")) as { from?: string }).from === "centre");
check("an op with no face is left alone", (withBoxAnchor({ kind: "pocket", depth: 1 }) as { from?: string }).from === undefined);
check("other kinds are left alone", (withBoxAnchor({ kind: "text", faceIndex: 5, text: "A", height: 3, depth: 1 }) as { from?: string }).from === undefined);

async function groupSource(name: string): Promise<Record<string, unknown> | undefined> {
  const own = new Session(fakeEngine());
  const made = await own.call("solid_new", { primitive: "box", dx: 60, dy: 40, dz: 35 });
  const done = await own.call("model_apply", { object: made.object, op: { kind: "boss", faceIndex: 5, at: { u: 6, v: 3 }, width: 10, height: 8, depth: 2 } });
  check(`the boss applies (${name})`, done.ok === true, JSON.stringify(done));
  await own.call("project_save", { name });
  const doc = JSON.parse(readFileSync(join(workspace, name), "utf8")) as { objects?: { modelTree?: { nodes?: { op?: { kind?: string; source?: Record<string, unknown> } | null }[] } }[] };
  return doc.objects?.[0]?.modelTree?.nodes?.map((node) => node.op).find((op) => op?.kind === "group")?.source;
}
const source = await groupSource("anchor.lime");
check("a boss applied through the server is saved with from: box", source?.from === "box", JSON.stringify(source));

// Item 9. The ops guide says where a turned boolean pivots.
const guided = await new Session(fakeEngine()).call("guide", { topic: "ops" });
const guideText = String(guided.text ?? "");
check("the ops guide says a turn pivots about the primitive's own centre and origin is the min corner before it", /turn pivots about the primitive's own centre, not about origin: origin is the min corner/.test(guideText));
check("the ops guide describes from: box", guideText.includes('from:"box"'));

// Item 10. A root op takes a label like the other ops, and the step shows it.
check("a root op may carry a label", validateTool("model_apply", { op: { kind: "root", primitive: "box", dx: 30, dy: 30, dz: 30, label: "base block" } }) === null);
{
  const own = new Session(fakeEngine());
  const made = await own.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 });
  const rooted = await own.call("model_apply", { object: made.object, probe: true, op: { kind: "root", primitive: "box", dx: 30, dy: 30, dz: 30, label: "base block" } });
  const history = await own.call("model_history", { object: made.object });
  const labels = ((history.nodes ?? []) as { label?: string }[]).map((node) => node.label);
  check("the root step keeps its label", rooted.ok === true && rooted.label === "base block" && labels.includes("base block"), JSON.stringify({ rooted, labels }));
}

// Item 15. Steps a part makes carry the name it was placed under, so labels and colours find them.
{
  const own = new Session(fakeEngine());
  const made = await own.call("solid_new", { primitive: "box", dx: 40, dy: 40, dz: 10 });
  const defined = await own.call("model_define", {
    name: "peg",
    params: { h: 6 },
    ops: [
      { kind: "boolean", op: "fuse", primitive: "cylinder", radius: 2, height: "h", origin: [0, 0, 10] },
      { kind: "boolean", op: "fuse", primitive: "box", dx: 8, dy: 2, dz: 3, origin: [-4, -1, 8], label: "bar" },
    ],
  });
  check("a part with an unlabelled op and a labelled one is stored", defined.ok === true, JSON.stringify(defined));
  const placed = await own.call("model_apply_batch", { object: made.object, ops: [{ kind: "use", part: "peg", label: "hook", with: { h: 8 } }] });
  check("the part is placed", placed.ok === true, JSON.stringify(placed));
  const history = await own.call("model_history", { object: made.object });
  const labels = ((history.nodes ?? []) as { label?: string }[]).map((node) => node.label);
  check("an unlabelled part op takes the use's label and a labelled one follows it", labels.includes("hook") && labels.includes("hook bar"), JSON.stringify(labels));
  const anchored = await own.call("model_anchors", { object: made.object, label: "hook" });
  check("model_anchors finds the placed part by the use's label", anchored.ok === true, JSON.stringify(anchored));
  const seen = await own.call("render_view", { object: made.object, colours: { hook: "#f08a1c" }, inline: false });
  check("render_view colours finds the placed part by the use's label", seen.ok === true, JSON.stringify(seen).slice(0, 300));
  const bare = await own.call("model_apply_batch", { object: made.object, ops: [{ kind: "use", part: "peg", with: { h: 3 } }] });
  const bareLabels = ((await own.call("model_history", { object: made.object })).nodes as { label?: string }[]).map((node) => node.label);
  check("a use with no label leaves a part's unlabelled ops to their own names", bare.ok === true && bareLabels.includes("bar") && bareLabels.some((label) => label?.startsWith("Fuse cylinder")), JSON.stringify(bareLabels));
}

// Item 16. A plate object can be named when it is made and renamed by object_select; the name is what the list, a
// saved project, and the desktop's mirror carry, and plate_undo takes a rename back.
{
  check("solid_new and object_select take a name", validateTool("solid_new", { primitive: "box", dx: 5, name: "led body" }) === null && validateTool("object_select", { object: "obj_1", name: "led body" }) === null);
  check("an empty name is refused", validateTool("object_select", { object: "obj_1", name: "" }) !== null);
  const own = new Session(fakeEngine());
  const listed = async () => ((await own.call("plate_list", {})).objects as { object?: string; name?: string }[]).map((row) => row.name);
  const named = await own.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 10, name: "  led body  " });
  check("solid_new with a name stands the object under it", named.ok === true && (await own.call("model_commit", { object: named.object })).ok === true && (await listed()).includes("led body"), JSON.stringify(await listed()));
  const plain = await own.call("solid_new", { primitive: "cylinder", radius: 3, height: 8 });
  await own.call("model_commit", { object: plain.object });
  check("a solid with no name is still called by its primitive", (await listed()).includes("cylinder"), JSON.stringify(await listed()));
  const renamed = await own.call("object_select", { object: plain.object, name: "hook" });
  const mirrored = structuredClone(own.bridgeSnapshot()) as { tool?: string; plate?: { object: string; name: string; meshHash?: string }[] } | null;
  check("object_select with a name renames the object and says so", renamed.ok === true && renamed.name === "hook" && (await listed()).includes("hook") && !(await listed()).includes("cylinder"), JSON.stringify({ renamed, now: await listed() }));
  check("the desktop's mirror carries the new name as a full plate", mirrored?.tool === "plate_sync" && mirrored.plate?.find((row) => row.object === plain.object)?.name === "hook", JSON.stringify(mirrored?.plate));
  // The desktop window applies that message to a plate that still holds the old name.
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1] as MirrorObject["orient"];
  const before: MirrorObject[] = (mirrored?.plate ?? []).map((row: { object: string; name: string; meshHash?: string }) => ({
    id: row.object,
    name: row.object === plain.object ? "cylinder" : row.name,
    scalePercent: 100,
    centered: true,
    offset: { x: 0, y: 0, z: 0 },
    orient: identity,
    meshHash: row.meshHash ?? "",
    extra: null,
  }));
  const applied = mirrorPlate(before, mirrored as unknown as BridgeMessage, { session: "", seq: 0 });
  check("the desktop's plate shows the new name when it applies that message", applied.applied && applied.plate.find((row) => row.id === plain.object)?.name === "hook" && applied.plate.find((row) => row.id === named.object)?.name === "led body", JSON.stringify(applied.plate.map((row) => row.name)));
  await own.call("project_save", { name: "named.lime", ifExists: "refuse" });
  const saved = JSON.parse(readFileSync(join(workspace, "named.lime"), "utf8")) as { objects?: { id?: string; name?: string }[] };
  check("a saved project keeps the name", saved.objects?.find((row) => row.id === plain.object)?.name === "hook" && saved.objects?.find((row) => row.id === named.object)?.name === "led body", JSON.stringify(saved.objects?.map((row) => row.name)));
  const reselected = await own.call("object_select", { object: plain.object });
  check("object_select with no name leaves the name alone", reselected.ok === true && reselected.name === "hook");
  const undone = await own.call("plate_undo", {});
  check("plate_undo takes the rename back", undone.ok === true && undone.label === "Rename" && (await listed()).includes("cylinder"), JSON.stringify({ undone, now: await listed() }));
}

if (failed > 0) {
  console.error(`gaps-quick: ${failed} failed`);
  process.exit(1);
}
console.log("gaps-quick: ok");
