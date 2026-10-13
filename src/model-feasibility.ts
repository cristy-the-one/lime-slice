/**
 * Which Model tools the current selection can run, and how a kernel dry-run reads.
 * The kernel probe itself stays off this module.
 */
import { formatMm } from "./model-plane.ts";
import { lastEdge, type ModelPickRef } from "./model-select.ts";

/** Wait after a number changes before asking the kernel. Typing stays on the UI thread. */
export const PROBE_WAIT_MS = 300;

/** Tools whose result only the kernel can judge. Split and scale are checked from numbers alone. */
export const PROBED_TOOLS = ["fillet", "chamfer", "hole", "boolean"] as const;
export type ProbedTool = (typeof PROBED_TOOLS)[number];

export type ProbeView =
  | null
  | { phase: "checking" }
  | { phase: "done"; ok: boolean; error?: string; maxMm?: number };

export function isProbed(tool: string | null | undefined): tool is ProbedTool {
  return !!tool && (PROBED_TOOLS as readonly string[]).includes(tool);
}

/** Fillet and chamfer need an edge. A split needs a solid thick enough to cut. */
export function toolAvailable(tool: string, picks: readonly ModelPickRef[], splitLegal: boolean): boolean {
  if (tool === "fillet" || tool === "chamfer") return lastEdge(picks) != null;
  if (tool === "split") return splitLegal;
  return true;
}

/** Why a toolbar button is off. Empty when it is on. */
export function toolBlockedTip(tool: string, picks: readonly ModelPickRef[], splitLegal: boolean): string {
  if (toolAvailable(tool, picks, splitLegal)) return "";
  if (tool === "split") return "This solid is too thin to split.";
  return tool === "fillet" ? "Pick an edge to fillet. Switch to Edge, then click one." : "Pick an edge to chamfer. Switch to Edge, then click one.";
}

export function probeFromBody(body: { ok?: unknown; error?: unknown; maxMm?: unknown }): ProbeView {
  if (body.ok === true) return { phase: "done", ok: true };
  const error = typeof body.error === "string" && body.error.length > 0 ? body.error : "This does not fit.";
  const maxMm = typeof body.maxMm === "number" && Number.isFinite(body.maxMm) && body.maxMm > 0 ? body.maxMm : undefined;
  return { phase: "done", ok: false, error, maxMm };
}

const CHECKING: Record<ProbedTool, string> = {
  fillet: "Checking this fillet…",
  chamfer: "Checking this chamfer…",
  hole: "Checking this hole…",
  boolean: "Checking this boolean…",
};

const FITS: Record<ProbedTool, string> = {
  fillet: "This fillet fits.",
  chamfer: "This chamfer fits.",
  hole: "This hole cuts the solid.",
  boolean: "This boolean changes the solid.",
};

export function probeNote(tool: ProbedTool, probe: ProbeView): { text: string; bad: boolean } | null {
  if (probe?.phase === "checking") return { text: CHECKING[tool], bad: false };
  if (probe?.phase === "done" && probe.ok) return { text: FITS[tool], bad: false };
  if (probe?.phase === "done" && !probe.ok) {
    const reason = probe.error ?? "This does not fit.";
    const sentence = reason.endsWith(".") ? reason : `${reason}.`;
    const max = probe.maxMm != null ? ` The largest that fits is ${formatMm(probe.maxMm)} mm.` : "";
    return { text: `${sentence}${max}`, bad: true };
  }
  return null;
}

/** Apply stays off until the dry-run says the edit works. */
export function probeAllowsApply(tool: string, probe: ProbeView): boolean {
  if (!isProbed(tool)) return true;
  return probe?.phase === "done" && probe.ok;
}
