/**
 * Stress studies: sim_setup, sim_run, sim_field, sim_sweep, and sim_cancel.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { bytesToBase64 } from "../../src/base64.ts";
import { fnv1aHex } from "../../src/slice-action.ts";
import { ID_MATRIX, placeMesh, type Mat3, type RigidPose } from "../../src/mesh-place.ts";
import { boundsOf } from "../../src/modeling/model-calls.ts";
import { parseStressCells } from "../../src/sim/stress-cells.ts";
import { patternBlend } from "../../src/sim/pattern-patch.ts";
import { resolved } from "../../src/strategy.ts";
import { recipeRefusal, simRecipe } from "../../src/sim/recipe.ts";
import { chooseStudyMesh, STUDY_MESH_REFUSAL, type StudyMesh } from "../../src/sim/study-mesh.ts";
import { beltLayerNormal, cloneStudy, namesFaces, placeRegion, readRegion, type ObjectStudy, type SimRepresentation, type StudyConstraint, type StudyHold, type StudyLoad, type StudyRegion, type Vec3 as SimVec } from "../../src/sim/study.ts";
import { LABEL } from "../../src/sim/label.ts";
import { readBeadSection, withBeads } from "../../src/sim/cards.ts";
import { BEAM_SIZE, OPEN_MESH, SLICED_FIELD, SLICED_SWEEP, RESLICE_BEAM, RESLICE_PARAMETERS, RESLICE_PATTERN_KEEP, SWEEP_CAP, SWEEP_REFUSAL, ZERO_AXIS, axisLength, boxPositions, constraintVerdict, elementRefusal, pageCursor, pageLimit, readLimits, readPatch, representationOf, runSolver, scaleLoads, setupSentence, solverJob, vec3Of, type ConstraintLimits, type SweepPatch } from "../sim.ts";
import { cardsOf, saveMaterialCard } from "../../src/ui/machine-library.ts";
import { stlBytes } from "../request.ts";
import { applyObjectSetting } from "../settings-rows.ts";
import { BAND_KINDS, BEADS_REFUSAL, PLACE_ON_SMEAR, type PlateObject, REGION_SHAPE, STALE_FACES, STIFFNESS_KINDS, TARGET_KINDS, type ToolHandler, UNKNOWN_OBJECT, slicedRunReply, stlFileName } from "./shared.ts";
import type { Session } from "../session.ts";
import { NEXT, refuse } from "../refusals.ts";

/** The file Export writes, so the review sees the printer's start and end text. */
function printerBuildAxis(this: Session): SimVec {
  const printer = this.printer();
  return printer.kind === "belt" ? beltLayerNormal(printer.belt.angleDeg) : [0, 0, 1];
}

function readFixtures(this: Session, value: unknown): StudyHold[] | { reason: string } {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return { reason: "Fixtures are a list." };
  const holds: StudyHold[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { reason: "A fixture is an object." };
    const row = item as Record<string, unknown>;
    if (row.kind === "bed") {
      holds.push({ kind: "bed", faces: [] });
      continue;
    }
    if (row.kind === "faces") {
      if (!Array.isArray(row.faces) || !row.faces.every((face) => Number.isInteger(face) && (face as number) >= 0)) return { reason: "Face indexes are whole numbers." };
      holds.push({ kind: "faces", faces: [...row.faces] as number[] });
      continue;
    }
    if (row.kind === "plane") {
      const normal = vec3Of(row.normal);
      const origin = vec3Of(row.origin);
      if (!normal || !origin) return { reason: "A plane needs a normal and an origin." };
      holds.push({ kind: "plane", faces: [], normal, origin });
      continue;
    }
    if (row.kind === "region") {
      const region = readRegion(row.region);
      if (!region) return { reason: REGION_SHAPE };
      holds.push("faces" in region ? { kind: "faces", faces: region.faces } : { kind: "faces", faces: [], place: region });
      continue;
    }
    return { reason: "A fixture is a bed, faces, a plane, or a region." };
  }
  return holds;
}

function readLoads(this: Session, value: unknown): StudyLoad[] | { reason: string } {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return { reason: "Loads are a list." };
  const loads: StudyLoad[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { reason: "A load is an object." };
    const row = item as Record<string, unknown>;
    if (row.kind !== "force" && row.kind !== "pressure") return { reason: "A load is a force or a pressure." };
    if (typeof row.magnitude !== "number" || !Number.isFinite(row.magnitude)) return { reason: "The load magnitude has to be a number." };
    const direction = vec3Of(row.direction) ?? [0, 0, -1];
    if (row.region !== undefined) {
      if (row.faces !== undefined) return { reason: "A load is on faces or on a region, not both." };
      const region = readRegion(row.region);
      if (!region) return { reason: REGION_SHAPE };
      if ("faces" in region) loads.push({ kind: row.kind, faces: region.faces, magnitude: row.magnitude, direction });
      else loads.push({ kind: row.kind, faces: [], magnitude: row.magnitude, direction, place: region });
      continue;
    }
    if (!Array.isArray(row.faces) || !row.faces.every((face) => Number.isInteger(face) && (face as number) >= 0)) return { reason: "Face indexes are whole numbers." };
    loads.push({ kind: row.kind, faces: [...row.faces] as number[], magnitude: row.magnitude, direction });
  }
  return loads;
}

function simCard(this: Session, value: unknown) {
  const cards = cardsOf(this.library);
  const fallback = cards.find((card) => card.id === "inhouse-petg") ?? cards[0];
  if (!fallback) return { reason: "That card is not in the library." } as const;
  if (value === undefined) return fallback;
  if (typeof value === "string") return cards.find((card) => card.id === value) ?? ({ reason: "That card is not in the library." } as const);
  if (!value || typeof value !== "object" || Array.isArray(value)) return { reason: "That card is not in the library." } as const;
  const row = value as Record<string, unknown>;
  const base = (typeof row.id === "string" ? cards.find((card) => card.id === row.id) : undefined) ?? fallback;
  const num = (key: string, current: number) => (typeof row[key] === "number" && Number.isFinite(row[key] as number) ? (row[key] as number) : current);
  const beads = row.beads === undefined ? base.beads : readBeadSection(row.beads);
  if (beads === null) return { reason: BEADS_REFUSAL } as const;
  return {
    ...base,
    id: typeof row.id === "string" && row.id.trim() ? row.id : base.id,
    polymer: typeof row.polymer === "string" && row.polymer.trim() ? row.polymer : base.polymer,
    provisional: row.provisional === false ? false : row.provisional === true ? true : base.provisional,
    EInPlaneMPa: num("EInPlaneMPa", base.EInPlaneMPa),
    EAcrossLayersMPa: num("EAcrossLayersMPa", base.EAcrossLayersMPa),
    nu: num("nu", base.nu),
    strengthInPlaneMPa: num("strengthInPlaneMPa", base.strengthInPlaneMPa),
    strengthAcrossLayersMPa: num("strengthAcrossLayersMPa", base.strengthAcrossLayersMPa),
    compressionInPlaneMPa: num("compressionInPlaneMPa", base.compressionInPlaneMPa),
    compressionAcrossLayersMPa: num("compressionAcrossLayersMPa", base.compressionAcrossLayersMPa),
    shearAcrossLayersMPa: num("shearAcrossLayersMPa", base.shearAcrossLayersMPa),
    densityGCm3: num("densityGCm3", base.densityGCm3),
    specimen: typeof row.specimen === "string" ? row.specimen : base.specimen,
    source: typeof row.source === "string" ? row.source : base.source,
    isotropic: row.isotropic === undefined ? base.isotropic : row.isotropic === true,
    beads,
  };
}

function beamOf(this: Session, value: unknown): ObjectStudy["beam"] | { reason: string } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { reason: BEAM_SIZE };
  const box = value as Record<string, unknown>;
  if (typeof box.lengthMm !== "number" || typeof box.widthMm !== "number" || typeof box.heightMm !== "number") return { reason: BEAM_SIZE };
  if (!(box.lengthMm > 0) || !(box.widthMm > 0) || !(box.heightMm > 0)) return { reason: BEAM_SIZE };
  return { lengthMm: box.lengthMm, widthMm: box.widthMm, heightMm: box.heightMm };
}

function simSetup(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const element = elementRefusal(input.element);
  if (element) return refuse("bad-argument", element);
  const beam = this.beamOf(input.beam);
  if (beam && "reason" in beam) return refuse("bad-beam", beam.reason);
  const fixtures = this.readFixtures(input.fixtures);
  if ("reason" in fixtures) return refuse("bad-fixture", fixtures.reason);
  const loads = this.readLoads(input.loads);
  if ("reason" in loads) return refuse("bad-load", loads.reason);
  const card = this.simCard(input.card);
  if ("reason" in card) return refuse("no-card", card.reason);
  const printer = input.printer === true;
  let buildAxis: SimVec = printer ? this.printerBuildAxis() : [0, 0, 1];
  if (!printer && input.buildAxis !== undefined) {
    const axis = vec3Of(input.buildAxis);
    if (!axis) return refuse("bad-beam", ZERO_AXIS);
    buildAxis = axis;
  }
  if (axisLength(buildAxis) <= 1e-12) return refuse("bad-beam", ZERO_AXIS);
  let edge = 5;
  if (input.hMm !== undefined) {
    if (typeof input.hMm !== "number" || !(input.hMm > 0)) return refuse("bad-beam", BEAM_SIZE);
    edge = input.hMm;
  }
  let representation: SimRepresentation | undefined;
  if (input.representation !== undefined) {
    if (input.representation !== "sliced" && input.representation !== "smear") return refuse("bad-representation", "representation is sliced or smear.");
    representation = input.representation;
  }
  const constraints = this.readSimConstraints(input.constraints);
  if (constraints && "reason" in constraints) return refuse("bad-target", constraints.reason);
  const requested = typeof input.object === "string" ? input.object : "";
  let obj = requested ? this.find(requested) : this.selectedObject();
  if (requested && !obj) return refuse("no-object", UNKNOWN_OBJECT, undefined, NEXT.plate);
  if (!obj && !beam) return refuse("no-mesh", "Load a mesh first.", undefined, NEXT.mesh);
  this.remember("Stress");
  if (!obj && beam) {
    const source = boxPositions(beam.lengthMm, beam.widthMm, beam.heightMm);
    obj = this.addObject({
      name: "beam",
      fileName: "beam.stl",
      bytes: stlBytes(source, "beam.stl"),
      source,
      triangles: source.length / 9,
      orient: [...ID_MATRIX] as Mat3,
      scale: 1,
      centered: false,
      offset: { x: 0, y: 0, z: 0 },
      seatMm: 0,
    });
  }
  if (!obj) return refuse("no-mesh", "Load a mesh first.", undefined, NEXT.mesh);
  if (input.card && typeof input.card === "object") this.library = saveMaterialCard(this.library, card);
  const study: ObjectStudy = {
    holds: fixtures,
    loads,
    cardId: card.id,
    printer,
    buildAxis,
    gravity: input.gravity === true,
    edgeMm: edge,
    ...(beam ? { beam } : {}),
    ...(obj.sim?.pattern ? { pattern: obj.sim.pattern } : {}),
    ...(representation ? { representation } : {}),
    ...(constraints ? { constraints } : {}),
  };
  if (namesFaces(study)) study.facesKey = this.shapeKey(obj);
  obj.sim = study;
  return { ok: true, object: obj.id, study, sentence: setupSentence(study, card.polymer, card.provisional), label: LABEL };
}

function smearOf(this: Session, obj: PlateObject, patch?: SweepPatch) {
  return simRecipe({
    toughness: this.settings.toughness,
    layerHeightMm: this.settings.layerHeight,
    lineWidthMm: Math.min(1.2, Math.max(0.2, this.library.nozzleMm * 1.125)),
    blendKind: this.settings.blendKind === "weight" || this.settings.blendKind === "byLayer" || this.settings.blendKind === "byRegion" ? this.settings.blendKind : "single",
    strategy: this.settings.strategy === "toughness" ? "toughness" : "speed",
    object: { walls: patch?.walls ?? obj.objectSettings.walls, infill: patch?.infill ?? obj.objectSettings.infill },
    overrides: this.overrides,
    reinforcementDensities: obj.reinforcement.map((region) => region.density),
  });
}

function solveCopy(this: Session, obj: PlateObject, patch: SweepPatch | undefined, op: "run" | "field", field?: Record<string, unknown>): Record<string, unknown> {
  const saved = obj.sim;
  if (!saved) return refuse("no-study", "Set up a study first.", undefined, NEXT.study);
  const stale = this.staleFaces(obj, saved);
  if (stale) return refuse("stale-slice", stale, undefined, NEXT.slice);
  if (saved.holds.some((hold) => hold.place) || saved.loads.some((load) => load.place)) return refuse("bad-representation", PLACE_ON_SMEAR);
  const study = cloneStudy(saved);
  if (study.printer) study.buildAxis = this.printerBuildAxis();
  if (patch?.loadScale) study.loads = scaleLoads(study.loads, patch.loadScale);
  if (patch?.pattern) study.pattern = patch.pattern;
  const recipe = this.smearOf(obj, patch);
  const refused = recipeRefusal(recipe);
  if (refused) return refuse("bad-card", refused);
  const card = cardsOf(this.library).find((row) => row.id === study.cardId);
  if (!card) return refuse("no-card", "That card is not in the library.");
  const pattern = study.pattern ?? recipe.pattern;
  const job = solverJob({
    op,
    study,
    card,
    walls: recipe.walls,
    infill: recipe.infill,
    pattern: pattern === "lines" || pattern === "grid" || pattern === "gyroid" || pattern === "lightning" ? pattern : undefined,
    field: typeof field?.field === "string" ? field.field : undefined,
    points: field?.points as SimVec[] | undefined,
    box: field?.box as { min: SimVec; max: SimVec } | undefined,
    face: typeof field?.face === "number" ? field.face : undefined,
    stride: typeof field?.stride === "number" ? field.stride : undefined,
    limit: typeof field?.limit === "number" ? field.limit : undefined,
    cursor: typeof field?.cursor === "number" ? field.cursor : undefined,
  });
  if ("reason" in job) return refuse("no-object", String(job.reason), undefined, NEXT.plate);
  const reply = runSolver(job);
  if (Array.isArray(reply.triangles)) delete reply.triangles;
  if (Array.isArray(reply.nodes)) delete reply.nodes;
  if ("stiffness" in reply) delete reply.stiffness;
  return reply;
}

async function simRun(this: Session, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const obj = this.simTarget(input);
  if ("reason" in obj) return refuse("no-object", obj.reason, undefined, NEXT.plate);
  const saved = obj.sim;
  if (!saved) return refuse("no-study", "Set up a study first.", undefined, NEXT.study);
  const reply = this.representationFor(obj, saved) === "sliced"
    ? await this.solveSliced(obj, saved, input.checkResolution !== false)
    : this.solveCopy(obj, undefined, "run");
  if (reply.ok === true && input.includeSlicerMass === true) {
    const estimate = this.freshEstimate();
    if (estimate) reply.slicerGrams = estimate.grams;
  }
  return reply;
}

function representationFor(this: Session, obj: PlateObject, study: ObjectStudy): SimRepresentation {
  return representationOf({
    asked: study.representation,
    beam: study.beam !== undefined,
    printerId: this.library.printerId,
    fileName: obj.fileName,
  });
}

/** The solver's kinds and its refusal sentences (`lime-sim` sliced_study.rs), so a refusal reads the same either way. */
function readSimConstraints(this: Session, value: unknown): StudyConstraint[] | { reason: string } | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return { reason: "Constraints are a list of targets." };
  if (value.length > 8) return { reason: "A study takes up to 8 targets." };
  const out: StudyConstraint[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { reason: "A target is an object." };
    const row = item as Record<string, unknown>;
    if (typeof row.kind !== "string" || !TARGET_KINDS.includes(row.kind)) return { reason: `A target is ${TARGET_KINDS.join(", ")}.` };
    const band = BAND_KINDS.has(row.kind);
    let pair: [number, number] | undefined;
    if (band) {
      const lo = Array.isArray(row.band) ? row.band[0] : undefined;
      const hi = Array.isArray(row.band) ? row.band[1] : undefined;
      if (!Array.isArray(row.band) || row.band.length !== 2 || typeof lo !== "number" || typeof hi !== "number" || !Number.isFinite(lo) || !Number.isFinite(hi) || !(lo >= 0) || !(hi > lo)) {
        return { reason: "A band needs two numbers, the lower first." };
      }
      pair = [lo, hi];
    } else if (typeof row.value !== "number" || !(row.value > 0) || !Number.isFinite(row.value)) return { reason: "A target has to be a positive number." };
    const region = row.region === undefined ? undefined : readRegion(row.region);
    const other = row.other === undefined ? undefined : readRegion(row.other);
    if (region === null || other === null) return { reason: REGION_SHAPE };
    if (STIFFNESS_KINDS.has(row.kind) && !region) return { reason: "A stiffness target needs the region it reads." };
    if (row.kind === "relativeDeflectionMm" && (!region || !other)) return { reason: "A relative deflection needs two regions, region and other." };
    out.push({
      kind: row.kind,
      value: band ? 0 : (row.value as number),
      ...(pair ? { band: pair } : {}),
      ...(region ? { region } : {}),
      ...(other ? { other } : {}),
    });
  }
  return out;
}

/** The solid the face indexes are picked on, as a key. A Model edit changes it. */
function shapeKey(this: Session, obj: PlateObject): string {
  const positions = obj.solid && obj.solid.positions.length >= 9 ? obj.solid.positions : obj.source;
  return fnv1aHex(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength));
}

/** A study that names faces, run on a solid edited since it was set up. Never solve on renumbered faces. */
function staleFaces(this: Session, obj: PlateObject, study: ObjectStudy): string | null {
  if (!study.facesKey || !namesFaces(study)) return null;
  return study.facesKey === this.shapeKey(obj) ? null : STALE_FACES;
}

/**
 * The mesh the study slices: the solid the faces were picked on, scaled the
 * same way, or the committed plate mesh when that is the same shape.
 * A triangle-count difference is not the test. A box parameter keeps the count.
 */
function studyMesh(this: Session, obj: PlateObject): StudyMesh | { reason: string } {
  const committed = !obj.treeStale && obj.bytes.byteLength > 0 && (!obj.tree || obj.platedNode === obj.tree.current);
  const solid = obj.solid;
  const choice = chooseStudyMesh({
    picked: solid && solid.positions.length >= 9 ? solid.positions : null,
    pickedTriangles: solid?.triangles ?? null,
    plate: obj.source.length >= 9 ? obj.source : null,
    scale: obj.scale,
    committed,
  });
  if (!choice) return { reason: STUDY_MESH_REFUSAL };
  if ("reason" in choice) return choice;
  return choice;
}

/** The pose of the tessellation being sliced, when it is not the plate mesh. */
function studyPose(this: Session, obj: PlateObject, unscaled: Float32Array): RigidPose | null {
  if (unscaled === obj.source) return null;
  const printer = this.printer();
  return placeMesh(unscaled, obj.orient, obj.scale, printer.bedX, printer.bedY, obj.centered, obj.offset).pose;
}

/** Face index of each triangle. A generated beam with no solid pairs triangles into faces. */
function faceIds(this: Session, obj: PlateObject, study: ObjectStudy, count: number, triangleIds: ArrayLike<number> | null): number[] | null {
  if (triangleIds && triangleIds.length === count) return Array.from(triangleIds);
  if (study.beam && !obj.solid) return Array.from({ length: count }, (_, index) => Math.floor(index / 2));
  return null;
}

/**
 * A region's triangles in the mesh frame, before the pose. A generated beam
 * stores clockwise corners, so those are reversed to face outward.
 */
function slicedRegion(
  this: Session, obj: PlateObject,
  study: ObjectStudy,
  faces: number[],
  role: "hold" | "load" | "target",
  corners: Float32Array,
  triangleIds: ArrayLike<number> | null,
): Record<string, unknown> | { reason: string } {
  if (faces.length === 0) {
    if (role === "hold") return { reason: "A hold's region touches no surface of the sliced part." };
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < corners.length; i += 3) {
      const x = corners[i] ?? 0;
      const y = corners[i + 1] ?? 0;
      const z = corners[i + 2] ?? 0;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    if (!Number.isFinite(minX)) return { reason: "Pick a face to load, or type its index." };
    const span = Math.max(1e-3, maxX - minX);
    const thick = Math.min(1, span * 0.05);
    return { kind: "box", min: [maxX - thick, minY, minZ], max: [maxX, maxY, maxZ] };
  }
  const count = Math.floor(corners.length / 9);
  const ids = this.faceIds(obj, study, count, triangleIds);
  if (!ids) return { reason: "That face is not on this part." };
  const want = new Set(faces);
  const reverse = study.beam !== undefined && obj.solid === null;
  const triangles: [number, number, number][][] = [];
  for (let tri = 0; tri < count; tri += 1) {
    if (!want.has(ids[tri] ?? -1)) continue;
    const at = tri * 9;
    const corner = (offset: number): [number, number, number] => [corners[at + offset] ?? 0, corners[at + offset + 1] ?? 0, corners[at + offset + 2] ?? 0];
    const a = corner(0);
    const b = corner(3);
    const c = corner(6);
    triangles.push(reverse ? [a, c, b] : [a, b, c]);
  }
  if (triangles.length === 0) {
    return { reason: `A ${role}'s region touches no surface of the sliced part.` };
  }
  return { kind: "faces", triangles };
}

/**
 * Solve the object as it is sliced. A sweep `patch` changes that one slice (walls, infill, the pattern) and
 * scales the loads, without touching the plate.
 */
async function solveSliced(this: Session, obj: PlateObject, saved: ObjectStudy, checkResolution = true, patch?: SweepPatch): Promise<Record<string, unknown>> {
  const stale = this.staleFaces(obj, saved);
  if (stale) return refuse("stale-slice", stale, undefined, NEXT.slice);
  const study = cloneStudy(saved);
  if (patch?.loadScale !== undefined && patch.loadScale !== 1) study.loads = scaleLoads(study.loads, patch.loadScale);
  if (study.printer) study.buildAxis = this.printerBuildAxis();
  if (study.holds.some((hold) => hold.kind === "plane")) return refuse("bad-representation", "A plane hold is not on a sliced study. Hold the bed or faces.");
  if (!study.holds.some((hold) => hold.kind === "bed" || hold.faces.length > 0 || hold.place)) return refuse("no-load", "Nothing is held.");
  const card = cardsOf(this.library).find((row) => row.id === study.cardId);
  if (!card) return refuse("no-card", "That card is not in the library.");
  const { body } = this.sliceBody(obj, "object");
  body.includePreview = false;
  body.includeGcode = false;
  delete body.sim;
  const mesh = this.studyMesh(obj);
  if ("reason" in mesh) return refuse("open-mesh", mesh.reason);
  const encoded = bytesToBase64(stlBytes(mesh.positions, stlFileName(obj.fileName)));
  const pose = this.studyPose(obj, mesh.unscaled);
  if (Array.isArray(body.objects)) {
    const first = body.objects[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const row = first as Record<string, unknown>;
      row.dataB64 = encoded;
      if (pose) row.pose = pose;
    }
  } else {
    body.dataB64 = encoded;
    if (pose) body.pose = pose;
  }
  if (obj.objectSettings.walls !== undefined && !Array.isArray(body.objects)) body.walls = obj.objectSettings.walls;
  if (obj.objectSettings.infill !== undefined && !Array.isArray(body.objects)) body.infill = obj.objectSettings.infill;
  if (patch) this.patchSliceBody(body, obj, patch);
  // A place is in the model frame; the sliced mesh is scaled about its source's centre.
  const box = boundsOf(mesh.unscaled);
  const centre: SimVec = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const regionOf = (region: StudyRegion, role: "hold" | "load" | "target") =>
    "faces" in region ? this.slicedRegion(obj, study, region.faces, role, mesh.positions, mesh.triangles) : placeRegion(region, centre, obj.scale);
  const holds: Record<string, unknown>[] = [];
  for (const hold of study.holds) {
    if (hold.kind === "bed") {
      holds.push({ kind: "bed" });
      continue;
    }
    const region = regionOf(hold.place ?? { faces: hold.faces }, "hold");
    if ("reason" in region) return refuse("bad-region", region.reason as string);
    holds.push({ kind: "region", region });
  }
  const loads: Record<string, unknown>[] = [];
  for (const load of study.loads) {
    const region = load.place
      ? placeRegion(load.place, centre, obj.scale)
      : this.slicedRegion(obj, study, load.faces, "load", mesh.positions, mesh.triangles);
    if ("reason" in region) return refuse("bad-region", region.reason as string);
    if (load.kind === "pressure") {
      loads.push({ kind: "pressure", region, mpa: load.magnitude });
      continue;
    }
    const n = Math.hypot(load.direction[0], load.direction[1], load.direction[2]);
    if (!(n > 1e-12)) return refuse("no-load", "The load direction has zero length.");
    loads.push({
      kind: "force",
      region,
      force: [load.direction[0] / n * load.magnitude, load.direction[1] / n * load.magnitude, load.direction[2] / n * load.magnitude],
    });
  }
  if (loads.length === 0) return refuse("no-load", "This study has no load.");
  const targets: Record<string, unknown>[] = [];
  for (const row of study.constraints ?? []) {
    const target: Record<string, unknown> = { kind: row.kind, value: row.value, ...(row.band ? { band: row.band } : {}) };
    for (const key of ["region", "other"] as const) {
      const given = row[key];
      if (!given) continue;
      const region = regionOf(given, "target");
      if ("reason" in region) return refuse("bad-region", region.reason as string);
      target[key] = region;
    }
    targets.push(target);
  }
  const sent: Record<string, unknown> = { ...withBeads(card) };
  for (const [key, value] of Object.entries(sent)) if (value === null || value === undefined) delete sent[key];
  const payload = JSON.stringify({
    request: body,
    study: {
      ...(study.edgeMm > 0 ? { hXy: study.edgeMm } : {}),
      card: sent,
      holds,
      loads,
      ...(targets.length > 0 ? { constraints: targets } : {}),
      checkResolution,
    },
  });
  let text: string;
  try {
    text = await Promise.resolve(this.engine.simStudy(payload));
  } catch (err) {
    return refuse("solve-failed", err instanceof Error && err.message ? err.message : "The stress solve did not finish.");
  }
  this.stressCells = parseStressCells(text, obj.id) ?? this.stressCells;
  return slicedRunReply(text, study.constraints ?? []);
}

/**
 * A sweep variant's print settings on a one-object slice body: on the object's own settings when the body lists
 * it, else on the body. A pattern is a blend, which would also move walls and infill with its toughness, so they
 * are pinned to what the object prints now, as the desktop's sweep does.
 */
function patchSliceBody(this: Session, body: Record<string, unknown>, obj: PlateObject, patch: SweepPatch): void {
  const row = Array.isArray(body.objects) && body.objects[0] && typeof body.objects[0] === "object"
    ? (body.objects[0] as Record<string, unknown>)
    : null;
  const target: Record<string, unknown> = row
    ? ((row.settings && typeof row.settings === "object" ? row.settings : (row.settings = {})) as Record<string, unknown>)
    : body;
  if (patch.walls !== undefined) target.walls = patch.walls;
  if (patch.infill !== undefined) target.infill = patch.infill;
  if (patch.pattern) {
    const width = Math.min(1.2, Math.max(0.2, this.library.nozzleMm * 1.125));
    const card = resolved(this.settings.toughness, this.settings.layerHeight, width);
    target.blend = patternBlend(patch.pattern);
    if (target.walls === undefined) target.walls = obj.objectSettings.walls ?? card.walls;
    if (target.infill === undefined) target.infill = obj.objectSettings.infill ?? card.density;
  }
}

/** A sliced sweep: each variant one slice of the object alone and one solve. */
async function slicedSweep(this: Session, obj: PlateObject, patches: SweepPatch[], limits: ConstraintLimits, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (patches.some((patch) => patch.parameters)) return refuse("bad-representation", RESLICE_PARAMETERS);
  const saved = obj.sim!;
  // One cell size per variant unless asked: a sweep compares variants, and a second size doubles each solve.
  const checkResolution = input.checkResolution === true;
  type SweepRow = Record<string, unknown> & { ok?: boolean; met: boolean; reason: string };
  const rows: SweepRow[] = [];
  for (const patch of patches) {
    const solved = await this.solveSliced(obj, saved, checkResolution, patch);
    if (solved.ok !== true) {
      rows.push({ ok: false, code: "solve-failed", met: false, reason: typeof solved.reason === "string" ? solved.reason : "The stress solve did not finish." });
      continue;
    }
    const verdict = constraintVerdict({
      maxDisplacementMm: typeof solved.maxDisplacementMm === "number" ? solved.maxDisplacementMm : 0,
      minSafetyFactor: typeof solved.minSafetyFactor === "number" ? solved.minSafetyFactor : null,
      massG: typeof solved.massG === "number" ? solved.massG : 0,
    }, limits);
    rows.push({ ...solved, met: verdict.met, reason: verdict.reason });
  }
  let committed = false;
  if (input.commit === true) {
    const index = typeof input.variant === "number" ? input.variant : patches.length === 1 ? 0 : -1;
    if (!Number.isInteger(index) || index < 0 || index >= patches.length) return refuse("bad-sweep", "Name the variant to keep.", { variants: rows });
    const chosen = rows[index];
    if (!chosen || chosen.ok === false) return refuse("solve-failed", typeof chosen?.reason === "string" ? chosen.reason : "The stress solve did not finish.", { variants: rows });
    if (patches[index]!.pattern) return refuse("bad-representation", RESLICE_PATTERN_KEEP, { variants: rows });
    this.remember("Sweep");
    this.applySweepPatch(obj, patches[index]!);
    committed = true;
  }
  return { ok: true, variants: rows, committed, note: "Each variant was sliced alone and solved. slicerSeconds and slicerGrams are that slice's." };
}

function simField(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const obj = this.simTarget(input);
  if ("reason" in obj) return refuse("no-object", obj.reason, undefined, NEXT.plate);
  if (obj.sim && this.representationFor(obj, obj.sim) === "sliced") return refuse("bad-representation", SLICED_FIELD);
  const field = typeof input.field === "string" ? input.field : "";
  const names = ["displacement", "von_mises", "stress", "safety_factor", "element_error"];
  if (!names.includes(field)) return refuse("bad-field-query", `Unknown field. This result has ${names.join(", ")}.`);
  let points: SimVec[] | undefined;
  if (input.points !== undefined) {
    if (!Array.isArray(input.points)) return refuse("bad-field-query", "A point is three numbers.");
    points = [];
    for (const item of input.points) {
      const point = vec3Of(item);
      if (!point) return refuse("bad-field-query", "A point is three numbers.");
      points.push(point);
    }
  }
  let box: { min: SimVec; max: SimVec } | undefined;
  if (input.box !== undefined) {
    if (!input.box || typeof input.box !== "object" || Array.isArray(input.box)) return refuse("bad-field-query", "A box needs a min and a max.");
    const row = input.box as { min?: unknown; max?: unknown };
    const min = vec3Of(row.min);
    const max = vec3Of(row.max);
    if (!min || !max) return refuse("bad-field-query", "A box needs a min and a max.");
    box = { min, max };
  }
  let face: number | undefined;
  if (input.face !== undefined) {
    if (!Number.isInteger(input.face) || (input.face as number) < 0) return refuse("face-not-found", "That face is not on this beam.", undefined, NEXT.faces);
    face = input.face as number;
  }
  let stride: number | undefined;
  if (input.stride !== undefined) {
    if (!Number.isInteger(input.stride) || (input.stride as number) < 1) return refuse("bad-field-query", "A stride starts at 1.");
    stride = input.stride as number;
  }
  if (!points && !box && face === undefined && stride === undefined) return refuse("bad-field-query", "Name points, a box, a face, or a stride.");
  return this.solveCopy(obj, undefined, "field", { field, points, box, face, stride, limit: pageLimit(input.limit), cursor: pageCursor(input.cursor) });
}

function simTarget(this: Session, input: Record<string, unknown>): PlateObject | { reason: string } {
  const requested = typeof input.object === "string" ? input.object : "";
  const obj = requested ? this.find(requested) : this.selectedObject();
  if (!obj) return { reason: requested ? UNKNOWN_OBJECT : "Load a mesh first." };
  return obj;
}

function sweepPatchProblem(this: Session, patch: SweepPatch): string | null {
  if (patch.parameters) {
    const merged = this.mergeParams(patch.parameters);
    if ("reason" in merged && typeof merged.reason === "string") return merged.reason;
  }
  if (patch.walls !== undefined) {
    const applied = applyObjectSetting(this.settings, "walls", patch.walls, this.schemaContext());
    if ("reason" in applied) return applied.reason;
  }
  if (patch.infill !== undefined) {
    const applied = applyObjectSetting(this.settings, "infill", patch.infill, this.schemaContext());
    if ("reason" in applied) return applied.reason;
  }
  return null;
}

function applySweepPatch(this: Session, obj: PlateObject, patch: SweepPatch): void {
  if (patch.parameters) this.paramsTool({ set: patch.parameters });
  const next = { ...obj.objectSettings };
  if (patch.walls !== undefined) {
    const applied = applyObjectSetting(this.settings, "walls", patch.walls, this.schemaContext());
    if (!("reason" in applied)) next.walls = applied.value as number;
  }
  if (patch.infill !== undefined) {
    const applied = applyObjectSetting(this.settings, "infill", patch.infill, this.schemaContext());
    if (!("reason" in applied)) next.infill = applied.value as number;
  }
  obj.objectSettings = next;
  if (!obj.sim) return;
  const study = cloneStudy(obj.sim);
  if (patch.pattern) study.pattern = patch.pattern;
  if (patch.loadScale !== undefined && patch.loadScale !== 1) study.loads = scaleLoads(study.loads, patch.loadScale);
  obj.sim = study;
}

async function simSweep(this: Session, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!Array.isArray(input.variants)) return refuse("bad-sweep", SWEEP_REFUSAL);
  if (input.variants.length > SWEEP_CAP) return refuse("bad-sweep", SWEEP_REFUSAL);
  const patches: SweepPatch[] = [];
  for (const item of input.variants) {
    const patch = readPatch(item);
    if (typeof patch === "string") return refuse("bad-sweep", patch);
    const problem = this.sweepPatchProblem(patch);
    if (problem) return refuse("bad-sweep", problem);
    patches.push(patch);
  }
  const limits = readLimits(input.constraints);
  if (typeof limits === "string") return refuse("bad-sweep", limits);
  const obj = this.simTarget(input);
  if ("reason" in obj) return refuse("no-object", obj.reason, undefined, NEXT.plate);
  const sliced = obj.sim !== undefined && this.representationFor(obj, obj.sim) === "sliced";
  if (sliced && input.reslice !== true) return refuse("bad-representation", SLICED_SWEEP);
  if (!sliced && input.reslice === true) return refuse("bad-representation", RESLICE_BEAM);
  if (sliced) return this.slicedSweep(obj, patches, limits as ConstraintLimits, input);
  type SweepRow = Record<string, unknown> & { ok?: boolean; met: boolean; reason: string; slicerSeconds?: number };
  const rows: SweepRow[] = patches.map((patch): SweepRow => {
    const solved = this.solveCopy(obj, patch, "run");
    if (solved.ok !== true) return { ok: false, code: "solve-failed", met: false, reason: typeof solved.reason === "string" ? solved.reason : OPEN_MESH };
    const verdict = constraintVerdict({
      maxDisplacementMm: typeof solved.maxDisplacementMm === "number" ? solved.maxDisplacementMm : 0,
      minSafetyFactor: typeof solved.minSafetyFactor === "number" ? solved.minSafetyFactor : null,
      massG: typeof solved.massG === "number" ? solved.massG : 0,
    }, limits as ConstraintLimits);
    return { ...solved, met: verdict.met, reason: verdict.reason };
  });
  const commit = input.commit === true;
  let committed = false;
  if (commit) {
    const index = typeof input.variant === "number" ? input.variant : patches.length === 1 ? 0 : -1;
    if (!Number.isInteger(index) || index < 0 || index >= patches.length) return refuse("bad-sweep", "Name the variant to keep.", { variants: rows });
    const chosen = rows[index];
    if (!chosen || chosen.ok === false) return refuse("solve-failed", typeof chosen?.reason === "string" ? chosen.reason : OPEN_MESH, { variants: rows });
    this.remember("Sweep");
    this.applySweepPatch(obj, patches[index]!);
    committed = true;
  }
  let note = "";
  if (input.includePrintTime === true) {
    const estimate = this.freshEstimate();
    if (estimate) {
      for (const row of rows) row.slicerSeconds = estimate.seconds;
      note = "The slicer's estimate.";
    } else note = "Print time was not estimated.";
  }
  return { ok: true, variants: rows, committed, ...(note ? { note } : {}) };
}

/** The methods this module adds to Session. */
export const stressMethods = {
  printerBuildAxis,
  readFixtures,
  readLoads,
  simCard,
  beamOf,
  simSetup,
  smearOf,
  solveCopy,
  simRun,
  representationFor,
  readSimConstraints,
  shapeKey,
  staleFaces,
  studyMesh,
  studyPose,
  faceIds,
  slicedRegion,
  solveSliced,
  patchSliceBody,
  slicedSweep,
  simField,
  simTarget,
  sweepPatchProblem,
  applySweepPatch,
  simSweep,
};

export const stressHandlers: Record<string, ToolHandler> = {
  sim_setup: (s, input) => s.simSetup(input),
  sim_run: (s, input) => s.simRun(input),
  sim_field: (s, input) => s.simField(input),
  sim_sweep: (s, input) => s.simSweep(input),
  sim_cancel: () => ({ ok: true, label: LABEL }),
};
