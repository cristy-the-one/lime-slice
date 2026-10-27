import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-"));

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
const imported = await call("mesh_import", { path: cube });
const object = String(imported.object);

const plain = await call("object_place", { object, rotX: 8 });
check("a turn without settle reports no contact", plain.ok === true && plain.settled === undefined && plain.contactMm2 === undefined, JSON.stringify(plain));

const settled = await call("object_place", { object, rotX: 8, settle: true });
const turn = settled.rotationDeg as { x: number; y: number; z: number } | undefined;
check("settle rests a cube held 8 degrees off", settled.ok === true && settled.settled === true, JSON.stringify(settled));
check("the reply gives the final rotation", !!turn && Math.abs(turn.x) < 0.01 && Math.abs(turn.y) < 0.01 && Math.abs(turn.z) < 0.01, JSON.stringify(turn));
check("the reply gives the contact area", typeof settled.contactMm2 === "number" && Math.abs((settled.contactMm2 as number) - 400) < 1, JSON.stringify(settled.contactMm2));

const listed = await call("plate_list", {});
const box = (listed.objects as { bboxMm: { min: number[]; max: number[] } }[])[0]!.bboxMm;
check("a settled cube sits on the bed and is level", Math.abs(box.min[2]!) < 1e-6 && Math.abs(box.max[2]! - 20) < 1e-3, JSON.stringify(box));

const held = await call("object_place", { object, rotX: 45, settle: true });
const heldTurn = held.rotationDeg as { x: number } | undefined;
check("a pose far from every flat face keeps its angle", held.settled === false && !!heldTurn && Math.abs(heldTurn.x - 45) < 0.01, JSON.stringify(held));

const flat = await call("object_place", { object, layFlat: true, settle: true });
check("layFlat then settle lands on a flat face", flat.ok === true && Math.abs((flat.contactMm2 as number) - 400) < 1, JSON.stringify(flat));

const undone = await call("plate_undo", {});
check("one settle is one undo step", undone.ok === true && undone.label === "Place", JSON.stringify(undone));

if (failed > 0) process.exit(1);
