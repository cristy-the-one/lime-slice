/**
 * The preview is a real PNG, centred, with the near face in front.
 * A hole on the open solid shows in the top view.
 */
import { inflateSync } from "node:zlib";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { renderMesh } from "./render.ts";
import { Session } from "./session.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-render-"));
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

function box(min: number[], max: number[]): Float32Array {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const corners = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [[4, 5, 6, 7], [0, 3, 2, 1], [1, 2, 6, 5], [0, 4, 7, 3], [3, 7, 6, 2], [0, 1, 5, 4]];
  const positions = new Float32Array(quads.length * 18);
  quads.forEach((quad, face) => {
    const corner = (index: number) => corners[quad[index]!]!;
    const write = (tri: number, a: number[], b: number[], d: number[]) => {
      positions.set([...a, ...b, ...d], (face * 2 + tri) * 9);
    };
    write(0, corner(0), corner(1), corner(2));
    write(1, corner(0), corner(2), corner(3));
  });
  return positions;
}

function shades(png: Uint8Array, width: number, height: number): number[] {
  if (png[0] !== 137 || png[1] !== 80 || png[2] !== 78 || png[3] !== 71) return [];
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  const parts: Uint8Array[] = [];
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(png[offset + 4]!, png[offset + 5]!, png[offset + 6]!, png[offset + 7]!);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") parts.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts.map((part) => Buffer.from(part))));
  const found: number[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) found.push(raw[row + 1 + x * 3] ?? 0);
  }
  return found;
}

const ledge = box([10, -4, 0], [40, 16, 8]);
for (const camera of ["top", "front", "iso"] as const) {
  const drawn = renderMesh(ledge, camera, 96);
  let decoded: number[] = [];
  try {
    decoded = shades(drawn.png, drawn.width, drawn.height);
  } catch (err) {
    check(`${camera} opens as a PNG`, false, err instanceof Error ? err.message : "");
    continue;
  }
  check(`${camera} opens as a PNG`, decoded.length === drawn.width * drawn.height);
  const ink = decoded.filter((shade) => shade !== 248);
  check(`${camera} draws the part`, ink.length > 20);
  if (camera === "iso") {
    const mean = ink.reduce((sum, shade) => sum + shade, 0) / ink.length;
    check("the iso view shows the lit top, not the far side", mean > 140, String(mean));
  }
}

const top = renderMesh(box([0, 0, 0], [20, 20, 20]), "top", 96);
const topShades = shades(top.png, top.width, top.height);
let minX = top.width;
let maxX = 0;
topShades.forEach((shade, index) => {
  if (shade === 248) return;
  const x = index % top.width;
  if (x < minX) minX = x;
  if (x > maxX) maxX = x;
});
const left = minX;
const right = top.width - 1 - maxX;
check("the part is centred in the frame", Math.abs(left - right) <= 8, `${left} ${right}`);

const holed = box([0, 0, 0], [20, 20, 20]);
const marked = new Float32Array(holed.length + 9);
marked.set(holed);
marked.set([6, 6, 20.2, 6, 12, 20.2, 12, 6, 20.2], holed.length);
const after = shades(renderMesh(marked, "top", 96).png, 96, 96);
// The part's outline is drawn dark now; inside it, the top face itself has no dark pixels until the hole is marked.
const inside = (shadesRow: number[]) => shadesRow.filter((shade, index) => {
  const x = index % 96;
  const y = Math.floor(index / 96);
  return x > minX + 3 && x < maxX - 3 && y > minX + 3 && y < maxX - 3 && shade < 100;
}).length;
const darkBefore = inside(topShades);
const darkAfter = inside(after);
check("a hole on the top face is darker than the top", darkBefore === 0 && darkAfter > 8, `${darkBefore} ${darkAfter}`);
const outline = topShades.filter((shade) => shade < 100).length;
check("the part's outline is drawn", outline > 40, String(outline));

const engine = fakeEngine();
const session = new Session(engine);
const solid = await session.call("solid_new", { dx: 20, dy: 20, dz: 20 });
const beforeFile = await session.call("render_view", { object: solid.object, camera: "top", name: "before.png", longEdge: 64 });
const hole = { kind: "hole", diameterMm: 4, through: true, origin: [10, 10, 20], axis: [0, 0, -1] };
await session.call("model_probe", { object: solid.object, op: hole });
await session.call("model_apply", { object: solid.object, op: hole });
const afterFile = await session.call("render_view", { object: solid.object, camera: "top", name: "after.png", longEdge: 64 });
const beforeBytes = beforeFile.ok === true ? readFileSync(String(beforeFile.path)) : Buffer.alloc(0);
const afterBytes = afterFile.ok === true ? readFileSync(String(afterFile.path)) : Buffer.alloc(0);
let beforeDark = 0;
let afterDark = 0;
let decodedPixels = 0;
try {
  decodedPixels = shades(beforeBytes, 64, 64).length;
  beforeDark = shades(beforeBytes, 64, 64).filter((shade) => shade < 100).length;
  afterDark = shades(afterBytes, 64, 64).filter((shade) => shade < 100).length;
} catch (err) {
  check("render_view writes a PNG a decoder can open", false, err instanceof Error ? err.message : "");
}
check("render_view writes a PNG a decoder can open", decodedPixels === 64 * 64);
check("the top view shows the hole", afterDark > beforeDark, `${beforeDark} ${afterDark}`);

const handles: string[] = [];
for (let i = 0; i < 12; i += 1) {
  const started = await session.call("slice_start", {});
  handles.push(String(started.job));
  await session.call("slice_wait", { job: started.job });
}
const dropped = await session.call("gcode_summary", { job: handles[0] });
const kept = await session.call("gcode_summary", { job: handles[11] });
check("old slice jobs are dropped", dropped.ok === false, JSON.stringify(dropped));
check("a recent slice is still there", kept.ok === true, JSON.stringify(kept));

const closesBefore = engine.calls.filter((call) => call === "close").length;
await session.call("object_remove", { object: solid.object });
check("removing a solid closes its tree", engine.calls.filter((call) => call === "close").length === closesBefore + 1);
const again = await session.call("solid_new", { dx: 10, dy: 10, dz: 10 });
const opens = engine.calls.filter((call) => call === "close").length;
await session.call("project_create", {});
check("a new project closes the open solid", again.ok === true && engine.calls.filter((call) => call === "close").length === opens + 1);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("render: ok");
