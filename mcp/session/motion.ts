/**
 * motion_run (docs/plan-hinge-dynamics.md): an assembly run in time under gravity, a drive and friction, as a job. The
 * model, the runs and the report are src/motion.ts, which the Pose panel's worker shares; this file reads the plate,
 * gives the event loop a turn between slices (so slice_wait and slice_cancel are heard), and writes frames through
 * pose_animate's writer.
 */
import { assemblyOf } from "../../src/assembly.ts";
import { seatLift, thenPose } from "../../src/model-space.ts";
import { animationRig, sampleAnimationSteps, type AnimationPart, type AnimationResult } from "../../src/pose-anim.ts";
import { DEFAULTS, LIMITS, motionJob, prepareMotion, type MotionSpec } from "../../src/motion.ts";
import type { DynPart } from "../../src/dynamics.ts";
import { eventLoopTurn } from "../animation-run.ts";
import { join } from "node:path";
import { BACKGROUND, readBackground, readCamera } from "../render.ts";
import { resolveWrite } from "../workspace.ts";
import { NEXT, refuse } from "../refusals.ts";
import { posedPositions, shownName, type CallMeta, type ToolHandler } from "./shared.ts";
import { readFrameLooks } from "./animation.ts";
import type { Session } from "../session.ts";

type Input = Record<string, unknown>;
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

async function motionRun(this: Session, input: Input, meta?: CallMeta): Promise<Record<string, unknown>> {
  const obj = this.find(typeof input.object === "string" ? input.object : this.selected);
  if (!obj) return refuse("no-mesh", "Choose an assembly member first.", undefined, NEXT.mesh);
  const assembly = assemblyOf(this.liveAssemblies(), obj.id);
  if (!assembly) return refuse("no-assembly", `${shownName(obj.name)} is in no assembly: a run moves an assembly's jointed parts.`);
  const member = (value: unknown, field: string): string | { reason: string } => {
    if (typeof value !== "string") return { reason: `${field} names a part of the assembly (its handle).` };
    const row = this.find(value);
    if (!row || !assembly.members.some((m) => m.object === row.id)) return { reason: `${field}: ${value} is not a part of ${assembly.name}.` };
    return row.id;
  };
  const asked = input.background === undefined ? undefined : readBackground(input.background);
  if (asked && "reason" in asked) return refuse("bad-argument", asked.reason);
  const filament = this.filament();
  const spec: MotionSpec = { densityGCm3: num(input.density) ?? filament.densityGCm3 };
  for (const key of ["seconds", "dt", "friction", "palletFriction", "restitution", "viscous", "push", "designPeriod", "drop"] as const) {
    const value = num(input[key]);
    if (value === undefined) continue;
    if (key === "designPeriod") spec.designPeriodS = value;
    else if (key === "drop") spec.dropMm = value;
    else spec[key] = value;
  }
  if (input.findStart === true) spec.findStart = true;
  if (num(input.pinRadius) !== undefined) spec.pinRadiusMm = num(input.pinRadius);
  if (num(input.clutch) !== undefined) spec.clutchNmm = num(input.clutch);
  if ((spec.seconds ?? DEFAULTS.seconds) > LIMITS.seconds) return refuse("out-of-range", `seconds is at most ${LIMITS.seconds}.`);
  if (input.drive !== undefined) {
    const d = input.drive as Input;
    const at = member(d.member, "drive.member");
    if (typeof at !== "string") return refuse("bad-argument", at.reason);
    spec.drive = { member: at, ...(num(d.torque) !== undefined ? { torqueNmm: num(d.torque)! } : {}), ...(num(d.weight) !== undefined ? { weightG: num(d.weight)! } : {}), ...(num(d.radius) !== undefined ? { radiusMm: num(d.radius)! } : {}), ...(d.dir === 1 || d.dir === -1 ? { dir: d.dir } : {}) };
  }
  if (input.escapement !== undefined) {
    const e = input.escapement as Input;
    const wheel = member(e.wheel, "escapement.wheel"), anchor = member(e.anchor, "escapement.anchor");
    if (typeof wheel !== "string") return refuse("bad-argument", wheel.reason);
    if (typeof anchor !== "string") return refuse("bad-argument", anchor.reason);
    spec.escapement = { wheel, anchor, teeth: num(e.teeth)!, tip: num(e.tip)!, root: num(e.root)!, lean: num(e.lean)!, span: num(e.span)! };
    for (const key of ["lock", "impulse", "drop", "supplementary", "armWidth", "hubRadius", "clearance", "rootShare"] as const) if (num(e[key]) !== undefined) spec.escapement[key] = num(e[key]);
  }
  if (input.pendulum !== undefined) {
    const at = member(input.pendulum, "pendulum");
    if (typeof at !== "string") return refuse("bad-argument", at.reason);
    spec.pendulum = at;
  }
  if (input.hand !== undefined) {
    const h = input.hand as Input;
    const at = member(h.member, "hand.member");
    if (typeof at !== "string") return refuse("bad-argument", at.reason);
    spec.hand = { member: at, turnsPerHour: num(h.turnsPerHour) ?? 1 };
  }
  if (input.sweep === false) spec.sweep = false;
  else if (Array.isArray(input.sweep)) spec.sweep = (input.sweep as unknown[]).filter((x): x is number => typeof x === "number");
  const out = input.out as { gif?: string; frames?: string } | undefined;
  const fps = num(input.fps) ?? (out || input.keys === true ? 10 : 0);
  if (fps) spec.fps = fps;
  // What a run of minutes would end on is checked before it starts: where the files go, and the view.
  if (out) {
    if (!out.gif && !out.frames) return refuse("missing-argument", "out needs gif or frames.");
    if (out.gif) resolveWrite(out.gif, ".gif");
    if (out.frames) resolveWrite(join(out.frames, "frame-001.png"), ".png");
    const view = readCamera(input.camera ?? "iso");
    if ("reason" in view) return refuse("bad-view", view.reason);
  }

  // Each member's triangles in its own frame and its pose, as model_mass weighs it and pose_animate draws it.
  const parts: DynPart[] = [];
  const drawn: AnimationPart[] = [];
  for (const row of assembly.members) {
    const part = this.find(row.object);
    if (!part) return refuse("bad-assembly", `Assembly member ${row.object} is missing.`);
    const solid = !!part.solid && part.solid.positions.length >= 9;
    parts.push(solid ? { object: part.id, name: shownName(part.name), positions: part.solid!.positions, pose: part.modelPose } : { object: part.id, name: shownName(part.name), positions: part.source, pose: thenPose(seatLift(part.seatMm), part.modelPose), frame: part.modelPose });
    drawn.push({ object: part.id, name: part.name, positions: solid ? part.solid!.positions : posedPositions(part.source, seatLift(part.seatMm)) });
  }
  const nameOf = (id: string) => shownName(this.find(id)?.name ?? id);
  const prepared = prepareMotion(assembly, parts, spec, nameOf);
  if ("reason" in prepared) return refuse("motion-refused", prepared.reason);
  const rig = animationRig(assembly, drawn);
  const rigName = (id: string) => rig.find((row) => row.object === id)?.name ?? id;
  // How out draws the frames, checked before a run of minutes: the parts partColours and fit name.
  const looks = readFrameLooks(drawn, rig, input, out !== undefined);
  if ("reason" in looks) return refuse("bad-view", looks.reason);

  // The runs, a slice at a time: the event loop answers slice_wait and hears slice_cancel between slices.
  const job = motionJob(prepared, rigName);
  let report: Awaited<ReturnType<typeof job.next>>["value"];
  let last = Date.now();
  for (;;) {
    const step = job.next();
    if (step.done) { report = step.value; break; }
    this.noteStage(step.value.stage, step.value.fraction * (out ? 0.7 : 1));
    if (Date.now() - last > 20) {
      await eventLoopTurn();
      last = Date.now();
      if (meta?.signal?.aborted) return refuse("cancelled", `The run was cancelled ${step.value.stage}; nothing changed.`);
    }
  }
  if ("reason" in report) return refuse("motion-refused", report.reason);
  const { animation, ...answer } = report;
  const reply: Record<string, unknown> = { ...answer, ...(input.keys === true && animation ? { animation } : {}) };
  if (!out) return reply;
  if (!animation) return refuse("motion-refused", "The run has no hinge to key, so it has no frames to draw.");
  if (!out.gif && !out.frames) return refuse("missing-argument", "out needs gif or frames.");
  // The keys sampled as any animation is (sampleAnimation), frame times as it gives them, then pose_animate's writer.
  const steps = sampleAnimationSteps(animation, assembly, (id) => this.find(id)?.modelPose, drawn, { interference: false });
  let sampled: AnimationResult | undefined;
  for (;;) {
    const step = steps.next();
    if (step.done) {
      if ("issues" in step.value) return refuse("animation-refused", `The run's frames could not be sampled: ${step.value.issues.map((row) => row.reason).join("; ")}`);
      sampled = step.value;
      break;
    }
    if (step.value.frame % 50 === 0) {
      this.noteStage(`Posing frame ${step.value.frame}/${step.value.count}`, 0.7 + 0.1 * (step.value.frame / Math.max(1, step.value.count)));
      await eventLoopTurn();
      if (meta?.signal?.aborted) return refuse("cancelled", "The run was cancelled while its frames were posed; no file was written.");
    }
  }
  const background = asked && "rgb" in asked ? asked.rgb : BACKGROUND;
  const written = await this.writeAnimationFrames(sampled, drawn, { out, camera: input.camera, longEdge: input.longEdge, background, ...looks }, meta);
  if ("ok" in written) return written;
  return { ...reply, frames: { count: sampled.frames.length, fps: sampled.fps, durationS: sampled.durationS, times: "from sampleAnimation, as pose_animate gives them" }, files: written.files };
}

export const motionMethods = { motionRun };
export const motionHandlers: Record<string, ToolHandler> = { motion_run: (session, input, meta) => session.motionRun(input, meta) };
