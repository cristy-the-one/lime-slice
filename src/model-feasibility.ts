/**
 * Which Model tools the current selection can run, and how a kernel dry-run reads.
 * The kernel probe itself stays off this module.
 */
import { plainModelError } from "./app/model-error.ts";
import { formatMm } from "./model-plane.ts";
import { primitiveBounds, turnCentre, type PrimitiveSpec } from "./model-primitive.ts";
import { eulerOrient } from "./mesh-place.ts";
import { lastEdge, type ModelPickRef } from "./model-select.ts";

/**
 * Wait after a typed or dragged number before asking the kernel, so typing "12.5" asks once.
 * Typists average 239 ms between keys, and the slowest tenth 481 ms (Dhakal et al., CHI 2018,
 * 168 000 typists), so a shorter wait asks once per key for most people. Opening a tool, picking,
 * the end of a drag, and every other one-off change ask at once.
 */
export const PROBE_WAIT_MS = 300;

/** Tools whose result only the kernel can judge. Split and scale are checked from numbers alone. */
export const PROBED_TOOLS = ["fillet", "chamfer", "hole", "boolean", "extrude", "revolve", "loft", "shell", "group"] as const;
export type ProbedTool = (typeof PROBED_TOOLS)[number];

/** What a probe that builds measured: the result, and `before`, the solid it was built on. */
export interface ProbeMeasure {
  volumeMm3: number;
  /** Separate bodies. */
  solids: number;
  /** Closed shells: a hollow body is one solid of two. */
  shells: number;
}

/** `applied`: these numbers were just applied to this solid, so applying them again would change nothing. */
export type ProbeView =
  | null
  | { phase: "checking" }
  | { phase: "applied" }
  | {
      phase: "done";
      ok: boolean;
      error?: string;
      maxMm?: number;
      /** Which step of a group failed, counting from 1. */
      failedStep?: number;
      /** Steps of a group whose tool missed the solid. */
      skipped?: number;
      measure?: ProbeMeasure & { before: ProbeMeasure };
    };

/** What a kernel answer depends on: the tree node it ran on, whose shape never changes, and the op's numbers. */
export function probeKey(node: string, op: object): string {
  return `${node}|${JSON.stringify(op)}`;
}

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
  return tool === "fillet" ? "Pick an edge to fillet. Switch to Edge, then click the edges." : "Pick an edge to chamfer. Switch to Edge, then click the edges.";
}

function readMeasure(value: unknown): ProbeMeasure | null {
  if (!value || typeof value !== "object") return null;
  const { volumeMm3, solids, shells } = value as Record<string, unknown>;
  if (typeof volumeMm3 !== "number" || !Number.isFinite(volumeMm3) || !Number.isInteger(solids) || !Number.isInteger(shells)) return null;
  return { volumeMm3, solids: solids as number, shells: shells as number };
}

export function probeFromBody(body: { ok?: unknown; error?: unknown; maxMm?: unknown; volumeMm3?: unknown; solids?: unknown; shells?: unknown; before?: unknown; failedStep?: unknown; skipped?: unknown }): ProbeView {
  const failedStep = Number.isInteger(body.failedStep) ? (body.failedStep as number) : undefined;
  const skipped = Number.isInteger(body.skipped) ? (body.skipped as number) : undefined;
  if (body.ok === true) {
    const after = readMeasure(body);
    const before = readMeasure(body.before);
    const extra = skipped != null ? { skipped } : {};
    return after && before ? { phase: "done", ok: true, measure: { ...after, before }, ...extra } : { phase: "done", ok: true, ...extra };
  }
  const error = typeof body.error === "string" && body.error.length > 0 ? body.error : "This does not fit.";
  const maxMm = typeof body.maxMm === "number" && Number.isFinite(body.maxMm) && body.maxMm > 0 ? body.maxMm : undefined;
  return { phase: "done", ok: false, error, maxMm, ...(failedStep != null ? { failedStep } : {}) };
}

const CHECKING: Record<ProbedTool, string> = {
  fillet: "Checking this fillet…",
  chamfer: "Checking this chamfer…",
  hole: "Checking this hole…",
  boolean: "Checking this boolean…",
  extrude: "Checking this extrude…",
  revolve: "Checking this revolve…",
  loft: "Checking this loft…",
  shell: "Checking this shell…",
  group: "Checking these steps…",
};

const FITS: Record<ProbedTool, string> = {
  fillet: "This fillet fits.",
  chamfer: "This chamfer fits.",
  hole: "This hole cuts the solid.",
  boolean: "This boolean changes the solid.",
  extrude: "This extrude changes the solid.",
  revolve: "This revolve changes the solid.",
  loft: "This loft changes the solid.",
  shell: "This shell fits.",
  group: "These steps change the solid.",
};

export function probeNote(tool: ProbedTool, probe: ProbeView): { text: string; bad: boolean } | null {
  if (probe?.phase === "checking") return { text: CHECKING[tool], bad: false };
  if (probe?.phase === "done" && probe.ok) return { text: FITS[tool], bad: false };
  if (probe?.phase === "done" && !probe.ok) {
    const reason = plainModelError(probe.error ?? "This does not fit.", tool);
    const sentence = reason.endsWith(".") ? reason : `${reason}.`;
    const max = probe.maxMm != null ? ` The largest that fits is ${formatMm(probe.maxMm)} mm.` : "";
    return { text: `${sentence}${max}`, bad: true };
  }
  return null;
}

export const DISJOINT_CUT = "The tool does not touch the part.";
export const DISJOINT_FUSE = "This would add a separate body; place it touching the part.";

type Box = { min: [number, number, number]; max: [number, number, number] };

function boxesTouch(part: Box, tool: Box): boolean {
  const eps = 0.05;
  for (let axis = 0; axis < 3; axis += 1) {
    if (part.max[axis] < tool.min[axis] - eps || tool.max[axis] < part.min[axis] - eps) return false;
  }
  return true;
}

/** The primitive's box after its turn, in the same frame as `part`. */
export function turnedPrimitiveBox(spec: PrimitiveSpec): Box {
  const local = primitiveBounds(spec);
  const centre = turnCentre(spec);
  const origin = spec.origin;
  const pivot: [number, number, number] = [origin[0] + centre[0], origin[1] + centre[1], origin[2] + centre[2]];
  const rot = eulerOrient(spec.turn[0], spec.turn[1], spec.turn[2]);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const x of [local.min[0], local.max[0]]) {
    for (const y of [local.min[1], local.max[1]]) {
      for (const z of [local.min[2], local.max[2]]) {
        const dx = x - pivot[0];
        const dy = y - pivot[1];
        const dz = z - pivot[2];
        const p: [number, number, number] = [
          pivot[0] + rot[0] * dx + rot[1] * dy + rot[2] * dz,
          pivot[1] + rot[3] * dx + rot[4] * dy + rot[5] * dz,
          pivot[2] + rot[6] * dx + rot[7] * dy + rot[8] * dz,
        ];
        for (let axis = 0; axis < 3; axis += 1) {
          if (p[axis] < min[axis]) min[axis] = p[axis];
          if (p[axis] > max[axis]) max[axis] = p[axis];
        }
      }
    }
  }
  return { min, max };
}

/**
 * A cut or common that misses the part does nothing. A fuse that misses it
 * adds a second body. Empty when the boxes touch, including along one face.
 */
export function disjointBoolean(part: Box, spec: PrimitiveSpec, op: "cut" | "fuse" | "common"): string | null {
  const tool = turnedPrimitiveBox(spec);
  if (boxesTouch(part, tool)) return null;
  return op === "fuse" ? DISJOINT_FUSE : DISJOINT_CUT;
}

/** How far apart two boxes are at their nearest, in millimetres: 0 when they touch or overlap. */
export function boxGap(a: Box, b: Box): number {
  const axis = (i: 0 | 1 | 2) => Math.max(0, a.min[i] - b.max[i], b.min[i] - a.max[i]);
  return Math.hypot(axis(0), axis(1), axis(2));
}

/** The tool's box, turned, as `disjointBoolean` tests it. */
export function primitiveBox(spec: PrimitiveSpec): Box {
  return turnedPrimitiveBox(spec);
}

/** Apply stays off until the dry-run says the edit works. */
export function probeAllowsApply(tool: string, probe: ProbeView): boolean {
  if (!isProbed(tool)) return true;
  return probe?.phase === "done" && probe.ok;
}
