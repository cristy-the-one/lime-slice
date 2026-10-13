/**
 * Which Model tools the current selection can run, and how a fillet or chamfer
 * dry-run reads. The kernel probe itself stays off this module.
 */
import { formatMm } from "./model-plane.ts";
import { lastEdge, type ModelPickRef } from "./model-select.ts";

/** Wait after a number changes before asking the kernel. Typing stays on the UI thread. */
export const PROBE_WAIT_MS = 300;

export type ProbeView =
  | null
  | { phase: "checking" }
  | { phase: "done"; ok: boolean; error?: string; maxMm?: number };

/** Fillet and chamfer need an edge. A split needs a solid thick enough to cut. */
export function toolAvailable(tool: string, picks: readonly ModelPickRef[], splitLegal: boolean): boolean {
  if (tool === "fillet" || tool === "chamfer") return lastEdge(picks) != null;
  if (tool === "split") return splitLegal;
  return true;
}

export function probeFromBody(body: { ok?: unknown; error?: unknown; maxMm?: unknown }): ProbeView {
  if (body.ok === true) return { phase: "done", ok: true };
  const error = typeof body.error === "string" && body.error.length > 0 ? body.error : "This does not fit.";
  const maxMm = typeof body.maxMm === "number" && Number.isFinite(body.maxMm) && body.maxMm > 0 ? body.maxMm : undefined;
  return { phase: "done", ok: false, error, maxMm };
}

export function blendNote(kind: "fillet" | "chamfer", probe: ProbeView): { text: string; bad: boolean } {
  if (probe?.phase === "checking") {
    return { text: kind === "fillet" ? "Checking this fillet…" : "Checking this chamfer…", bad: false };
  }
  if (probe?.phase === "done" && probe.ok) {
    return { text: kind === "fillet" ? "This fillet fits." : "This chamfer fits.", bad: false };
  }
  if (probe?.phase === "done" && !probe.ok) {
    const reason = probe.error ?? "This does not fit.";
    const sentence = reason.endsWith(".") ? reason : `${reason}.`;
    const max = probe.maxMm != null ? ` The largest that fits is ${formatMm(probe.maxMm)} mm.` : "";
    return { text: `${sentence}${max}`, bad: true };
  }
  return { text: "Pick an edge.", bad: false };
}

/** Apply stays off until a fillet or chamfer dry-run says the size fits. */
export function probeAllowsApply(tool: string, probe: ProbeView): boolean {
  if (tool !== "fillet" && tool !== "chamfer") return true;
  return probe?.phase === "done" && probe.ok;
}
