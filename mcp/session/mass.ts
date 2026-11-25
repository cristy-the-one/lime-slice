/**
 * model_mass (docs/plan-mass-properties.md): volume, mass and where it comes from, centre of gravity, principal inertia,
 * and about a hinge or a line the inertia, the lever arm and the compound-pendulum period, of the body a part belongs
 * to. The computation is src/mass.ts, which the Pose panel shares.
 */
import { assemblyOf, type Assembly } from "../../src/assembly.ts";
import { aboutAxis, bodyOf, G_MM_S2, integralsAtVolume, movingBody, partIntegrals, principal, swing, withMass, type BodyPart, type MassBody } from "../../src/mass.ts";
import { applyPose, IDENTITY_POSE, inversePose, seatLift, thenPose, turnDir, type Affine } from "../../src/model-space.ts";
import { filamentGrams } from "../../src/estimate.ts";
import { NEXT, refuse } from "../refusals.ts";
import { shownName, type PlateObject } from "./shared.ts";
import type { Session } from "../session.ts";

type Vec3 = [number, number, number];

/** The kinds of bead a slice lays inside the part: what its printed mass is made of. Supports, skirt and brim are not. */
const PART_BEADS = new Set(["wall", "outer", "inner", "thin-wall", "gap-fill", "infill", "sparse", "solid", "top", "bridge", "ironing"]);

const mm = (value: number) => Math.round(value * 1e4) / 1e4 + 0;
const sig = (value: number) => Number(value.toPrecision(6)) + 0;
const unit = (v: readonly number[]) => v.map((value) => Math.round(value * 1e6) / 1e6 + 0);

function vec3(value: unknown): Vec3 | null {
  return Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === "number" && Number.isFinite(v)) ? [value[0], value[1], value[2]] : null;
}

/** The part's mesh and the pose into model space it is weighed at: its solid if Model holds one, else its plate mesh on its seat. */
function meshOf(part: PlateObject): { positions: Float32Array; pose: Affine } {
  const solid = !!part.solid && part.solid.positions.length >= 9;
  return solid ? { positions: part.solid!.positions, pose: part.modelPose } : { positions: part.source, pose: thenPose(seatLift(part.seatMm), part.modelPose) };
}

interface Sliced {
  grams: number;
  job: string;
  leftOutGrams: number;
  /** The session's latest slice, or an earlier one of this part alone. */
  latest: boolean;
}

/**
 * The grams of this part's own beads in the newest retained slice of it alone that still matches the plate, or why
 * there are none to offer (null: no finished slice at all). A plate slice gives one total, so it is not used; a
 * project does not store slices, so only slices made in this session count.
 */
function slicedGrams(s: Session, part: PlateObject, bodyParts: readonly string[]): Sliced | { reason: string } | null {
  const done = s.jobs.filter((row) => row.status === "done" && !!row.wire);
  if (done.length === 0) return null;
  if (bodyParts.length !== 1) return { reason: "The body is several parts and a slice gives one total, so sliced grams are not offered for it. part:true weighs this part alone." };
  const alone = done.filter((row) => row.slicedIds.length === 1 && row.slicedIds[0] === part.id);
  const job = alone.filter((row) => !s.staleReason(row)).at(-1);
  if (!job) {
    if (alone.length > 0) return { reason: `The slices of ${shownName(part.name)} alone no longer match the plate or its settings, so their grams are not offered: slice again (select it and slice_start {scope:"object"}).` };
    return { reason: `No slice in this session is of ${shownName(part.name)} alone, so no sliced grams are offered: select it and slice_start {scope:"object"}. A plate slice gives one total.` };
  }
  if (Math.abs(part.scale - 1) > 1e-9) return { reason: `The plate prints ${shownName(part.name)} at ${sig(part.scale * 100)} %, so the sliced grams are not of the solid weighed here.` };
  const rows = ((job.wire?.estimate as { byFeature?: { kind: string; filamentMm: number }[] } | undefined)?.byFeature ?? []);
  const filament = s.filament();
  const spec = { filamentDiameter: filament.diameterMm, filamentDensityGCm3: filament.densityGCm3, filamentCostPerKg: filament.costPerKg };
  let own = 0, other = 0;
  for (const row of rows) {
    if (PART_BEADS.has(row.kind)) own += row.filamentMm;
    else if (row.kind !== "travel") other += row.filamentMm;
  }
  if (!(own > 0)) return { reason: "The last slice reports no beads of the part by feature, so its grams are not offered." };
  return { grams: filamentGrams(own, spec), job: job.handle, leftOutGrams: filamentGrams(other, spec), latest: job === s.latest };
}

/** The hinge the body turns on, in model space, or why `about:"hinge"` cannot use one. */
function hingeOf(s: Session, assembly: Assembly | undefined, body: string): { point: Vec3; axis: Vec3 } | { reason: string } {
  const member = assembly?.members.find((row) => row.object === body);
  const part = s.find(body);
  const name = shownName(part?.name ?? body);
  if (!assembly || !member || !part) return { reason: `${name} is in no assembly, so it has no hinge: give about {point, axis}.` };
  const joint = member.joint;
  if (joint?.kind !== "hinge") {
    const has = joint?.kind === "slide" ? "slides on a slide joint" : joint?.kind === "ball" ? "turns on a ball joint" : member.parent === null ? "is the fixed root" : "has no joint";
    return { reason: `${name}, the part this one moves with, ${has}, so there is no hinge to turn about: give about {point, axis}.` };
  }
  // The pivot and axis are in the member's own part frame.
  return { point: applyPose(part.modelPose, joint.pivot), axis: turnDir(part.modelPose, joint.axis) };
}

export async function modelMass(s: Session, obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const density = input.density;
  if (density !== undefined && !(typeof density === "number" && density > 0 && density <= 25)) return refuse("bad-argument", "density is the material's density in g/cm³, above 0 and at most 25.");
  const about = input.about;
  let line: { point: Vec3; axis: Vec3 } | null = null;
  if (about !== undefined && about !== "hinge") {
    const row = about && typeof about === "object" && !Array.isArray(about) ? about as Record<string, unknown> : {};
    const point = vec3(row.point), axis = vec3(row.axis);
    if (!point || !axis) return refuse("bad-argument", 'about is "hinge" or {point, axis}, each three numbers in mm in the part\'s frame.');
    if (Math.hypot(...axis) === 0) return refuse("bad-argument", "The axis has no direction.");
    line = { point, axis };
  }

  if (input.part !== undefined && typeof input.part !== "boolean") return refuse("bad-argument", "part is true or false: true weighs this part alone, not the parts that move with it.");
  const alone = input.part === true;
  const assembly = assemblyOf(s.liveAssemblies(), obj.id);
  const moving = assembly ? movingBody(assembly, obj.id) : null;
  const bodyId = alone ? obj.id : moving?.body ?? obj.id;
  const ids = alone ? [obj.id] : moving?.parts ?? [obj.id];
  const leftOut = alone ? (moving?.parts ?? []).filter((id) => id !== obj.id) : [];
  const filament = s.filament();
  const densityGCm3 = typeof density === "number" ? density : filament.densityGCm3;
  const parts: BodyPart[] = [];
  const rows: Record<string, unknown>[] = [];
  let anyExact = false;
  for (const id of ids) {
    const part = s.find(id);
    if (!part) continue;
    const mesh = meshOf(part);
    const measured = partIntegrals(mesh.positions, shownName(part.name));
    if ("reason" in measured) return refuse("open-mesh", measured.reason, { object: part.id }, "Call model_check on that part for its open edges.");
    // The volume a person reads is the solid's exact measure. Mass and inertia follow it; the centre stays the mesh's.
    const exact = part.tree ? await s.readExact(part) : undefined;
    if (typeof exact === "number") anyExact = true;
    const integrals = typeof exact === "number" ? integralsAtVolume(measured, exact) : measured;
    parts.push({ integrals, pose: mesh.pose, densityGCm3 });
    const one = bodyOf([{ integrals, pose: mesh.pose, densityGCm3 }]);
    rows.push({ object: part.id, name: shownName(part.name), volumeMm3: sig(one.volumeMm3), grams: sig(one.massG) });
  }
  if (parts.length === 0) return refuse("no-object", "This part has no mesh to weigh.", undefined, NEXT.plate);
  const body = bodyOf(parts);

  // Numbers answer in the frame the part's numbers are typed in: model space, or its own frame (model_place {frame:"part"}).
  const frame = obj.frame ?? "model";
  const toModel: Affine = frame === "part" ? obj.modelPose : IDENTITY_POSE;
  const fromModel = inversePose(toModel);
  const point = (p: readonly number[]) => applyPose(fromModel, p).map(mm);
  const direction = (d: readonly number[]) => unit(turnDir(fromModel, d));

  const notes: string[] = [];
  const source = typeof density === "number" ? `density ${density} g/cm³ as given` : `the filament ${filament.name} (${filament.densityGCm3} g/cm³)`;
  notes.push(anyExact
    ? `Mass of a solid body: its volume, the solid's exact measure, at ${source}. The centre of gravity is from the closed mesh. A printed part with walls and infill weighs less.`
    : `Mass of a solid body: its volume, from the closed mesh, at ${source}. A printed part with walls and infill weighs less.`);
  if (ids.length > 1) notes.push(`The body is ${ids.length} parts that move together (${rows.map((row) => row.name).join(", ")}), at their assembled poses. part:true weighs ${shownName(obj.name)} alone.`);
  if (leftOut.length > 0) notes.push(`part:true: ${shownName(obj.name)} alone; ${leftOut.length === 1 ? "the other part that moves with it" : `the ${leftOut.length} other parts that move with it`} (${leftOut.map((id) => shownName(s.find(id)?.name ?? id)).join(", ")}) ${leftOut.length === 1 ? "is" : "are"} left out.`);
  const principalOf = (one: MassBody) => {
    const p = principal(one.inertiaGmm2);
    return { momentsGmm2: p.momentsGmm2.map(sig), axes: p.axes.map(direction) };
  };

  let aboutReply: Record<string, unknown> | undefined;
  let axisLine: { point: Vec3; axis: Vec3 } | null = null;
  if (about === "hinge") {
    const hinge = hingeOf(s, assembly, bodyId);
    if ("reason" in hinge) return refuse("bad-argument", hinge.reason, { object: obj.id });
    axisLine = hinge;
  } else if (line) {
    axisLine = { point: applyPose(toModel, line.point), axis: turnDir(toModel, line.axis) };
  }
  if (axisLine) {
    const measured = aboutAxis(body, axisLine.point, axisLine.axis);
    if ("reason" in measured) return refuse("bad-argument", measured.reason);
    const swung = swing(body, axisLine.point, axisLine.axis);
    aboutReply = {
      kind: about === "hinge" ? "hinge" : "axis",
      pointMm: point(axisLine.point),
      axis: direction(axisLine.axis),
      inertiaGmm2: sig(measured.inertiaGmm2),
      leverMm: mm(measured.leverMm),
      ...("reason" in swung
        ? { noPeriod: swung.reason }
        : { pendulum: { periodS: sig(swung.periodS), lengthMm: mm(swung.lengthMm), gravityMmS2: sig(swung.gravityMmS2), offRestDeg: Math.round(swung.offRestDeg * 100) / 100 + 0 } }),
    };
    if (!("reason" in swung)) {
      const tilted = Math.abs(swung.gravityMmS2 - G_MM_S2) > 1e-6 * G_MM_S2;
      notes.push(`The period is for small swings about rest, the centre of gravity straight below the axis, under gravity ${G_MM_S2} mm/s² along −Z of model space${tilted ? `; the axis is tilted, so only ${sig(swung.gravityMmS2)} mm/s² of it acts across the axis` : ""}. Pivot friction and air are not counted. lengthMm is the simple pendulum with the same period.`);
      if (swung.offRestDeg > 0.5) notes.push(`As posed, the part is turned ${Math.round(swung.offRestDeg * 10) / 10}° from rest.`);
    }
  }

  // Sliced grams, when the latest slice is of this part alone.
  const part = s.find(bodyId) ?? obj;
  const sliced = slicedGrams(s, part, ids);
  let slicedReply: Record<string, unknown> | undefined;
  let slicedNot: string | undefined;
  if (sliced && "reason" in sliced) slicedNot = sliced.reason;
  else if (sliced) {
    const ratio = sliced.grams / body.massG;
    const printed = withMass(body, sliced.grams);
    const measured = axisLine ? aboutAxis(printed, axisLine.point, axisLine.axis) : null;
    slicedReply = {
      grams: sig(sliced.grams),
      job: sliced.job,
      massRatio: sig(ratio),
      principalMomentsGmm2: principal(printed.inertiaGmm2).momentsGmm2.map(sig),
      ...(measured && !("reason" in measured) ? { inertiaGmm2: sig(measured.inertiaGmm2) } : {}),
      leftOutGrams: sig(sliced.leftOutGrams),
    };
    notes.push(`Sliced: ${sig(sliced.grams)} g of the part's own beads in ${sliced.latest ? "the last slice" : "an earlier slice of this part alone"} (${sliced.job}; supports, skirt and brim left out), at the filament's ${filament.densityGCm3} g/cm³. Its inertia is the solid's scaled by ${sig(ratio)}, which assumes the printed mass is spread as the solid's is; walls are denser than infill, so it is not exactly. The period and the equivalent length do not change with that scaling.`);
  }

  const basis = slicedReply
    ? `mass.grams is the solid at ${densityGCm3} g/cm³ (${typeof density === "number" ? "the density given" : `the filament ${filament.name}`}); sliced.grams is from the slice ${String(slicedReply.job)} of ${shownName(part.name)} alone.`
    : `mass.grams is the solid at ${densityGCm3} g/cm³ (${typeof density === "number" ? "the density given" : `the filament ${filament.name}`}); no slice was used.`;
  return {
    ok: true,
    object: obj.id,
    body: bodyId,
    ...(alone ? { part: true } : {}),
    basis,
    ...(bodyId !== obj.id ? { bodyName: shownName(part.name) } : {}),
    parts: rows,
    volumeMm3: sig(body.volumeMm3),
    mass: { grams: sig(body.massG), source: "solid", densityGCm3, from: typeof density === "number" ? "density" : "filament" },
    frame,
    centreOfGravityMm: point(body.centreMm),
    ...(frame === "part" ? { centreOfGravityModelMm: body.centreMm.map(mm) } : {}),
    principalInertia: principalOf(body),
    ...(aboutReply ? { about: aboutReply } : {}),
    ...(slicedReply ? { sliced: slicedReply } : {}),
    ...(slicedNot ? { slicedNot } : {}),
    note: notes.join(" "),
  };
}
