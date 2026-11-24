/**
 * Seeing the result: render_view, the layer tools, and G-code reads.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { applyPose, inversePose, seatLift, thenPose, turnDir, typedPoseOf } from "../../src/model-space.ts";
import type { PathColumns } from "../../src/preview-wire.ts";
import { readsStress, type ColorMode } from "../../src/colors.ts";
import { ProtocolError } from "../engine.ts";
import { layerPaths, pathsPng, type LayerStress, pathsSvg } from "../layer-out.ts";
import { replyOffset } from "../../src/bed-offset.ts";
import { renderMesh, readBackground, readCamera, type Camera, type CameraSpec, type RenderOptions } from "../render.ts";
import { pngImage, withImages, type InlineImage } from "../inline.ts";
import { readVec3 } from "../../src/modeling/compose.ts";
import { typedPoint } from "../../src/modeling/typed-view.ts";
import { assemblyOf } from "../../src/assembly.ts";
import { resolveWrite } from "../workspace.ts";
import { type Ghost, LAYER_ROWS, type PlateObject, STRESS_LAYER_NEEDS, type ToolHandler, joinedPositions, posedPositions } from "./shared.ts";
import type { Session } from "../session.ts";
import { meantName, NEXT, refuse } from "../refusals.ts";

/** renders/<file>, or renders/<stem>-2.png and so on when that name is taken. */
function freshRenderPath(file: string): string {
  const stem = file.replace(/\.png$/i, "");
  for (let n = 1; ; n += 1) {
    const path = resolveWrite(join("renders", n === 1 ? `${stem}.png` : `${stem}-${n}.png`), ".png");
    if (!existsSync(path)) return path;
  }
}

async function renderView(this: Session, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const fit = input.fit as { min: [number, number, number]; max: [number, number, number] } | undefined;
  if (fit && (Object.keys(fit).some((key) => key !== "min" && key !== "max") || ![fit.min, fit.max].every((v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n))) || fit.min.some((v, i) => v > fit.max[i]!) || fit.min.every((v, i) => v === fit.max[i]))) return refuse("bad-view", "fit needs a finite nonempty box with min no greater than max.");
  const background = input.background === undefined ? undefined : readBackground(input.background);
  if (background && "reason" in background) return refuse("bad-view", background.reason);
  const obj = this.find(typeof input.object === "string" ? input.object : this.selected) ?? this.objects[0];
  if (!obj) return refuse("no-mesh", "Load a mesh first.", undefined, NEXT.mesh);
  const committed = await this.commitObject(obj);
  if (committed) return refuse("commit-failed", committed);
  // --- Assemblies M5. view draws several parts: the object's assembly as assembled, or the whole bed as it prints.
  if (input.view !== undefined) {
    if (input.view !== "assembly" && input.view !== "print") return refuse("bad-view", 'view is "assembly" or "print".');
    if (input.op !== undefined || input.section !== undefined || input.highlight !== undefined) return refuse("bad-view", "view draws several parts; op, section and highlight are for one part.");
  }
  const turntable = typeof input.turntable === "number" ? Math.round(input.turntable) : 0;
  const many = Array.isArray(input.views) || turntable > 1;
  // A turntable: views all round the part, a little from above, the first from the front.
  const around = Array.from({ length: turntable }, (_, k) => {
    const a = (k / turntable) * 2 * Math.PI;
    return { direction: [Math.round(-Math.sin(a) * 1e4) / 1e4, Math.round(-Math.cos(a) * 1e4) / 1e4, 0.45] };
  });
  const asked = turntable > 1 ? around : many ? input.views as unknown[] : [{ camera: input.camera, direction: input.direction, up: input.up }];
  const cameras: { label: string; camera: Camera | CameraSpec }[] = [];
  for (const raw of asked) {
    const read = readCamera(raw);
    if ("reason" in read) return refuse("bad-view", read.reason);
    cameras.push(read);
  }
  let ghost: Ghost | null = null;
  if (input.op !== undefined) {
    const made = await this.ghostMesh(obj, input.op);
    if ("reason" in made) return refuse("bad-view", made.reason);
    ghost = made;
  }
  // --- 3.1 F12. A section, a highlight or colours need the solid: a STEP import is opened for them here, as
  // model_describe would open it, instead of being refused until something else had.
  const looksAsked = input.section !== undefined || input.highlight !== undefined || input.colours !== undefined;
  if (looksAsked && !(obj.solid && obj.solid.positions.length >= 9) && !this.meshBlock(obj)) {
    try {
      const opened = await this.opened(obj);
      if ("reason" in opened) return refuse("model-unavailable", opened.reason);
    } catch (err) {
      if (err instanceof ProtocolError) return refuse("bad-view", err.message);
      throw err;
    }
  }
  const solidMesh = !!obj.solid && obj.solid.positions.length >= 9;
  const mesh = input.view === "assembly" || input.view === "print" ? this.viewMesh(obj, input.view) : fit ? posedPositions(solidMesh ? obj.solid!.positions : obj.source, solidMesh ? obj.modelPose : thenPose(seatLift(obj.seatMm), obj.modelPose)) : solidMesh ? obj.solid!.positions : this.placed(obj).positions;
  const multi = input.view === "assembly" || input.view === "print";
  const looks = this.renderLooks(obj, multi ? { ...input, colours: undefined } : input, solidMesh);
  if ("reason" in looks) return refuse("bad-view", looks.reason);
  const warnings = [...looks.warnings];
  const rows = multi ? viewRows(this, obj, input.view as "assembly" | "print") : [obj];
  const chosen = new Map<string, [number, number, number]>();
  if (multi && input.colours !== undefined) {
    if (!input.colours || typeof input.colours !== "object" || Array.isArray(input.colours)) return refuse("bad-view", "colours maps step labels to colours.");
    for (const [label, raw] of Object.entries(input.colours as Record<string, unknown>)) {
      const rgb = readHex(raw, `colours.${label}`);
      if ("reason" in rgb) return refuse("bad-view", rgb.reason);
      const owners = rows.filter((row) => this.labelBox(row, label, true));
      if (owners.length !== 1) {
        warnings.push({ reason: owners.length ? `colours.${label} is on more than one part; name the part in partColours.` : `No step is labelled "${label}", so colours.${label} was not drawn.` });
        continue;
      }
      chosen.set(owners[0]!.id, rgb);
      looks.legend.push({ label, rgb: `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}` });
    }
  }
  if (input.partColours !== undefined) {
    if (!input.partColours || typeof input.partColours !== "object" || Array.isArray(input.partColours)) return refuse("bad-view", "partColours maps part names or handles to colours.");
    for (const [name, raw] of Object.entries(input.partColours as Record<string, unknown>)) {
      const rgb = readHex(raw, `partColours.${name}`);
      if ("reason" in rgb) return refuse("bad-view", rgb.reason);
      const matches = rows.filter((row) => row.id === name || row.name === name);
      if (matches.length !== 1) {
        if (matches.length > 1) return refuse("bad-view", `Part name "${name}" is ambiguous; use its handle.`);
        const meant = meantName(name, rows.flatMap((row) => [row.name, row.id]));
        return refuse("bad-view", meant ? `No part named "${name}" is in this view; did you mean ${meant}?` : `No part named "${name}" is in this view.`);
      }
      chosen.set(matches[0]!.id, rgb);
    }
  }
  if (chosen.size > 0) {
    let start = 0;
    looks.options.partTints = [];
    const spans = multi
      ? rows.map((row) => {
        const solid = row.solid && row.solid.positions.length >= 9;
        return { id: row.id, count: (input.view === "print" ? this.placed(row).positions.length : solid ? row.solid!.positions.length : row.source.length) / 9 };
      })
      : [{ id: obj.id, count: mesh.length / 9 }];
    for (const span of spans) {
      const end = start + span.count;
      const rgb = chosen.get(span.id);
      if (rgb) looks.options.partTints.push({ start, end, rgb });
      start = end;
    }
  }
  // A single solid is normally drawn in its own frame; fixed boxes are in model space.
  if (fit && !input.view && solidMesh) {
    if (looks.options.section) looks.options.section = { point: applyPose(obj.modelPose, looks.options.section.point), normal: turnDir(obj.modelPose, looks.options.section.normal) };
    if (looks.options.tints?.length) looks.options.tintFrame = inversePose(obj.modelPose);
    if (ghost) ghost = { ...ghost, mesh: posedPositions(ghost.mesh, obj.modelPose) };
  }
  const stem = typeof input.name === "string" ? input.name.replace(/\.png$/i, "") : obj.name;
  const edge = typeof input.longEdge === "number" ? input.longEdge : 768;
  const views: { camera: string; path: string; width: number; height: number }[] = [];
  const pictures: InlineImage[] = [];
  cameras.forEach(({ label, camera }, index) => {
    const drawn = renderMesh(mesh, camera, edge, ghost?.mesh, { ...looks.options, ...(fit ? { fit } : { crop: true }), ...(background ? { background: background.rgb } : {}) });
    const file = many ? `${stem}-${label}${cameras.filter((row) => row.label === label).length > 1 ? `-${index + 1}` : ""}.png` : typeof input.name === "string" ? input.name : `${obj.name}-${label}.png`;
    // No name: the file goes to renders/ and never replaces an earlier one. A name is the caller's: it goes where it says.
    const path = typeof input.name === "string" ? resolveWrite(file, ".png") : freshRenderPath(file);
    writeFileSync(path, drawn.png);
    views.push({ camera: label, path, width: drawn.width, height: drawn.height });
    pictures.push(pngImage(drawn.png));
  });
  // --- 3.1 F5. Faces too small to see draw their edges as specks. They are the solid's own: a back cover's lattice
  // ribs broke through its rounded outer edge by 0.2 mm at every rib end, which read as a drawing fault.
  const tiny = solidMesh ? obj.solid!.faces.filter((face) => face.areaMm2 < 0.1) : [];
  const slivers = tiny.length
    ? { slivers: { count: tiny.length, frame: obj.frame ?? "model", at: tiny.slice(0, 3).map((face) => typedPoint(typedPoseOf(obj), face.centre).map((v) => Math.round(v * 100) / 100)), note: `${tiny.length} face${tiny.length === 1 ? " is" : "s are"} under 0.1 mm², drawn as specks: the solid has them, often where a step breaks through a thin wall. faces_find {nearPoint} at one names it.` } }
    : {};
  const note = { ...(ghost ? { ghost: { colour: "orange", touchesSolid: ghost.touches } } : {}), ...(looks.legend.length ? { colours: looks.legend } : {}), ...slivers };
  const body = many ? { ok: true, views, ...note, ...(warnings.length ? { warnings } : {}) } : { ok: true, ...views[0]!, ...note, ...(warnings.length ? { warnings } : {}) };
  return input.inline === false ? body : withImages(body, pictures);
}

/**
 * render_view's highlight, colours, section, and smooth, as the renderer takes them: label boxes and the section
 * plane in the solid's frame, where its mesh is.
 */
function readHex(raw: unknown, field: string): [number, number, number] | { reason: string } {
  const colour = typeof raw === "string" ? /^#?([0-9a-f]{6})$/i.exec(raw) : null;
  if (!colour) return { reason: `${field} is a colour like "#c86450".` };
  const n = parseInt(colour[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function renderLooks(this: Session, obj: PlateObject, input: Record<string, unknown>, solidMesh: boolean): { options: RenderOptions; legend: Record<string, unknown>[]; warnings: { reason: string }[] } | { reason: string } {
  // The solid's faces also let an edge line show only where its own faces are in front (--- 3.1 F5).
  const options: RenderOptions = { smooth: input.smooth !== false, ...(solidMesh ? { faces: obj.solid!.triangles } : {}) };
  const legend: Record<string, unknown>[] = [];
  const warnings: { reason: string }[] = [];
  const wanted: { label: string; rgb: [number, number, number]; colour: boolean }[] = [];
  const highlight = typeof input.highlight === "string" ? [input.highlight] : Array.isArray(input.highlight) ? input.highlight.map(String) : [];
  for (const label of highlight) wanted.push({ label, rgb: [255, 135, 30], colour: false });
  for (const [label, hex] of Object.entries((input.colours ?? {}) as Record<string, unknown>)) {
    const rgb = readHex(hex, `colours.${label}`);
    if ("reason" in rgb) return rgb;
    wanted.push({ label, rgb, colour: true });
  }
  if ((wanted.length || input.section !== undefined) && !solidMesh) return { reason: "highlight, colours, and section need a solid, and this part is a mesh (STL, OBJ or 3MF), which has none. Import its STEP file, or make the part with solid_new or model_build." };
  if (wanted.length) {
    options.tints = [];
    for (const { label, rgb, colour } of wanted) {
      const box = this.labelBox(obj, label, true);
      if (!box) {
        if (colour) {
          warnings.push({ reason: `No step is labelled "${label}", so colours.${label} was not drawn. model_anchors lists the labels.` });
          continue;
        }
        return { reason: `No step is labelled "${label}" with a tool to measure. model_anchors lists the labels.` };
      }
      options.tints.push({ min: box.min, max: box.max, rgb });
      legend.push({ label, rgb: `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}` });
    }
    if (options.tints.length === 0) delete options.tints;
  }
  if (input.section !== undefined) {
    const spec = input.section as { normal?: unknown; point?: unknown };
    const back = inversePose(typedPoseOf(obj));
    const bounds = obj.solid!.bounds;
    const centre = [0, 1, 2].map((i) => (bounds.min[i]! + bounds.max[i]!) / 2) as [number, number, number];
    const normal = readVec3(spec.normal, [0, -1, 0]);
    if (Math.hypot(...normal) < 1e-9) return { reason: "section.normal needs a direction." };
    options.section = {
      point: spec.point === undefined ? centre : applyPose(back, readVec3(spec.point, [0, 0, 0])),
      normal: turnDir(back, normal),
    };
  }
  return { options, legend, warnings };
}

/**
 * One triangle soup of several parts. "assembly": the members of `obj`'s assembly (every object, when it is in none) at
 * their poses in model space. "print": every object where it prints on the bed.
 */
function viewMesh(this: Session, obj: PlateObject, view: "assembly" | "print"): Float32Array {
  const shown = viewRows(this, obj, view);
  if (view === "print") return joinedPositions(shown.map((row) => this.placed(row).positions));
  return joinedPositions(shown.map((row) => {
    const solid = row.solid && row.solid.positions.length >= 9;
    return posedPositions(solid ? row.solid!.positions : row.source, solid ? row.modelPose : thenPose(seatLift(row.seatMm), row.modelPose));
  }));
}

function viewRows(session: Session, obj: PlateObject, view: "assembly" | "print"): PlateObject[] {
  if (view === "print") return session.objects;
  const members = assemblyOf(session.liveAssemblies(), obj.id)?.members.map((row) => row.object);
  return members ? session.objects.filter((row) => members.includes(row.id)) : session.objects;
}

function layerColumns(this: Session, input: Record<string, unknown>): { paths: PathColumns; z: number; index: number; offsets: [number, number][] } | { reason: string } {
  const job = this.finished(typeof input.job === "string" ? input.job : undefined);
  if (!job?.wire) return { reason: "Slice first." };
  const stale = this.staleReason(job);
  if (stale) return { reason: stale };
  const layers = Array.isArray(job.wire.layers) ? job.wire.layers as { z?: number; paths?: PathColumns }[] : [];
  const index = typeof input.layer === "number" ? input.layer : 0;
  const layer = layers[index];
  if (!layer?.paths || !Array.isArray(layer.paths.xy)) return { reason: "That layer has no paths." };
  const objects = job.wire.objects as { offset?: [number, number] }[] | undefined;
  const offsets = Array.isArray(objects) ? objects.map((obj) => replyOffset(obj.offset)) : [replyOffset(job.wire.offset as [number, number] | undefined)];
  return { paths: layer.paths, z: layer.z ?? 0, index, offsets };
}

function layerDetail(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const job = this.finished(typeof input.job === "string" ? input.job : undefined);
  if (!job?.wire) return refuse("not-sliced", "Slice first.", undefined, NEXT.slice);
  const stale = this.staleReason(job);
  if (stale) return refuse("stale-slice", stale, undefined, NEXT.slice);
  const layers = Array.isArray(job.wire.layers) ? job.wire.layers as { z?: number; seconds?: number; index?: number }[] : [];
  const span = Array.isArray(input.layers) ? input.layers : [0, Math.max(0, layers.length - 1)];
  const from = typeof span[0] === "number" ? span[0] : 0;
  const to = Math.min(typeof span[1] === "number" ? span[1] : from, layers.length - 1);
  // A page is every layer of an ordinary part; a long one comes in pages, with the cursor where the next starts.
  const at = typeof input.cursor === "string" ? Number(input.cursor) : from;
  const start = Number.isInteger(at) && at > from ? at : from;
  const end = Math.min(to, start + LAYER_ROWS - 1);
  const rows = layers.slice(start, end + 1).map((layer, offset) => ({
    index: layer.index ?? start + offset,
    z: layer.z ?? 0,
    ...(typeof layer.seconds === "number" ? { seconds: layer.seconds } : {}),
  }));
  return end < to ? { ok: true, rows, total: layers.length, nextCursor: String(end + 1) } : { ok: true, rows };
}

function layerPathsFile(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const layer = this.layerColumns(input);
  if ("reason" in layer) return refuse("layer-missing", layer.reason);
  const paths = layerPaths(layer.paths, layer.z, typeof input.simplifyMm === "number" ? input.simplifyMm : 0.05, layer.offsets);
  const text = pathsSvg(paths);
  const path = resolveWrite(typeof input.name === "string" ? input.name : `layer-${layer.index}.svg`, ".svg");
  writeFileSync(path, text);
  return { ok: true, path, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex"), paths: paths.length };
}

function layerImage(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const layer = this.layerColumns(input);
  if ("reason" in layer) return refuse("layer-missing", layer.reason);
  const colourBy: ColorMode = input.colourBy === "speed" || input.colourBy === "weight" || input.colourBy === "stress" || input.colourBy === "safety" ? input.colourBy : "feature";
  let stress: LayerStress | undefined;
  if (readsStress(colourBy)) {
    const cells = this.stressCells;
    if (!cells) return refuse("not-sliced", STRESS_LAYER_NEEDS, undefined, NEXT.slice);
    const objects = this.finished(typeof input.job === "string" ? input.job : undefined)?.wire?.objects;
    const ids = Array.isArray(objects) ? objects.map((o) => (o && typeof o === "object" ? (o as { id?: unknown }).id : undefined)) : null;
    // A plate reply names its objects; a one-object reply is the studied object's.
    const studied = (object: number) => !ids || cells.objectId === null || ids[object] === cells.objectId;
    stress = { cells, studied, layerZ: layer.z };
  }
  const paths = layerPaths(layer.paths, layer.z, 0.05, layer.offsets);
  const png = pathsPng(paths, typeof input.longEdge === "number" ? input.longEdge : 256, colourBy, stress);
  const path = resolveWrite(typeof input.name === "string" ? input.name : `layer-${layer.index}.png`, ".png");
  writeFileSync(path, png);
  const body = { ok: true, path, bytes: png.byteLength, sha256: createHash("sha256").update(png).digest("hex") };
  return input.inline === false ? body : withImages(body, [pngImage(png)]);
}

async function gcodeRead(this: Session, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const job = this.finished(typeof input.job === "string" ? input.job : undefined);
  if (!job?.wire) return refuse("not-sliced", "Slice first.", undefined, NEXT.slice);
  const gcode = await this.ensureGcode(job);
  if ("refusal" in gcode) return gcode.refusal;
  const stale = this.staleReason(job);
  if (stale) return refuse("stale-slice", stale, undefined, NEXT.slice);
  const lines = gcode.gcode.split("\n");
  const start = typeof input.fromLine === "number" ? Math.max(1, Math.round(input.fromLine)) : 1;
  const count = typeof input.count === "number" ? Math.min(500, Math.max(1, Math.round(input.count))) : 40;
  const grep = typeof input.grep === "string" ? input.grep : "";
  const rows: { line: number; text: string }[] = [];
  for (let index = start - 1; index < lines.length && rows.length < count; index += 1) {
    const text = lines[index] ?? "";
    if (grep && !text.includes(grep)) continue;
    rows.push({ line: index + 1, text });
  }
  return { ok: true, lines: rows, ...(rows.length === count ? { nextLine: (rows[rows.length - 1]?.line ?? start) + 1 } : {}) };
}

/** The methods this module adds to Session. */
export const layersMethods = {
  renderView,
  renderLooks,
  viewMesh,
  layerColumns,
  layerDetail,
  layerPathsFile,
  layerImage,
  gcodeRead,
};

export const layersHandlers: Record<string, ToolHandler> = {
  render_view: (s, input) => s.renderView(input),
  layer_detail: (s, input) => s.layerDetail(input),
  layer_paths: (s, input) => s.layerPathsFile(input),
  layer_image: (s, input) => s.layerImage(input),
  gcode_read: (s, input) => s.gcodeRead(input),
};
