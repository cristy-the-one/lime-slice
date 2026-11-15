/**
 * Pose's Run (docs/plan-hinge-dynamics.md, section 6) off the UI thread: the shared job (src/motion.ts) on a copy of the
 * assembly and the members' meshes. A run of a clock is seconds to a minute of work, so the window never waits on it:
 * the worker posts its progress a few times a second and its report at the end, and Cancel ends the worker.
 */
import type { Assembly } from "./assembly.ts";
import type { DynPart } from "./dynamics.ts";
import { motionJob, prepareMotion, type MotionReport, type MotionSpec } from "./motion.ts";

export interface MotionJobMessage {
  id: number;
  assembly: Assembly;
  parts: DynPart[];
  spec: MotionSpec;
  /** Each member's name, and the name its animation keys use. */
  names: [string, string][];
  rig: [string, string][];
}
export type MotionJobReply = { id: number; progress: { fraction: number; stage: string } } | { id: number; done: MotionReport | { reason: string } };

/** The job a step at a time, on whatever thread runs it: progress, then the report. */
export function* motionJobSteps(job: MotionJobMessage, note?: (stage: string) => void): Generator<{ fraction: number; stage: string }, MotionReport | { reason: string }, void> {
  const names = new Map(job.names), rig = new Map(job.rig);
  const prepared = prepareMotion(job.assembly, job.parts, job.spec, (id) => names.get(id) ?? id, note);
  if ("reason" in prepared) return prepared;
  return yield* motionJob(prepared, (id) => rig.get(id) ?? id);
}

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<MotionJobMessage>) => void) | null;
  postMessage(data: MotionJobReply): void;
};

if (typeof window === "undefined") {
  scope.onmessage = (ev: MessageEvent<MotionJobMessage>) => {
    // The set-up's stages are said as they start: fitting an escapement reads every vertex of its parts.
    const steps = motionJobSteps(ev.data, (stage) => scope.postMessage({ id: ev.data.id, progress: { fraction: 0, stage } }));
    let last = 0;
    for (;;) {
      const step = steps.next();
      if (step.done) { scope.postMessage({ id: ev.data.id, done: step.value }); return; }
      const now = performance.now();
      if (now - last > 150) { last = now; scope.postMessage({ id: ev.data.id, progress: step.value }); }
    }
  };
}
