/**
 * `sampleAnimation` off the window's thread (src/pose-anim-sample.ts): an animation's frames, each posed and checked
 * for parts that cross, while the view stays free to orbit and the Pose panel shows how far it has come.
 *
 * It says "ready" once loaded, so the window keeps its parts' buffers until a worker can take them. The parts'
 * positions come transferred and go back transferred with the answer, whatever the answer is.
 */
import { sampleAnimationSteps } from "./pose-anim.ts";
import type { SampleJob, SampleReply } from "./pose-anim-sample.ts";

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<SampleJob>) => void) | null;
  postMessage(data: SampleReply, transfer?: Transferable[]): void;
};

/** Progress at most this often: a message per frame of a long animation would only queue up behind the window. */
const PROGRESS_MS = 50;

scope.onmessage = (ev: MessageEvent<SampleJob>) => {
  const { animation, assembly, poses, parts, interference } = ev.data;
  const back = () => parts.flatMap((part) => (part.positions ? [part.positions] : []));
  const transfer = () => [...new Set(back().map((positions) => positions.buffer as ArrayBuffer))];
  try {
    const steps = sampleAnimationSteps(animation, assembly, (id) => poses.get(id), parts, interference === false ? { interference: false } : {});
    let said = 0;
    for (;;) {
      const step = steps.next();
      if (step.done) {
        scope.postMessage({ kind: "done", outcome: step.value, positions: parts.map((part) => part.positions) }, transfer());
        return;
      }
      const now = performance.now();
      if (step.value.frame === 0 || step.value.frame === step.value.count || now - said >= PROGRESS_MS) {
        said = now;
        scope.postMessage({ kind: "progress", frame: step.value.frame, count: step.value.count });
      }
    }
  } catch (error) {
    scope.postMessage({ kind: "error", message: error instanceof Error ? error.message : String(error), positions: parts.map((part) => part.positions) }, transfer());
  }
};

scope.postMessage({ kind: "ready" });
