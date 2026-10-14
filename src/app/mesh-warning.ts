import type { MeshWarning, SliceResponse } from "./state";

export interface MeshRepair {
  repairedLayers: number;
  bridgedMm: number;
  droppedChains: number;
}

/** Counts for the results pill. A warning wins; an older reply falls back to the mesh counts. */
export function meshRepairOf(result: SliceResponse | null): MeshRepair | null {
  if (!result) return null;
  const warning = result.warnings?.find((row) => row.code === "mesh-repair");
  return repairFrom(warning, result.mesh.repairedLayers, result.mesh.droppedChains);
}

function repairFrom(warning: MeshWarning | undefined, meshRepaired: number | undefined, meshDropped: number | undefined): MeshRepair | null {
  const repaired = warning?.repairedLayers ?? meshRepaired;
  const dropped = warning?.droppedChains ?? meshDropped;
  const bridged = warning?.bridgedMm;
  if (typeof repaired !== "number" && typeof dropped !== "number" && !(typeof bridged === "number" && bridged > 0)) return null;
  const counts: MeshRepair = {
    repairedLayers: typeof repaired === "number" && repaired > 0 ? repaired : 0,
    bridgedMm: typeof bridged === "number" && bridged > 0 ? bridged : 0,
    droppedChains: typeof dropped === "number" && dropped > 0 ? dropped : 0,
  };
  if (counts.repairedLayers === 0 && counts.bridgedMm === 0 && counts.droppedChains === 0) return null;
  return counts;
}

/** Stable across a re-render. A later slice with different counts is a new key. */
export function meshWarningKey(counts: MeshRepair): string {
  return `${counts.repairedLayers}|${counts.bridgedMm}|${counts.droppedChains}`;
}

/** Plain sentences. A zero count is left out, and there is no repair command to point at. */
export function meshWarningText(counts: MeshRepair): string {
  const parts: string[] = [];
  if (counts.repairedLayers > 0) {
    const layers = counts.repairedLayers === 1 ? "1 layer" : `${counts.repairedLayers} layers`;
    parts.push(`The mesh has gaps on ${layers}.`);
  }
  if (counts.bridgedMm > 0) {
    parts.push(`The slicer closed ${counts.bridgedMm.toFixed(1)} mm of those gaps.`);
  }
  if (counts.droppedChains > 0) {
    parts.push(counts.droppedChains === 1
      ? "1 open contour segment was skipped, so that outline is missing."
      : `${counts.droppedChains} open contour segments were skipped, so that outline is missing.`);
  }
  return parts.join(" ");
}
