/**
 * Seeing and checking: images come back inline, cameras sit on the part's axes, a boolean's tool
 * shape is drawn without being applied, surface_at reads the mesh, a probe measures what it
 * changes, and model_check names what a print would trip over.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { fakeEngine } from "./engine.ts";
import { checkInSource, printCheck, probeMetrics, solidMetrics, surfaceAt } from "./inspect.ts";
import { printFrame } from "../src/model-check.ts";
import { handleRpc } from "./protocol.ts";
import { cameraBasis, readCamera, renderMesh } from "./render.ts";
import { TOOLS } from "./schema.ts";
import { Session } from "./session.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-seeing-"));
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
    positions.set([...corner(0), ...corner(1), ...corner(2)], (face * 2) * 9);
    positions.set([...corner(0), ...corner(2), ...corner(3)], (face * 2 + 1) * 9);
  });
  return positions;
}

function join3(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function pixels(png: Uint8Array, size: number): [number, number, number][] {
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
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 3 + 1);
    for (let x = 0; x < size; x += 1) out.push([raw[row + 1 + x * 3]!, raw[row + 2 + x * 3]!, raw[row + 3 + x * 3]!]);
  }
  return out;
}

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const nearVec = (a: ArrayLike<number>, b: number[], eps = 1e-6) => b.every((v, i) => near(a[i]!, v, eps));

// Cameras sit on the part's own axes.
const front = cameraBasis("front");
check("front looks at the -Y face from -Y, +X to the right, Z up", !("reason" in front) && nearVec(front.eye, [0, -1, 0]) && nearVec(front.right, [1, 0, 0]) && nearVec(front.up, [0, 0, 1]));
const back = cameraBasis("back");
check("back is from +Y with +X to the left", !("reason" in back) && nearVec(back.eye, [0, 1, 0]) && nearVec(back.right, [-1, 0, 0]));
const left = cameraBasis("left");
check("left is from -X", !("reason" in left) && nearVec(left.eye, [-1, 0, 0]) && nearVec(left.up, [0, 0, 1]));
const right = cameraBasis("right");
check("right is from +X", !("reason" in right) && nearVec(right.eye, [1, 0, 0]));
const top = cameraBasis("top");
check("top has +X right and +Y up", !("reason" in top) && nearVec(top.eye, [0, 0, 1]) && nearVec(top.right, [1, 0, 0]) && nearVec(top.up, [0, 1, 0]));
const bottom = cameraBasis("bottom");
check("bottom is from -Z", !("reason" in bottom) && nearVec(bottom.eye, [0, 0, -1]));
const iso = cameraBasis("iso");
check("iso is from -Y, +X and above", !("reason" in iso) && iso.eye[0] > 0 && iso.eye[1] < 0 && iso.eye[2] > 0);
const custom = cameraBasis({ direction: [0, 0, 5] });
check("a direction straight up still gets an up", !("reason" in custom) && near(Math.hypot(...custom.up), 1));
const along = cameraBasis({ direction: [1, 0, 0], up: [2, 0, 0] });
check("an up along the direction is refused", "reason" in along);
check("a zero direction is refused", "reason" in cameraBasis({ direction: [0, 0, 0] }));
check("a camera name that is not one is refused", "reason" in readCamera("sideways"));

// A column at x 0..5 stands on the left of the front view and the right of the back view.
const column = join3(box([0, 0, 0], [20, 10, 5]), box([0, 0, 0], [5, 10, 20]));
const topRow = (png: Uint8Array) => {
  const grid = pixels(png, 96);
  const row = grid.slice(0, 96 * 20);
  const hits = row.map((px, i) => (px[0] !== 248 ? i % 96 : -1)).filter((x) => x >= 0);
  return hits.length ? (Math.min(...hits) + Math.max(...hits)) / 2 : -1;
};
const frontCol = topRow(renderMesh(column, "front", 96).png);
const backCol = topRow(renderMesh(column, "back", 96).png);
check("the tall column is on the left of the front view", frontCol >= 0 && frontCol < 48, String(frontCol));
check("the tall column is on the right of the back view", backCol > 48, String(backCol));

// The ghost is orange and the part is not.
const ghostMesh = box([6, -4, 6], [14, 24, 14]);
const ghosted = pixels(renderMesh(box([0, 0, 0], [20, 20, 20]), "front", 96, ghostMesh).png, 96);
check("a ghost draws orange over the part", ghosted.filter((px) => px[0] > px[2] + 60).length > 100);
const plain = pixels(renderMesh(box([0, 0, 0], [20, 20, 20]), "front", 96).png, 96);
check("with no ghost nothing is orange", plain.filter((px) => px[0] > px[2] + 60).length === 0);

// Results over the protocol carry the image.
const engine = fakeEngine();
const session = new Session(engine);
const rpc = async (name: string, args: Record<string, unknown> = {}) => {
  const reply = await handleRpc(session, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return (reply?.result ?? {}) as { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError: boolean };
};
const call = (name: string, args: Record<string, unknown> = {}) => session.call(name, args);

const made = await call("solid_new", { dx: 20, dy: 20, dz: 20 });
const object = String(made.object);
const shot = await rpc("render_view", { object, camera: "front", name: "front.png", longEdge: 64 });
const text = JSON.parse(shot.content[0]!.text!) as { ok: boolean; path: string; camera: string };
const picture = shot.content[1];
check("render_view returns the path and one image", shot.content.length === 2 && picture?.type === "image" && picture.mimeType === "image/png" && text.ok === true && text.camera === "front", JSON.stringify(shot.content.map((c) => c.type)));
check("the inline image is the file's bytes", !!picture?.data && Buffer.from(picture.data, "base64").equals(readFileSync(text.path)));
check("the text part holds no pixels", shot.content[0]!.text!.length < 400);
const bare = await rpc("render_view", { object, camera: "front", name: "bare.png", longEdge: 64, inline: false });
check("inline false is the path alone", bare.content.length === 1);

const many = await rpc("render_view", { object, views: ["front", "back", { direction: [1, 1, 1] }], name: "set", longEdge: 64 });
const manyText = JSON.parse(many.content[0]!.text!) as { views: { camera: string; path: string }[] };
check("views gives one image per camera", many.content.length === 4 && manyText.views.length === 3 && manyText.views.map((v) => v.camera).join() === "front,back,custom", JSON.stringify(manyText));
check("each view has its own file", new Set(manyText.views.map((v) => v.path)).size === 3);
const badView = await call("render_view", { object, views: ["sideways"] });
check("a bad view is a sentence", badView.ok === false && /camera is one of/.test(String(badView.reason)), JSON.stringify(badView));

// The ghost preview changes nothing.
const callsBefore = engine.calls.filter((c) => c === "apply").length;
const cutOp = { kind: "boolean", op: "cut", primitive: "cylinder", radius: 3, height: 30, origin: [0, 0, -5] };
const ghostShot = await rpc("render_view", { object, camera: "iso", op: cutOp, name: "ghost.png", longEdge: 96 });
const ghostText = JSON.parse(ghostShot.content[0]!.text!) as { ok: boolean; ghost?: { colour: string; touchesSolid: boolean } };
const ghostPixels = pixels(Buffer.from(ghostShot.content[1]!.data!, "base64"), 96);
check("a ghost preview draws the tool in orange", ghostText.ok === true && ghostText.ghost?.touchesSolid === true && ghostPixels.filter((px) => px[0] > px[2] + 60).length > 50, JSON.stringify(ghostText));
check("a ghost preview applies nothing", engine.calls.filter((c) => c === "apply").length === callsBefore);
const described = await call("model_describe", { object, limit: 1 });
check("the solid is as it was", described.ok === true);
const holeGhost = await call("render_view", { object, op: { kind: "hole", diameterMm: 4, through: true } });
check("a preview of a hole is refused in a sentence", holeGhost.ok === false && holeGhost.reason === "A preview needs a boolean op.", JSON.stringify(holeGhost));
const apart = await call("render_view", { object, op: { kind: "boolean", op: "fuse", primitive: "box", dx: 5, dy: 5, dz: 5, origin: [100, 100, 100] }, name: "apart.png", longEdge: 64 });
check("a tool apart from the part says so", apart.ok === true && (apart.ghost as { touchesSolid: boolean }).touchesSolid === false, JSON.stringify(apart));

// layer_image is inline too.
const started = await call("slice_start", {});
await call("slice_wait", { job: started.job });
const layer = await rpc("layer_image", { job: started.job, layer: 0, longEdge: 64, name: "layer.png" });
check("layer_image returns the image inline", layer.content.length === 2 && layer.content[1]!.type === "image" && layer.content[1]!.mimeType === "image/png", JSON.stringify(layer.content.map((c) => c.type)));
const layerBare = await rpc("layer_image", { job: started.job, layer: 0, longEdge: 64, name: "layer2.png", inline: false });
check("layer_image inline false is the path alone", layerBare.content.length === 1);

// surface_at on a cube.
const solidTop = 20;
const roof = await call("surface_at", { object, x: 3, y: 4 });
check("roof height at x, y is the top", roof.ok === true && roof.hit === true && near((roof.point as number[])[2]!, solidTop, 1e-3) && nearVec(roof.normal as number[], [0, 0, 1], 1e-3), JSON.stringify(roof));
check("the hit names a face", typeof roof.faceIndex === "number", JSON.stringify(roof));
check("the distance is from the ray start", near(roof.distanceMm as number, 1, 1e-3), String(roof.distanceMm));
const side = await call("surface_at", { object, point: [-15, 0, 10], direction: [1, 0, 0] });
check("a ray from the side meets the -X face", side.hit === true && nearVec(side.normal as number[], [-1, 0, 0], 1e-3) && near(side.distanceMm as number, 5, 1e-2), JSON.stringify(side));
const miss = await call("surface_at", { object, x: 500, y: 500 });
check("a ray that misses says so", miss.ok === true && miss.hit === false && miss.reason === "The ray misses the solid.", JSON.stringify(miss));
const lone = await call("surface_at", { object, point: [1, 2, 3] });
check("a point without a direction is refused", lone.ok === false && lone.reason === "A point needs a direction.", JSON.stringify(lone));
const nothing = await call("surface_at", { object });
check("no ray is refused", nothing.ok === false && nothing.reason === "Give a point and a direction, or x and y.");
const inside = surfaceAt({ positions: box([0, 0, 0], [10, 10, 10]), triangles: new Uint32Array(12), bounds: { min: [0, 0, 0], max: [10, 10, 10] } }, { point: [5, 5, 5], direction: [0, 0, 1] });
check("a ray from inside is marked", inside.hit === true && inside.fromInside === true && near((inside.point as number[])[2]!, 10), JSON.stringify(inside));
const tilted = surfaceAt({ positions: box([0, 0, 0], [10, 10, 10]), triangles: new Uint32Array(12), bounds: { min: [0, 0, 0], max: [10, 10, 10] } }, { point: [5, 5, 30], direction: [0, 0, -3] });
check("a direction need not be a unit vector", tilted.hit === true && near(tilted.distanceMm as number, 20, 1e-3), JSON.stringify(tilted));

// Probe metrics.
const scaled = await call("model_probe", { object, op: { kind: "scale", factor: 2 } });
const scaledMetrics = scaled.metrics as { before: { volumeMm3: number }; after: { volumeMm3: number; bbox: { max: number[] } }; delta: { volumeMm3: number } };
check("a scale probe measures before and after", scaled.ok === true && near(scaledMetrics.after.volumeMm3, scaledMetrics.before.volumeMm3 * 8, 0.01) && near(scaledMetrics.delta.volumeMm3, scaledMetrics.before.volumeMm3 * 7, 0.01), JSON.stringify(scaled));
const holed = await call("model_probe", { object, op: { kind: "hole", diameterMm: 4, through: true, origin: [0, 0, 20], axis: [0, 0, -1] } });
const holeMetrics = holed.metrics as { after: { volumeMm3: number }; delta: { volumeMm3: number; shellCount: number }; unavailable?: string[] };
check("a hole probe returns the volume it takes", holed.ok === true && holeMetrics.delta.volumeMm3 < 0 && holeMetrics.delta.shellCount === 0 && !holeMetrics.unavailable, JSON.stringify(holed));
check("a probe that keeps one piece does not warn", !String(holed.reason).includes("separate"), String(holed.reason));
const slab = await call("model_probe", { object, op: { kind: "boolean", op: "cut", primitive: "box", dx: 4, dy: 40, dz: 40, origin: [-2, -20, -10] } });
const slabMetrics = slab.metrics as { after?: { shellCount: number } };
check("a cut that splits the part warns", slab.ok === true && slabMetrics.after?.shellCount === 2 && String(slab.reason).endsWith("This leaves 2 separate pieces."), JSON.stringify(slab));
check("the warning is its own field", slab.warning === "This leaves 2 separate pieces.");
const sliced = await call("model_probe", { object, op: { kind: "split", origin: [10, 10, 10], normal: [0, 0, 1] } });
check("a split probe says what it cannot measure", sliced.ok === true && (sliced.metrics as { unavailable?: string[] }).unavailable?.includes("volumeAfter") === true, JSON.stringify(sliced));
const before = solidMetrics({ positions: box([0, 0, 0], [10, 10, 10]), volumeMm3: 1000 });
const unmeasured = probeMetrics(before, null);
check("with no mesh after, only before is real", !("after" in unmeasured.metrics) && (unmeasured.metrics.unavailable as string[]).length === 4 && !!unmeasured.metrics.note && !unmeasured.warning);
const twoPieces = probeMetrics(before, solidMetrics({ positions: join3(box([0, 0, 0], [4, 10, 10]), box([6, 0, 0], [10, 10, 10])), volumeMm3: 800 }));
check("two pieces after one before is a warning", twoPieces.warning === "This leaves 2 separate pieces." && (twoPieces.metrics.delta as { shellCount: number }).shellCount === 1);
const refused = await call("model_probe", { object, op: { kind: "hole", diameterMm: 40, through: true } });
check("a refused probe has no metrics", refused.ok === false && refused.metrics === undefined, JSON.stringify(refused));

// model_check.
const cubeCheck = await call("model_check", { object });
check("a cube on the bed has contact and no overhang", cubeCheck.ok === true && (cubeCheck.bedContact as { areaMm2: number }).areaMm2 > 100 && (cubeCheck.overhang as { areaMm2: number }).areaMm2 === 0 && (cubeCheck.islands as unknown[]).length === 0, JSON.stringify(cubeCheck));
check("a cube has no thin walls", (cubeCheck.thinWalls as { regions: unknown[]; sampledPoints: number }).regions.length === 0 && (cubeCheck.thinWalls as { sampledPoints: number }).sampledPoints > 0, JSON.stringify(cubeCheck.thinWalls));
await call("object_place", { object, turn: { axis: "x", degrees: 30 } });
const grown = await call("model_check", { object });
check("model_check reads the plate's turn: a cube tipped 30° overhangs and rests on an edge", (grown.overhang as { areaMm2: number }).areaMm2 > 300 && (grown.bedContact as { areaMm2: number }).areaMm2 === 0, JSON.stringify([grown.overhang, grown.bedContact]));
await call("object_place", { object, turn: { axis: "x", degrees: -30 } });
check("the cube fits the bed", (cubeCheck.fit as { fits: boolean }).fits === true && typeof cubeCheck.printer === "string");

const build: [number, number, number] = [220, 220, 250];
const table = join3(box([0, 0, 10], [40, 40, 14]), box([0, 0, 0], [6, 6, 10]));
const tableCheck = printCheck({ positions: table, overhangDeg: 45, buildMm: build });
const ceilings = tableCheck.ceilings as { zMm: number; areaMm2: number }[];
check("a table top is a flat face pointing down above the bed", ceilings.length === 1 && near(ceilings[0]!.zMm, 10, 0.01) && ceilings[0]!.areaMm2 > 1400, JSON.stringify(tableCheck));
const overhang = tableCheck.overhang as { areaMm2: number; regions: { centre: number[] }[]; thresholdDeg: number };
check("the table top counts as overhang area but is listed once, as a ceiling", overhang.areaMm2 > 1400 && overhang.regions.length === 0 && overhang.thresholdDeg === 45, JSON.stringify(overhang.regions));
// A slope 40 mm wide crosses four 10 mm cells, and is still one region.
const slope = new Float32Array([0, 0, 10, 0, 20, 20, 40, 0, 10, 40, 0, 10, 0, 20, 20, 40, 20, 20]);
const sloped = printCheck({ positions: join3(box([0, 0, 0], [6, 6, 10]), slope), overhangDeg: 45, buildMm: build });
const slopeRegions = (sloped.overhang as { regions: { areaMm2: number; min: number[]; max: number[] }[] }).regions;
check("one slanted overhang over several cells is one region", slopeRegions.length === 1 && near(slopeRegions[0]!.areaMm2, 894.4, 0.1) && slopeRegions[0]!.min[0] === 0 && slopeRegions[0]!.max[0] === 40, JSON.stringify(slopeRegions));
check("it warns in sentences", (tableCheck.warnings as string[]).some((w) => w.startsWith("Flat faces point down above the bed at Z 10")));

// D13. The check reads the part as the plate turns it: a table laid upside down rests on its top and has no ceiling.
const upsideDown = [1, 0, 0, 0, -1, 0, 0, 0, -1];
const flipped = printFrame(table, upsideDown, 1);
const flippedCheck = checkInSource(printCheck({ positions: flipped.positions, overhangDeg: 45, buildMm: build }), flipped.toSource);
check("a table upside down has no 1600 mm² ceiling (the leg box's own end, inside the top, stays)", (flippedCheck.ceilings as { areaMm2: number }[]).every((row) => row.areaMm2 < 100), JSON.stringify(flippedCheck.ceilings));
check("it rests on its top", (flippedCheck.bedContact as { areaMm2: number }).areaMm2 > 1500, JSON.stringify(flippedCheck.bedContact));
const doubled = printFrame(box([0, 0, 0], [100, 100, 10]), [1, 0, 0, 0, 1, 0, 0, 0, 1], 2.5);
check("the plate's scale counts against the build volume", (printCheck({ positions: doubled.positions, overhangDeg: 45, buildMm: build }).fit as { over: string[] }).over.join() === "x,y");
// Turned on the bed, a place comes back in the solid's frame, where the caller aims an edit.
const spun = printFrame(table, [-1, 0, 0, 0, -1, 0, 0, 0, 1], 1);
const spunCheck = checkInSource(printCheck({ positions: spun.positions, overhangDeg: 45, buildMm: build }), spun.toSource);
check("a turned ceiling is named where it is on the solid", JSON.stringify((spunCheck.ceilings as { centre: number[] }[]).map((row) => row.centre)) === JSON.stringify(ceilings.map((row) => (row as unknown as { centre: number[] }).centre)), JSON.stringify([spunCheck.ceilings, ceilings]));
const gentle = printCheck({ positions: box([0, 0, 0], [10, 10, 10]), overhangDeg: 45, buildMm: build });
check("a face on the bed is contact, not overhang", (gentle.bedContact as { areaMm2: number }).areaMm2 > 99);
const strict = printCheck({ positions: table, overhangDeg: 89, buildMm: build });
check("the threshold moves the overhang", (strict.overhang as { areaMm2: number }).areaMm2 > 1400);
const floating = printCheck({ positions: join3(box([0, 0, 0], [10, 10, 10]), box([40, 0, 5], [50, 10, 15])), overhangDeg: 45, buildMm: build });
const islands = floating.islands as { floatsMm: number }[];
check("a piece off the bed is an island", islands.length === 1 && near(islands[0]!.floatsMm, 5, 0.01) && (floating.warnings as string[]).some((w) => w.includes("not touch the bed")), JSON.stringify(floating.islands));
const twoOnBed = printCheck({ positions: join3(box([0, 0, 0], [10, 10, 10]), box([40, 0, 0], [50, 10, 10])), overhangDeg: 45, buildMm: build });
check("two pieces on the bed are no island", (twoOnBed.islands as unknown[]).length === 0);
const big = printCheck({ positions: box([0, 0, 0], [300, 100, 10]), overhangDeg: 45, buildMm: build });
const fit = big.fit as { fits: boolean; over: string[] };
check("a part past the build volume says which axis", fit.fits === false && fit.over.join() === "x" && (big.warnings as string[]).some((w) => w === "The part is larger than the build volume along X."));
const mesh = await call("mesh_import", { path: new URL("../samples/calibration_cube_20mm.stl", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
const meshCheck = await call("model_check", { object: mesh.object });
check("a mesh is refused in a sentence", meshCheck.ok === false && typeof meshCheck.reason === "string", JSON.stringify(meshCheck));

// The tools are listed.
const names = TOOLS.map((tool) => tool.name);
check("surface_at and model_check are listed", names.includes("surface_at") && names.includes("model_check"));
const renderTool = TOOLS.find((tool) => tool.name === "render_view")!;
check("render_view says one image per view", String(renderTool.description).includes("one image each"));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("seeing: ok");
