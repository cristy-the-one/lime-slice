/**
 * Writes the project the round-pin case of `e2e/pose-contact.spec.ts` opens (docs/plan-contact-poses.md section 6): a
 * frame (z 0 to 4), an arm 20 x 2 x 5 hinged about +z at its near end (the origin), and a round pin of radius 3 at
 * (12, 6), all standing at z 6. The pin is a Model solid whose mesh is the kernel's kind: 18 flat facets with their
 * corners on the true circle (a chord of 0.05 mm at radius 3), so the facets lie up to 0.046 mm inside the true pin.
 * Built by the MCP session on the fake engine (whose cylinder is a box), with the pin's mesh put in its place before
 * saving. Run with Node: `node --experimental-strip-types --no-warnings e2e/contact-round-project.ts <out.lime>`.
 */
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEngine } from "../mcp/engine.ts";
import { stlBytes } from "../mcp/request.ts";
import { Session } from "../mcp/session.ts";

const out = process.argv[2];
if (!out) throw new Error("Give the .lime path to write.");
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-contact-round-"));
const session = new Session(fakeEngine());
const call = async (name: string, input: Record<string, unknown> = {}) => {
  const reply = (await session.call(name, input)) as Record<string, unknown>;
  if (reply.ok !== true) throw new Error(`${name}: ${JSON.stringify(reply)}`);
  return reply;
};
const frame = String((await call("solid_new", { primitive: "box", dx: 60, dy: 60, dz: 4, name: "Frame" })).object);
const arm = String((await call("solid_new", { primitive: "box", dx: 20, dy: 2, dz: 5, name: "Arm" })).object);
const pin = String((await call("solid_new", { primitive: "cylinder", radius: 3, height: 5, name: "Pin" })).object);
await call("model_place", { object: arm, to: frame, x: 10, y: 0, z: 6 });
await call("model_place", { object: arm, joint: { kind: "hinge", pivot: [-10, 0, 0], axis: [0, 0, 1], min: -30 } });
await call("model_place", { object: pin, to: frame, x: 12, y: 6, z: 6 });

// The pin's facets: 18 about its axis, half a facet turned so a flat facet faces the arm, as a kernel mesh at 0.05 mm.
const segments = 18, r = 3, phase = Math.PI / segments;
const rim = (j: number): [number, number] => [r * Math.cos(phase + (2 * Math.PI * j) / segments), r * Math.sin(phase + (2 * Math.PI * j) / segments)];
const positions: number[] = [];
for (let j = 0; j < segments; j += 1) {
  const [ax, ay] = rim(j), [bx, by] = rim(j + 1);
  positions.push(ax, ay, 0, bx, by, 0, bx, by, 5, ax, ay, 0, bx, by, 5, ax, ay, 5);
  positions.push(0, 0, 5, ax, ay, 5, bx, by, 5);
  positions.push(0, 0, 0, bx, by, 0, ax, ay, 0);
}
const mesh = new Float32Array(positions);
const obj = session.find(pin)!;
obj.source = mesh;
obj.bytes = stlBytes(mesh, obj.fileName);
obj.triangles = mesh.length / 9;
if (obj.solid) obj.solid.positions = mesh;

const saved = await call("project_save", { name: "pose-contact-round.lime" });
copyFileSync(String(saved.path), out);
console.log(JSON.stringify({ frame, arm, pin }));
process.exit(0);
