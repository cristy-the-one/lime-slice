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

function rawRows(png: Uint8Array): Buffer {
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
  return inflateSync(Buffer.concat(parts.map((part) => Buffer.from(part))));
}

function shades(png: Uint8Array, width: number, height: number): number[] {
  if (png[0] !== 137 || png[1] !== 80 || png[2] !== 78 || png[3] !== 71) return [];
  const raw = rawRows(png);
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

// One model-space box keeps an unmoving part at the same pixels when another part moves.
const fit = { min: [-20, -20, -5] as [number, number, number], max: [60, 20, 15] as [number, number, number] };
const fixed = box([0, 0, 0], [10, 10, 10]);
const otherA = box([20, 0, 0], [30, 10, 10]);
const otherB = box([40, 0, 0], [50, 10, 10]);
const merge = (a: Float32Array, b: Float32Array) => Float32Array.from([...a, ...b]);
const fixedA = shades(renderMesh(merge(fixed, otherA), "top", 128, undefined, { fit }).png, 128, 128);
const fixedB = shades(renderMesh(merge(fixed, otherB), "top", 128, undefined, { fit }).png, 128, 128);
const fixedOnly = shades(renderMesh(fixed, "top", 128, undefined, { fit }).png, 128, 128);
check("fixed framing keeps the stationary part on the same pixels", fixedOnly.every((shade, i) => shade === 248 || (fixedA[i] === shade && fixedB[i] === shade)));
// Colour is attached to triangle ownership, even where parts have overlapping bounds.
const redLeft = shades(renderMesh(merge(fixed, otherA), "top", 128, undefined, { fit, partTints: [{ start: 0, end: fixed.length / 9, rgb: [220, 30, 30] }] }).png, 128, 128);
const blueLeft = shades(renderMesh(merge(fixed, otherA), "top", 128, undefined, { fit, partTints: [{ start: 0, end: fixed.length / 9, rgb: [30, 30, 220] }] }).png, 128, 128);
check("part colour changes only its own pixels", redLeft.some((v, i) => v > blueLeft[i]! + 20) && fixedOnly.every((v, i) => v !== 248 || redLeft[i] === blueLeft[i]));
const colourView = await session.call("render_view", { object: solid.object, view: "assembly", partColours: { [String(solid.object)]: "#e02020" }, camera: "top", longEdge: 64, inline: false, name: "part-colour.png" });
check("render_view accepts part colours by handle", colourView.ok === true, JSON.stringify(colourView));
const missingColour = await session.call("render_view", { object: solid.object, view: "assembly", partColours: { missing: "#e02020" }, inline: false });
check("render_view refuses a colour for a missing part", missingColour.ok === false, JSON.stringify(missingColour));
const badColour = await session.call("render_view", { object: solid.object, view: "assembly", partColours: { [String(solid.object)]: "red" }, inline: false });
check("render_view refuses an invalid part colour", badColour.ok === false, JSON.stringify(badColour));
const fitResult = await session.call("render_view", { object: solid.object, camera: "top", fit, longEdge: 64, inline: false, name: "fixed-fit.png" });
check("render_view accepts fixed model-space framing", fitResult.ok === true, JSON.stringify(fitResult));
const sectionFit = await session.call("render_view", { object: solid.object, fit, section: { normal: [0, -1, 0] }, inline: false, longEdge: 64, name: "fixed-section.png" });
check("fixed framing works with a section", sectionFit.ok === true, JSON.stringify(sectionFit));
const ghostFit = await session.call("render_view", { object: solid.object, fit, op: { kind: "boolean", op: "cut", primitive: "box", dx: 2, dy: 2, dz: 2 }, inline: false, longEdge: 64, name: "fixed-ghost.png" });
check("fixed framing works with a boolean preview", ghostFit.ok === true, JSON.stringify(ghostFit));
const badFit = await session.call("render_view", { object: solid.object, fit: { min: [5, 0, 0], max: [0, 1, 1] }, inline: false });
check("render_view refuses inverted framing boxes", badFit.ok === false, JSON.stringify(badFit));

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

// A chosen background: every corner of the PNG and of the raw pixels is exactly that colour, and the part is still drawn.
const cornersOf = (png: Uint8Array, edge: number, tall = edge) => {
  const raw = rawRows(png), at = (x: number, y: number) => [...raw.subarray(y * (edge * 3 + 1) + 1 + x * 3, y * (edge * 3 + 1) + 4 + x * 3)].join();
  return [at(0, 0), at(edge - 1, 0), at(0, tall - 1), at(edge - 1, tall - 1)];
};
const chosen = renderMesh(ledge, "iso", 96, undefined, { background: [18, 171, 86], pixels: true });
check("a frame's corner pixels are the chosen background", cornersOf(chosen.png, 96).every((pixel) => pixel === "18,171,86"), cornersOf(chosen.png, 96).join(" "));
check("so are the raw pixels the GIF encoder reads", [...chosen.rgb!.subarray(0, 3)].join() === "18,171,86");
check("the part is still drawn over it", shades(chosen.png, 96, 96).some((shade) => shade !== 18));
const paper = renderMesh(ledge, "iso", 96).png;
check("no choice keeps the pale background", cornersOf(paper, 96).every((pixel) => pixel === "248,248,255"), cornersOf(paper, 96).join(" "));
const backgroundSession = new Session(fakeEngine());
const backgroundPart = String((await backgroundSession.call("solid_new", { primitive: "box", dx: 2, dy: 2, dz: 2 })).object);
const shown = await backgroundSession.call("render_view", { object: backgroundPart, camera: "iso", background: "#12AB56", name: "background.png", inline: false, longEdge: 64 });
check("render_view takes a background", shown.ok === true && cornersOf(readFileSync(String(shown.path)), Number(shown.width), Number(shown.height)).every((pixel) => pixel === "18,171,86"), JSON.stringify(shown));
// render_view sizes the picture to the part: a plate from the front is a strip, at the scale of the square picture.
const plate = box([0, 0, 0], [100, 80, 10]);
const strip = renderMesh(plate, "front", 96, undefined, { crop: true });
const square = renderMesh(plate, "front", 96);
check("a cropped picture keeps the long edge and drops the empty rows", strip.width === 96 && strip.height < 32 + 1 && square.width === 96 && square.height === 96, `${strip.width}x${strip.height}`);
const stripShades = shades(strip.png, strip.width, strip.height), squareShades = shades(square.png, 96, 96);
const drawnIn = (list: number[]) => list.filter((shade) => shade !== 248).length;
check("the part is drawn at the same scale", Math.abs(drawnIn(stripShades) - drawnIn(squareShades)) <= 96 * 2, `${drawnIn(stripShades)} against ${drawnIn(squareShades)}`);
check("a fixed box keeps the square", renderMesh(plate, "front", 96, undefined, { crop: true, fit: { min: [0, 0, 0], max: [100, 80, 10] } }).height === 96);
const plateSession = new Session(fakeEngine());
const platePart = String((await plateSession.call("solid_new", { primitive: "box", dx: 100, dy: 80, dz: 10 })).object);
const plateShown = await plateSession.call("render_view", { object: platePart, camera: "front", name: "plate.png", inline: false, longEdge: 128 });
check("render_view answers the cropped size", plateShown.ok === true && plateShown.width === 128 && Number(plateShown.height) < 64, JSON.stringify(plateShown));
for (const bad of ["red", "#abc", "12ab56", "#12ab5g", "#12ab566", ""]) {
  const refused = await backgroundSession.call("render_view", { object: backgroundPart, background: bad, inline: false });
  check(`render_view refuses the background ${JSON.stringify(bad)} with a sentence`, refused.ok === false && String(refused.reason).includes("#rrggbb"), JSON.stringify(refused));
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("render: ok");
