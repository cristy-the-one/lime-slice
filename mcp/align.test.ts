import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-"));
process.env.LIME_MCP_WORKSPACE = workspace;

const { fakeEngine } = await import("./engine.ts");
const { Session } = await import("./session.ts");
const { validateTool } = await import("./schema.ts");

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const session = new Session(fakeEngine());
const call = (name: string, args: unknown = {}) => session.call(name, args);
const cube = fileURLToPath(new URL("../samples/calibration_cube_20mm.stl", import.meta.url));

const a = String((await call("mesh_import", { path: cube })).object);
const b = String((await call("mesh_import", { path: cube })).object);
await call("object_place", { object: a, centreX: 50, centreY: 60 });
await call("object_place", { object: b, centreX: 120, centreY: 150, scalePercent: 150 });

const box = async (id: string) => {
  const rows = (await call("plate_list", {})).objects as { object: string; bboxMm: { min: number[]; max: number[] } }[];
  return rows.find((row) => row.object === id)!.bboxMm;
};
const near = (name: string, got: number, want: number) => check(name, Math.abs(got - want) <= 1e-6, `got ${got}, want ${want}`);

const target = await box(b);
const flush = await call("object_place", { object: a, align: { to: b, how: "flush-left" } });
check("flush-left is accepted", flush.ok === true, JSON.stringify(flush));
near("flush-left: min X equals the target's", (await box(a)).min[0]!, target.min[0]!);
near("flush-left leaves Y", ((await box(a)).min[1]! + (await box(a)).max[1]!) / 2, 60);

await call("object_place", { object: a, align: { to: b, how: "centre" } });
const centred = await box(a);
near("centre: X", (centred.min[0]! + centred.max[0]!) / 2, (target.min[0]! + target.max[0]!) / 2);
near("centre: Y", (centred.min[1]! + centred.max[1]!) / 2, (target.min[1]! + target.max[1]!) / 2);

await call("object_place", { object: a, align: { to: b, how: "on-top" } });
near("on top: the base is the target's top", (await box(a)).min[2]!, target.max[2]!);

await call("object_place", { object: a, align: { to: b, how: "right-of" } });
near("right-of touches the far side", (await box(a)).min[0]!, target.max[0]!);

const bed = await call("object_place", { object: a, align: { to: "bed", how: "flush-right" } });
check("the bed takes flush", bed.ok === true, JSON.stringify(bed));
const bedMm = ((await call("session_info", {})) as { printer?: { bedMm?: number[] } }).printer?.bedMm;
if (bedMm) near("flush-right on the bed lands on its far edge", (await box(a)).max[0]!, bedMm[0]!);

const refused = await call("object_place", { object: a, align: { to: "bed", how: "on-top" } });
check("the bed has nothing to stack on", refused.ok === false, JSON.stringify(refused));
const unknown = await call("object_place", { object: a, align: { to: "obj_missing", how: "centre" } });
check("an unknown target is refused", unknown.ok === false);
const self = await call("object_place", { object: a, align: { to: a, how: "centre" } });
check("a part cannot align to itself", self.ok === false);
check("the schema takes an align", validateTool("object_place", { object: a, align: { to: "bed", how: "centre" } }) === null);
check("the schema names a bad relation", validateTool("object_place", { object: a, align: { to: "bed", how: "middle" } }) !== null);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("object_place align ok");
