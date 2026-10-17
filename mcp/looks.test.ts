/**
 * Render looks (smooth shading, highlight and colour tints, section, turntable), thin walls, text, and path patterns.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { fakeEngine } from "./engine.ts";
import { renderMesh } from "./render.ts";
import { Session } from "./session.ts";
import { pathSamples } from "./sweep.ts";
import { textStrokes } from "./text.ts";
import { thinWalls } from "./thin.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-looks-"));

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

function box(min: number[], max: number[]): number[] {
  const [x0, y0, z0] = min as [number, number, number];
  const [x1, y1, z1] = max as [number, number, number];
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return faces.flatMap((f) => f.flatMap((i) => v[i]!));
}

/** Every pixel's RGB. */
function pixels(png: Uint8Array, width: number, height: number): [number, number, number][] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  const parts: Buffer[] = [];
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(png[offset + 4]!, png[offset + 5]!, png[offset + 6]!, png[offset + 7]!);
    if (type === "IDAT") parts.push(Buffer.from(png.subarray(offset + 8, offset + 8 + length)));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const out: [number, number, number][] = [];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const at = y * (width * 3 + 1) + 1 + x * 3;
    out.push([raw[at]!, raw[at + 1]!, raw[at + 2]!]);
  }
  return out;
}
const orange = (p: [number, number, number]) => p[0] > p[2] + 60 && p[1] > p[2] + 15;
const red = (p: [number, number, number]) => p[0] > p[1] + 60 && p[0] > p[2] + 60 && p[1] < 140;

const block = new Float32Array(box([0, 0, 0], [20, 20, 10]));
// A tint takes a triangle whose corners are all in its box: the second block, not the first.
const pair = new Float32Array([...box([0, 0, 0], [20, 20, 10]), ...box([0, 0, 10], [20, 20, 20])]);
const tinted = renderMesh(pair, "iso", 96, undefined, { tints: [{ min: [0, 0, 10], max: [20, 20, 20], rgb: [255, 135, 30] }] });
const tintedPixels = pixels(tinted.png, tinted.width, tinted.height);
check("a tint colours the part inside its box", tintedPixels.some(orange) && tintedPixels.some((p) => !orange(p) && p[0] < 240 && Math.abs(p[0] - p[1]) < 10), String(tintedPixels.filter(orange).length));
// A hollow block: the void's triangles wound inward, as a closed void's shell is.
const inner = box([4, 4, 2], [16, 16, 8]);
const flipped = inner.map((_, i) => inner[i - (i % 9) + [0, 1, 2, 6, 7, 8, 3, 4, 5][i % 9]!]!);
const hollow = new Float32Array([...box([0, 0, 0], [20, 20, 10]), ...flipped]);
const cut = renderMesh(hollow, "front", 96, undefined, { section: { point: [10, 10, 5], normal: [0, -1, 0] } });
check("a section shows the cut inside in red", pixels(cut.png, cut.width, cut.height).some(red));
const plain = renderMesh(block, "iso", 96);
check("no looks draws no colour", !pixels(plain.png, plain.width, plain.height).some(orange));

// Thin walls.
const finned = new Float32Array([...box([0, 0, 0], [20, 20, 10]), ...box([30, 0, 0], [30.5, 20, 10])]);
const thin = thinWalls(finned, 0.8);
check("a 0.5 mm fin is a thin wall, the block is not", thin.regions.length > 0 && thin.regions.every((row) => row.centre[0] >= 29.9 && Math.abs(row.thinnestMm - 0.5) < 1e-3) && Math.abs(thin.areaMm2 - 400) < 1, JSON.stringify(thin).slice(0, 300));
check("a thick block has no thin walls", thinWalls(block, 0.8).regions.length === 0);

// Text strokes.
const hi = textStrokes("HI", 6, 1, undefined) as { centre: number[]; length: number; angleDeg: number }[];
check("HI is six strokes, centred", hi.length === 6 && Math.abs(hi.reduce((s, row) => s + row.centre[0]!, 0) / 6) < 3, JSON.stringify(hi));
check("a letter the font lacks is named", "reason" in (textStrokes("Ø", 5, 1, undefined) as object) && String((textStrokes("Ø", 5, 1, undefined) as { reason: string }).reason).includes("Ø"));

// Path samples.
const arc = pathSamples([[0, 0, 0], [10, 10, 0], [20, 0, 0]], 5) as { point: number[]; tangent: number[] }[];
check("a path pattern spaces copies end to end", arc.length === 5 && arc[0]!.point.join() === "0,0,0" && arc[4]!.point.join() === "20,0,0" && arc[2]!.tangent[0]! > 0.99, JSON.stringify(arc));
const ring = pathSamples([[10, 0, 0], [0, 10, 0], [-10, 0, 0], [0, -10, 0]], 4, true) as { point: number[] }[];
check("a closed path leaves the last copy a step short of the first", ring.length === 4 && ring[0]!.point.join() === "10,0,0" && Math.hypot(...(ring[2]!.point as [number, number, number])) > 8, JSON.stringify(ring));

// The session.
const engine = fakeEngine();
const session = new Session(engine);
const call = (name: string, args: unknown = {}) => session.call(name, args);
const built = await call("model_build", { name: "sign", base: { primitive: "box", dx: 20, dy: 20, dz: 20 }, ops: [
  { kind: "text", text: "LIME", height: 4, depth: 0.6, face: { normal: [0, 0, 1] }, label: "title" },
  { kind: "pattern", path: { points: [[-8, -9.5, 2], [0, -9.5, 10], [8, -9.5, 18]], count: 4 }, op: { kind: "boolean", op: "cut", primitive: "sphere", radius: 0.8, centre: [-8, -9.5, 2] }, label: "dimples" },
] });
check("text and a path pattern build", built.ok === true && (built.applied as number) >= 14, JSON.stringify(built));
const history = ((await call("model_history", { object: built.object, limit: 50 })).nodes as { label: string }[]).map((row) => row.label);
check("each stroke and copy is a labelled step", history.some((label) => /^title \d+\/\d+$/.test(label)) && history.filter((label) => label.startsWith("dimples")).length === 4, JSON.stringify(history));
const looked = await call("render_view", { object: built.object, turntable: 4, highlight: "title", colours: { dimples: "#3070c0" }, section: { normal: [1, 0, 0] }, longEdge: 64, inline: false });
check("a turntable renders all round, with a legend of colours", looked.ok === true && (looked.views as unknown[]).length === 4 && (looked.colours as unknown[]).length === 2, JSON.stringify(looked));
const badColour = await call("render_view", { object: built.object, colours: { title: "orange" }, inline: false });
check("a colour that is not a hex code is refused", badColour.ok === false && String(badColour.reason).includes("#"), JSON.stringify(badColour));
const checked = await call("model_check", { object: built.object });
check("model_check measures thin walls", !!checked.thinWalls && (checked.notChecked as unknown[]).length === 0, JSON.stringify(checked.thinWalls));

if (failed > 0) {
  console.error(`looks: ${failed} failed`);
  process.exit(1);
}
console.log("looks: ok");
