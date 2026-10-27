/**
 * Quick fixes from the LED-cover modelling notes (lime-mcp-gaps.md): the default anchor of a pocket or boss, root
 * labels, edge convexity, labels of placed parts, and naming a plate object. Against the stand-in engine.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

if (failed > 0) {
  console.error(`gaps-quick: ${failed} failed`);
  process.exit(1);
}
console.log("gaps-quick: ok");
