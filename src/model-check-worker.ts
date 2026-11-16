/**
 * model_check off the UI thread: printCheck plus thin walls, the same two passes MCP runs.
 * The caller copies the mesh before transferring it, so the solid on screen keeps its buffer.
 * --- A7 model check ---
 */
import { printCheck, type CheckBelt } from "./modeling/inspect.ts";
import { OVERHANG_DEG, assembleCheck, partBox, thinWarning, type ModelCheckReport, type Vec3 } from "./model-check.ts";
import { thinWalls } from "./modeling/thin.ts";

interface CheckJob {
  id: number;
  positions: Float32Array;
  minWallMm: number;
  nozzleMm: number;
  buildMm: Vec3;
  /** The plate's belt printer, or nothing for a bed: overhangs are read against the belt's build direction. */
  belt?: CheckBelt | null;
}

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<CheckJob>) => void) | null;
  postMessage(data: { id: number; report: ModelCheckReport }): void;
};

scope.onmessage = (ev: MessageEvent<CheckJob>) => {
  const { id, positions, minWallMm, nozzleMm, buildMm, belt } = ev.data;
  const part = partBox(positions);
  if (!part) {
    scope.postMessage({ id, report: { rows: [], warnings: [], note: "Open a solid to check it." } });
    return;
  }
  const checked = printCheck({ positions, overhangDeg: OVERHANG_DEG, buildMm, ...(belt ? { belt } : {}) });
  const thin = thinWalls(positions, minWallMm);
  const warning = thinWarning(minWallMm, thin, nozzleMm);
  scope.postMessage({ id, report: assembleCheck(checked, thin, part, warning ? [warning] : []) });
};
