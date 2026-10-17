/**
 * A Model solid's plate mesh is the kernel's own mesh, saved as STL beside the STEP (`brep`), as the app saves it; a
 * project saved the old way, with the STEP as the plate mesh, takes the kernel's mesh when it opens. Stand-in engine.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { meshRecord } from "../src/project.ts";
import { Session } from "./session.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-plate-"));
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

type SavedObject = { id: string; mesh: { name: string; bytesBase64: string }; brep?: { name: string; bytesBase64: string }; meshSeatMm?: number; modelTree?: unknown };
const readDoc = (name: string) => JSON.parse(readFileSync(join(workspace, name), "utf8")) as { objects?: SavedObject[]; mesh?: { name: string } };
const isStl = (b64: string) => {
  const bytes = Buffer.from(b64, "base64");
  return bytes.length >= 84 && bytes.length === 84 + bytes.readUInt32LE(80) * 50;
};

const session = new Session(fakeEngine());
const call = (name: string, args: unknown = {}) => session.call(name, args);
const built = await call("model_build", { name: "post", base: { primitive: "box", dx: 20, dy: 20, dz: 20 }, ops: [{ kind: "boolean", op: "cut", primitive: "box", centre: [0, 0, 19], dx: 4, dy: 4, dz: 4 }] });
check("a build commits", built.ok === true && built.committed === true, JSON.stringify(built));
const listed = (await call("plate_list")).objects as { object: string }[];
check("the plate still lists the object", listed.some((row) => row.object === built.object));
await call("project_save", { name: "fresh.lime" });
const fresh = readDoc("fresh.lime").objects?.[0];
check("the plate mesh is saved as an STL of the kernel's mesh", !!fresh && fresh.mesh.name.endsWith(".stl") && isStl(fresh.mesh.bytesBase64), JSON.stringify(fresh?.mesh.name));
check("the STEP is saved beside it as brep, with the mesh's seat", !!fresh?.brep && fresh.brep.name.endsWith(".step") && Buffer.from(fresh.brep.bytesBase64, "base64").toString("latin1").startsWith("ISO-10303-21") && typeof fresh.meshSeatMm === "number", JSON.stringify({ brep: fresh?.brep?.name, seat: fresh?.meshSeatMm }));

// Reopened, the object keeps its history and its STEP, and Model still works on it.
const reopened = new Session(fakeEngine());
const opened = await reopened.call("project_open", { path: "fresh.lime" });
check("the project opens", opened.ok === true, JSON.stringify(opened));
const history = await reopened.call("model_history", { object: String(built.object) });
check("the reopened object keeps its Model history", history.ok === true && (history.nodes as unknown[]).length >= 2, JSON.stringify(history));
const probed = await reopened.call("model_apply", { object: String(built.object), probe: true, op: { kind: "boolean", op: "cut", primitive: "box", centre: [5, 5, 19], dx: 2, dy: 2, dz: 4 } });
check("a reopened object takes another edit", probed.ok === true, JSON.stringify(probed));
await reopened.call("project_save", { name: "again.lime" });
const again = readDoc("again.lime").objects?.[0];
check("saved again it keeps STL and brep", !!again && again.mesh.name.endsWith(".stl") && !!again.brep, JSON.stringify(again?.mesh.name));

// A file saved the old way: the plate mesh is the STEP itself. Opening it moves the STEP to brep and meshes with the kernel.
const exported = await call("model_export_step", { object: built.object, name: "post-export.step" });
const stepBytes = new Uint8Array(readFileSync(String(exported.path)));
const doc = readDoc("fresh.lime") as { objects: SavedObject[] };
const legacy = structuredClone(doc);
const object = legacy.objects[0]!;
object.mesh = meshRecord("post.step", stepBytes) as unknown as SavedObject["mesh"];
delete object.brep;
delete object.meshSeatMm;
writeFileSync(join(workspace, "legacy.lime"), JSON.stringify(legacy));
const old = new Session(fakeEngine());
const oldOpened = await old.call("project_open", { path: "legacy.lime" });
check("an old project opens", oldOpened.ok === true, JSON.stringify(oldOpened));
await old.call("project_save", { name: "migrated.lime" });
const migrated = readDoc("migrated.lime").objects?.[0];
check("an old Model solid's plate becomes the kernel's mesh, its STEP the brep", !!migrated && migrated.mesh.name.endsWith(".stl") && isStl(migrated.mesh.bytesBase64) && !!migrated.brep && Buffer.from(migrated.brep.bytesBase64, "base64").toString("latin1").startsWith("ISO-10303-21"), JSON.stringify({ mesh: migrated?.mesh.name, brep: migrated?.brep?.name }));

if (failed > 0) {
  console.error(`plate-mesh: ${failed} failed`);
  process.exit(1);
}
console.log("plate-mesh: ok");
