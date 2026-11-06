/**
 * What the plate and the project file need of a study without the rest of the module: copy one exactly, and read a
 * saved one. Kept apart from ./study.ts so the first chunk carries this and not the canned beam, the field colours and
 * the verdict text, which load with the Model workspace.
 */
import type { ObjectStudy, SimPatternName, SimRepresentation, StudyBeam, StudyConstraint, StudyHold, StudyLoad, StudyPlace, StudyRegion, Vec3 } from "./study.ts";

export function cloneStudy(study: ObjectStudy): ObjectStudy {
  return {
    holds: study.holds.map((hold) => ({
      kind: hold.kind,
      faces: [...hold.faces],
      ...(hold.normal ? { normal: [...hold.normal] as Vec3 } : {}),
      ...(hold.origin ? { origin: [...hold.origin] as Vec3 } : {}),
      ...(hold.place ? { place: clonePlace(hold.place) } : {}),
    })),
    loads: study.loads.map((load) => ({
      kind: load.kind,
      faces: [...load.faces],
      magnitude: load.magnitude,
      direction: [...load.direction] as Vec3,
      ...(load.place ? { place: clonePlace(load.place) } : {}),
    })),
    cardId: study.cardId,
    printer: study.printer,
    buildAxis: [...study.buildAxis] as Vec3,
    gravity: study.gravity,
    edgeMm: study.edgeMm,
    ...(study.beam ? { beam: { ...study.beam } } : {}),
    ...(study.pattern ? { pattern: study.pattern } : {}),
    ...(study.representation ? { representation: study.representation } : {}),
    ...(study.constraints ? { constraints: study.constraints.map(cloneConstraint) } : {}),
    ...(study.facesKey ? { facesKey: study.facesKey } : {}),
  };
}

function clonePlace(place: StudyPlace): StudyPlace {
  if ("sphere" in place) return { sphere: { centre: [...place.sphere.centre] as Vec3, radiusMm: place.sphere.radiusMm } };
  return { box: { min: [...place.box.min] as Vec3, max: [...place.box.max] as Vec3 } };
}

function cloneRegion(region: StudyRegion): StudyRegion {
  return "faces" in region ? { faces: [...region.faces] } : clonePlace(region);
}

function cloneConstraint(row: StudyConstraint): StudyConstraint {
  return {
    kind: row.kind,
    value: row.value,
    ...(row.band ? { band: [row.band[0], row.band[1]] as [number, number] } : {}),
    ...(row.region ? { region: cloneRegion(row.region) } : {}),
    ...(row.other ? { other: cloneRegion(row.other) } : {}),
  };
}

/** A sphere `{centre, radiusMm}` or a box `{min, max}`, or null. */
export function readPlace(value: unknown): StudyPlace | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.sphere !== undefined && row.box === undefined) {
    const sphere = row.sphere;
    if (!sphere || typeof sphere !== "object" || Array.isArray(sphere)) return null;
    const centre = vec3((sphere as Record<string, unknown>).centre);
    const radiusMm = (sphere as Record<string, unknown>).radiusMm;
    if (!centre || !finite(radiusMm) || !(radiusMm > 0)) return null;
    return { sphere: { centre, radiusMm } };
  }
  if (row.box !== undefined && row.sphere === undefined) {
    const box = row.box;
    if (!box || typeof box !== "object" || Array.isArray(box)) return null;
    const min = vec3((box as Record<string, unknown>).min);
    const max = vec3((box as Record<string, unknown>).max);
    if (!min || !max || !(min[0] <= max[0] && min[1] <= max[1] && min[2] <= max[2])) return null;
    return { box: { min, max } };
  }
  return null;
}

/** Face indexes `{faces}`, or a place, or null. */
export function readRegion(value: unknown): StudyRegion | null {
  if (value && typeof value === "object" && !Array.isArray(value) && "faces" in value) {
    const faces = facesOf((value as Record<string, unknown>).faces);
    return faces && faces.length > 0 && Object.keys(value).length === 1 ? { faces } : null;
  }
  return readPlace(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function vec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(finite)) return null;
  return [value[0] as number, value[1] as number, value[2] as number];
}

function facesOf(value: unknown): number[] | null {
  if (!Array.isArray(value) || !value.every((item) => Number.isInteger(item) && (item as number) >= 0)) return null;
  return [...value] as number[];
}

/** A saved study, or null when the key is damaged and should be left out. */
export function readStudy(value: unknown): ObjectStudy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.holds) || !Array.isArray(row.loads)) return null;
  if (typeof row.cardId !== "string" || row.cardId.trim() === "") return null;
  if (typeof row.printer !== "boolean" || typeof row.gravity !== "boolean") return null;
  if (!finite(row.edgeMm) || row.edgeMm <= 0) return null;
  const buildAxis = vec3(row.buildAxis);
  if (!buildAxis) return null;
  const holds: StudyHold[] = [];
  for (const item of row.holds) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const hold = item as Record<string, unknown>;
    if (hold.kind !== "bed" && hold.kind !== "faces" && hold.kind !== "plane") return null;
    const faces = facesOf(hold.faces ?? []);
    if (!faces) return null;
    if (hold.kind === "plane") {
      const normal = vec3(hold.normal);
      const origin = vec3(hold.origin);
      if (!normal || !origin) return null;
      holds.push({ kind: "plane", faces, normal, origin });
      continue;
    }
    if (hold.place !== undefined) {
      const place = readPlace(hold.place);
      if (!place || hold.kind !== "faces") return null;
      holds.push({ kind: "faces", faces, place });
      continue;
    }
    holds.push({ kind: hold.kind, faces });
  }
  const loads: StudyLoad[] = [];
  for (const item of row.loads) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const load = item as Record<string, unknown>;
    if (load.kind !== "force" && load.kind !== "pressure") return null;
    const faces = facesOf(load.faces);
    const direction = vec3(load.direction);
    if (!faces || !direction || !finite(load.magnitude)) return null;
    if (load.place !== undefined) {
      const place = readPlace(load.place);
      if (!place) return null;
      loads.push({ kind: load.kind, faces, magnitude: load.magnitude, direction, place });
      continue;
    }
    loads.push({ kind: load.kind, faces, magnitude: load.magnitude, direction });
  }
  const patterns = new Set(["lines", "grid", "gyroid", "lightning"]);
  let pattern: SimPatternName | undefined;
  if (row.pattern !== undefined) {
    if (typeof row.pattern !== "string" || !patterns.has(row.pattern)) return null;
    pattern = row.pattern as SimPatternName;
  }
  let beam: StudyBeam | undefined;
  if (row.beam !== undefined) {
    if (!row.beam || typeof row.beam !== "object" || Array.isArray(row.beam)) return null;
    const box = row.beam as Record<string, unknown>;
    if (!finite(box.lengthMm) || !finite(box.widthMm) || !finite(box.heightMm)) return null;
    if ((box.lengthMm as number) <= 0 || (box.widthMm as number) <= 0 || (box.heightMm as number) <= 0) return null;
    beam = { lengthMm: box.lengthMm as number, widthMm: box.widthMm as number, heightMm: box.heightMm as number };
  }
  let representation: SimRepresentation | undefined;
  if (row.representation !== undefined) {
    if (row.representation !== "sliced" && row.representation !== "smear") return null;
    representation = row.representation;
  }
  let constraints: StudyConstraint[] | undefined;
  if (row.constraints !== undefined) {
    if (!Array.isArray(row.constraints)) return null;
    constraints = [];
    for (const item of row.constraints) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const target = item as Record<string, unknown>;
      if (typeof target.kind !== "string" || target.kind.trim() === "" || !finite(target.value)) return null;
      const band = target.band;
      if (band !== undefined && !(Array.isArray(band) && band.length === 2 && band.every(finite))) return null;
      if (band === undefined && target.value <= 0) return null;
      const region = target.region === undefined ? undefined : readRegion(target.region);
      const other = target.other === undefined ? undefined : readRegion(target.other);
      if (region === null || other === null) return null;
      constraints.push({
        kind: target.kind,
        value: target.value,
        ...(Array.isArray(band) ? { band: [band[0] as number, band[1] as number] as [number, number] } : {}),
        ...(region ? { region } : {}),
        ...(other ? { other } : {}),
      });
    }
  }
  return {
    holds,
    loads,
    cardId: row.cardId,
    printer: row.printer,
    buildAxis,
    gravity: row.gravity,
    edgeMm: row.edgeMm,
    ...(beam ? { beam } : {}),
    ...(pattern ? { pattern } : {}),
    ...(representation ? { representation } : {}),
    ...(constraints ? { constraints } : {}),
    ...(typeof row.facesKey === "string" && row.facesKey ? { facesKey: row.facesKey } : {}),
  };
}
