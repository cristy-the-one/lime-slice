/**
 * Sampling an animation without holding the window (src/pose-anim.ts, `sampleAnimation`).
 *
 * The frames are made in a worker (src/pose-anim-worker.ts), so the view still orbits and the panel still scrolls
 * while a long animation of a large assembly is prepared. Where no worker can be made (a browser without one, a worker
 * that fails to load), the same steps run on the window's thread in slices that give the event loop back, so progress
 * still shows. Either way the answer is the one `sampleAnimation` gives: the worker's comes back by structured clone,
 * which keeps the Maps and the shared assemblies of the frames as they were made.
 */
import type { Assembly, PoseOf } from "./assembly.ts";
import type { Affine } from "./model-space.ts";
import { sampleAnimationSteps, type AnimationPart, type PoseAnimation, type SampleOutcome } from "./pose-anim.ts";

/** What the window sends: the poses as data, since a function cannot cross to a worker. */
export interface SampleJob { animation: PoseAnimation; assembly: Assembly; poses: Map<string, Affine | undefined>; parts: AnimationPart[]; interference?: boolean }
export type SampleReply =
  | { kind: "ready" }
  | { kind: "progress"; frame: number; count: number }
  | { kind: "done"; outcome: SampleOutcome; positions: (Float32Array | undefined)[] }
  | { kind: "error"; message: string; positions: (Float32Array | undefined)[] };

export interface SampleInBackground {
  interference?: boolean;
  /** Each frame as it is ready: `frame` of `count` (0 of `count` once the keys are read). */
  onProgress?: (frame: number, count: number) => void;
  /** Stops the work: the worker is ended, and the promise rejects with "The animation was cancelled.". */
  signal?: AbortSignal;
  /**
   * Lend the parts' position buffers to the worker instead of copying them; they are put back on the same part objects
   * when it answers. Only for parts the caller made for this sampling: after a cancel their positions are empty.
   */
  transfer?: boolean;
  /** False runs the sliced main-thread path only (a test, or a caller that knows there is no worker). */
  worker?: boolean;
}

export const CANCELLED = "The animation was cancelled.";
/** How long one slice of the main-thread path may hold the window before it yields. */
const SLICE_MS = 12;

const yieldToLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** `sampleAnimation` on the window's thread, a few frames at a time. */
export async function sampleAnimationSliced(animation: PoseAnimation, assembly: Assembly, poseOf: PoseOf, parts: readonly AnimationPart[], options: SampleInBackground = {}): Promise<SampleOutcome> {
  const steps = sampleAnimationSteps(animation, assembly, poseOf, parts, options.interference === false ? { interference: false } : {});
  let sliceStart = performance.now();
  for (;;) {
    if (options.signal?.aborted) throw new Error(CANCELLED);
    const step = steps.next();
    if (step.done) return step.value;
    options.onProgress?.(step.value.frame, step.value.count);
    if (performance.now() - sliceStart >= SLICE_MS) {
      await yieldToLoop();
      sliceStart = performance.now();
    }
  }
}

/** A worker for one sampling, or null once it has said it cannot load. */
function startWorker(): Promise<Worker | null> {
  let made: Worker;
  try {
    made = new Worker(new URL("./pose-anim-worker.ts", import.meta.url), { type: "module" });
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    made.onmessage = (ev: MessageEvent<SampleReply>) => { if (ev.data.kind === "ready") resolve(made); };
    made.onerror = (ev) => { ev.preventDefault?.(); made.terminate(); resolve(null); };
  });
}

/**
 * `sampleAnimation` without holding the window: in a worker when one can be made, else sliced on this thread. Resolves
 * to exactly what `sampleAnimation(animation, assembly, poseOf, parts, { interference })` returns.
 */
export async function sampleAnimationInBackground(animation: PoseAnimation, assembly: Assembly, poseOf: PoseOf, parts: readonly AnimationPart[], options: SampleInBackground = {}): Promise<SampleOutcome> {
  const { signal } = options;
  if (signal?.aborted) throw new Error(CANCELLED);
  const worker = options.worker === false || typeof Worker === "undefined" ? null : await startWorker();
  if (signal?.aborted) { worker?.terminate(); throw new Error(CANCELLED); }
  if (!worker) return sampleAnimationSliced(animation, assembly, poseOf, parts, options);
  const poses = new Map(assembly.members.map((member) => [member.object, poseOf(member.object)]));
  // A buffer can be transferred once, and only when the part's positions are the whole of it.
  const lent = new Set<ArrayBuffer>();
  if (options.transfer) for (const part of parts) {
    const buffer = part.positions?.buffer;
    if (buffer instanceof ArrayBuffer && part.positions!.byteOffset === 0 && part.positions!.byteLength === buffer.byteLength) lent.add(buffer);
  }
  const sent: AnimationPart[] = parts.map((part) => ({ ...part }));
  return new Promise<SampleOutcome>((resolve, reject) => {
    const end = () => { worker.terminate(); signal?.removeEventListener("abort", onAbort); };
    const onAbort = () => { end(); reject(new Error(CANCELLED)); };
    const putBack = (positions: (Float32Array | undefined)[]) => {
      if (!lent.size) return;
      parts.forEach((part, at) => { if (positions[at] && part.positions?.buffer.byteLength === 0) (part as AnimationPart).positions = positions[at]; });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (ev: MessageEvent<SampleReply>) => {
      const reply = ev.data;
      if (reply.kind === "progress") { options.onProgress?.(reply.frame, reply.count); return; }
      if (reply.kind === "done") { end(); putBack(reply.positions); resolve(reply.outcome); return; }
      if (reply.kind === "error") { end(); putBack(reply.positions); reject(new Error(reply.message)); }
    };
    worker.onerror = (ev) => { ev.preventDefault?.(); end(); reject(new Error(ev.message || "The animation's worker stopped.")); };
    worker.onmessageerror = () => { end(); reject(new Error("The animation's frames could not be read back.")); };
    worker.postMessage({ animation, assembly, poses, parts: sent, ...(options.interference === false ? { interference: false } : {}) } satisfies SampleJob, [...lent]);
  });
}
