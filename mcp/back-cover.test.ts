/**
 * Findings from the 2.6.1 back-cover session, against the stand-in engine. The same repros against real Open CASCADE
 * are in occt.test.ts.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { advertisedTools } from "./schema.ts";
import { Session } from "./session.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-back-cover-"));

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Finding 5: the schema a client sees matches the guide.
{
  const build = advertisedTools().find((tool) => tool.name === "model_build")!;
  const base = (build.inputSchema.properties as Record<string, { properties: Record<string, unknown> }>).base.properties;
  check("model_build.base.dx takes text as well as a number", same(base.dx, { exclusiveMinimum: 0, maximum: 1000, description: "Box X." }), JSON.stringify(base.dx));
  check("model_build.base takes a cone's top radius", same(base.topRadius, { minimum: 0, maximum: 500, description: "Cone top." }), JSON.stringify(base.topRadius));
  const apply = advertisedTools().find((tool) => tool.name === "model_apply")!;
  const ops = ((apply.inputSchema.properties as Record<string, { oneOf: { properties: Record<string, Record<string, unknown>> }[] }>).op.oneOf);
  const ribs = ops.find((row) => (row.properties.kind as { const?: string }).const === "ribs")!;
  check("ribs width takes text", ribs.properties.width!.type === undefined && ribs.properties.width!.maximum === 100);
  const hole = ops.find((row) => (row.properties.kind as { const?: string }).const === "hole")!;
  check("a hole's origin takes an anchor object", hole.properties.origin!.type === undefined && hole.properties.origin!.maxItems === 3);
  const fillet = ops.find((row) => (row.properties.kind as { const?: string }).const === "fillet")!;
  check("a fillet's edge select names onFace selectors", JSON.stringify(fillet.properties.edges).includes("onFace (index or {normal, nearPoint})"));
  const solidNew = advertisedTools().find((tool) => tool.name === "solid_new")!;
  check("solid_new lists radius and height", "radius" in (solidNew.inputSchema.properties as object) && "height" in (solidNew.inputSchema.properties as object));

  const session = new Session(fakeEngine());
  await session.call("model_params", { set: { L: 40 } });
  const built = await session.call("model_build", { base: { primitive: "box", dx: "L", dy: 20, dz: 10 }, ops: [] });
  check("model_build reads base.dx from a parameter", built.ok === true && same(built.bounds, { min: [-20, -10, 0], max: [20, 10, 10] }), JSON.stringify(built));
  const cylinder = await session.call("solid_new", { primitive: "cylinder", radius: 5, height: 10 });
  check("solid_new takes a cylinder's radius and height", cylinder.ok === true, JSON.stringify(cylinder));
  const box = await session.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 });
  const bottom = await session.call("edges_find", { object: box.object, onFace: { normal: [0, 0, -1] } });
  check("edges_find takes onFace as a face selector", bottom.ok === true && bottom.total === 4 && same((bottom.edges as { index: number }[]).map((edge) => edge.index), [0, 1, 2, 3]), JSON.stringify(bottom));
  const fillet2 = await session.call("model_probe", { object: box.object, op: { kind: "fillet", edges: { select: { onFace: { normal: [0, 0, 1], nearPoint: [0, 0, 20] } } }, size: 1 } });
  check("a fillet picks edges on a face selector", fillet2.ok === true && same(fillet2.edges, [4, 5, 6, 7]), JSON.stringify(fillet2));
  const wrong = await session.call("model_probe", { object: box.object, op: { kind: "fillet", edges: { select: { onFace: { normal: [1, 1, 1], withinDeg: 1 } } }, size: 1 } });
  check("a face selector that matches nothing says so", wrong.ok === false && wrong.reason === "onFace: No flat face matches that selector.", JSON.stringify(wrong));
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("back-cover: ok");
process.exit(0);
