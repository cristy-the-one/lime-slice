/**
 * Organic shapes: sweep caps, the ellipsoid primitive, seams that draw no line, and colours by face.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { primitiveFrom } from "./compose.ts";
import { fakeEngine } from "./engine.ts";
import { renderMesh } from "./render.ts";
import { validateTool } from "./schema.ts";
import { Session } from "./session.ts";
import { sweepSections } from "./sweep.ts";
import { primitiveBounds, primitiveMesh, rootSpec, turnCentre, type PrimitiveSpec } from "../src/model-primitive.ts";
import type { LoftSection } from "../src/model-tree.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-organic-"));

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

// Caps.
const flat = sweepSections({ path: [[0, 0, 0], [0, 0, 10]], radius: 2 }) as LoftSection[];
const round = sweepSections({ path: [[0, 0, 0], [0, 0, 10]], radius: 2, caps: "round" }) as LoftSection[];
check("round caps add four sections at each end", round.length === flat.length + 8, String(round.length));
const top = round[round.length - 1]!;
check("a round cap reaches about its radius past the end and nearly closes", top.origin[2] > 11.8 && top.origin[2] <= 12 && near(top.radius!, 0.3, 1e-3), JSON.stringify(top));
check("a round cap starts past the start too", round[0]!.origin[2] < -1.8, JSON.stringify(round[0]));
const pointed = sweepSections({ path: [[0, 0, 0], [10, 0, 0]], radius: 3, radiusV: 1.5, capEnd: "point" }) as LoftSection[];
const tip = pointed[pointed.length - 1]!;
check("a point cap ends in a tiny section a little past the end, the start flat", pointed.length === 3 && tip.origin[0] > 11.5 && near(tip.radius!, 0.15, 1e-3) && near(tip.radiusV!, 0.075, 1e-3) && pointed[0]!.origin[0] === 0, JSON.stringify(pointed));
const profiled = sweepSections({ path: [[0, 0, 0], [0, 0, 10]], profile: [[-2, -1], [2, -1], [2, 1], [-2, 1]], capEnd: "round" }) as LoftSection[];
check("a profile's round cap shrinks the profile", profiled[profiled.length - 1]!.profile![1]![0]! < 0.5, JSON.stringify(profiled[profiled.length - 1]));
check("a cap that is not flat, round, or point is refused", "reason" in (sweepSections({ path: [[0, 0, 0], [0, 0, 1]], radius: 1, caps: "dome" as never }) as object));

// The ellipsoid primitive.
const egg = primitiveFrom({ primitive: "ellipsoid", dx: 12, dy: 8, dz: 6, centre: [1, 2, 3] }) as PrimitiveSpec;
check("an ellipsoid sits on its centre", JSON.stringify(egg.origin) === "[1,2,3]" && JSON.stringify(turnCentre(egg)) === "[0,0,0]", JSON.stringify(egg));
const bounds = primitiveBounds(egg);
check("an ellipsoid's box is its widths", JSON.stringify(bounds.min) === "[-5,-2,0]" && JSON.stringify(bounds.max) === "[7,6,6]", JSON.stringify(bounds));
check("a new ellipsoid solid stands on the bed", JSON.stringify(rootSpec(egg).origin) === "[0,0,3]");
const ghost = primitiveMesh(egg);
let maxX = 0;
for (let i = 0; i < ghost.length; i += 3) maxX = Math.max(maxX, ghost[i]!);
check("an ellipsoid's ghost reaches its half widths", ghost.length > 0 && near(maxX, 6, 0.05), String(maxX));
check("the schema takes an ellipsoid", validateTool("model_apply", { op: { kind: "boolean", op: "fuse", primitive: "ellipsoid", dx: 4, dy: 3, dz: 2, centre: [0, 0, 0] } }) === null);

// Seams: two halves of a sphere tessellated apart meet along points that do not match; no line is drawn there.
function band(height: number, a0: number, a1: number, steps: number, rows: number): number[] {
  const out: number[] = [];
  const at = (a: number, z: number) => [10 * Math.cos(a), 10 * Math.sin(a), z];
  for (let r = 0; r < rows; r += 1) {
    const z0 = (height * r) / rows;
    const z1 = (height * (r + 1)) / rows;
    for (let i = 0; i < steps; i += 1) {
      const u = a0 + ((a1 - a0) * i) / steps;
      const w = a0 + ((a1 - a0) * (i + 1)) / steps;
      out.push(...at(u, z0), ...at(w, z0), ...at(w, z1), ...at(u, z0), ...at(w, z1), ...at(u, z1));
    }
  }
  return out;
}
// One cylinder wall in two faces meeting at the front (x = 10), tessellated apart: 3 rows on one side and 4 on the
// other, so the points along the seam do not match and no edge pairs up by position.
const wall = new Float32Array([...band(20, -Math.PI, 0, 12, 3), ...band(20, 0, Math.PI, 9, 4)]);
const drawn = renderMesh(wall, { direction: [1, 0, 0.15] }, 128);
function grey(png: Uint8Array, w: number, h: number): number[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let o = 8;
  const parts: Buffer[] = [];
  while (o + 12 <= png.length) {
    const len = view.getUint32(o);
    if (String.fromCharCode(png[o + 4]!, png[o + 5]!, png[o + 6]!, png[o + 7]!) === "IDAT") parts.push(Buffer.from(png.subarray(o + 8, o + 8 + len)));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const out: number[] = [];
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) out.push(raw[y * (w * 3 + 1) + 1 + x * 3]!);
  return out;
}
const shades = grey(drawn.png, drawn.width, drawn.height);
// The seam at y = 10 faces the camera near the picture's middle column; no dark ink runs down it.
const column = Math.round(drawn.width / 2);
const darkRun = shades.filter((_, i) => Math.abs((i % drawn.width) - column) <= 3 && shades[i]! < 60).length;
check("a seam between faces that meet smoothly draws no line", darkRun < drawn.height / 4, String(darkRun));

// The session: an ellipsoid base, capped sweeps, and colours that take whole faces.
const session = new Session(fakeEngine());
const call = (name: string, args: unknown = {}) => session.call(name, args);
const built = await call("model_build", { name: "duck", base: { primitive: "ellipsoid", dx: 20, dy: 20, dz: 20 }, ops: [
  { kind: "sweep", label: "bill", path: [[5, 0, 15], [9, 0, 15]], radius: 3, radiusV: 1.2, capEnd: "round" },
] });
check("a build on an ellipsoid with a capped sweep applies", built.ok === true && built.applied === 1, JSON.stringify(built));
const coloured = await call("render_view", { object: built.object, colours: { bill: "#f08a1c" }, longEdge: 64, inline: false });
check("colours render on a solid, by face", coloured.ok === true && (coloured.colours as unknown[]).length === 1, JSON.stringify(coloured));

if (failed > 0) {
  console.error(`organic: ${failed} failed`);
  process.exit(1);
}
console.log("organic: ok");
