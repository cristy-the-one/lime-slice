/**
 * Reinforcement against the live session: brush strokes, box/cylinder volumes,
 * per-region density/depth/fillThrough, region selection/addition/deletion, clear,
 * and the drawn disks and translucent volumes.
 */
import { fx } from "./fx";
import { session, state } from "./state";
import { beginEdit, flushEdit, noteEdit } from "./history";
import { syncPlateFromState } from "./plate-sync";
import { touch } from "./settings";
import { boundsOf } from "../mesh-place";
import { selectedObject, sourceFrame } from "../plate";
import { markProjectDirty } from "../project-dirty";
import {
  addDiskToRegion,
  allReinforceDisks,
  defaultReinforceVolume,
  dropEmptyReinforce,
  emptyPaintRegion,
  MAX_PAINT_DISKS,
  MAX_REINFORCE_REGIONS,
  moveReinforceVolume,
  normalInfillDensity,
  REINFORCE_DEPTH_DEFAULT_MM,
  REINFORCE_DEPTH_MAX_MM,
  REINFORCE_DEPTH_MIN_MM,
  reinforceDiskFromHit,
  reinforceInMeshFrame,
  reinforceStrokeTakes,
  scaleReinforceVolume,
  volumeInMeshFrame,
  type ReinforceDisk,
} from "../reinforcement";
import type { ShownReinforceVolume } from "../reinforce-scene";
import type { BrushHooks } from "../prepare-view";
import { pushToast } from "../ui/toasts";

let activeRegionIndex = 0;
let volumeTool: "move" | "scale" = "move";

export function currentReinforceIndex(): number {
  const n = state.reinforcement.length;
  if (n === 0) {
    activeRegionIndex = 0;
    return 0;
  }
  if (activeRegionIndex < 0 || activeRegionIndex >= n) {
    activeRegionIndex = n - 1;
  }
  return activeRegionIndex;
}

export function currentReinforceTool(): "move" | "scale" {
  return volumeTool;
}

export function setReinforceVolumeTool(tool: "move" | "scale") {
  volumeTool = tool;
  drawReinforce();
}

export function selectReinforceRegion(index: number) {
  if (index >= 0 && index < state.reinforcement.length) {
    activeRegionIndex = index;
    drawReinforce();
  }
}

export function currentNormalDensity(): number {
  const obj = selectedObject(state.plate);
  return normalInfillDensity({
    blendKind: state.blendKind,
    strategy: state.strategy,
    toughness: state.toughness,
    objectInfill: obj?.settings.infill,
  });
}

/** Draw the selected object's reinforce paint disks and translucent volumes on the prepare mesh and repaint the bar. */
export function drawReinforce() {
  const source = state.sourcePos;
  const frame = source ? sourceFrame(source, state.partScale) : null;
  const disks = allReinforceDisks(state.reinforcement);
  fx.prepare?.setReinforcePaint(frame ? disks.map((d) => reinforceInMeshFrame(d, frame)) : []);

  const volumes: ShownReinforceVolume[] = [];
  if (frame) {
    state.reinforcement.forEach((reg, index) => {
      if (reg.kind === "box" || reg.kind === "cylinder") {
        volumes.push({ ...volumeInMeshFrame(reg, frame), index });
      }
    });
  }
  const active = currentReinforceIndex();
  const activeReg = state.reinforcement[active];
  const selectedVolIndex = activeReg && (activeReg.kind === "box" || activeReg.kind === "cylinder") ? active : null;
  fx.prepare?.setReinforceVolumes(volumes, selectedVolIndex, volumeTool);
  session.reinforceUi?.refresh();
}

function changed() {
  syncPlateFromState();
  markProjectDirty();
  drawReinforce();
  if (state.result) void fx.runSlice(false);
  else touch();
}

/** One drag of the reinforce brush: one undo step, then one slice. */
export function reinforceStroke(
  radius: number,
  defaults: { depthMm: number; fillThrough: boolean },
): BrushHooks {
  const before = state.reinforcement;
  const beforeIdx = activeRegionIndex;
  let last: ReinforceDisk | undefined;
  let warned = false;
  return {
    start: () => beginEdit(),
    hit(point, normal) {
      const placed = state.placed;
      if (!placed || !state.sourcePos) return;
      const disk = reinforceDiskFromHit(point, normal, radius, placed.pose, sourceFrame(state.sourcePos, state.partScale));
      if (!reinforceStrokeTakes(last, disk)) return;
      const idx = currentReinforceIndex();
      const added = addDiskToRegion(state.reinforcement, idx, disk, defaults);
      if (added.regions === state.reinforcement) {
        if (!warned) {
          const msg =
            state.reinforcement.length >= MAX_REINFORCE_REGIONS
              ? `One object holds at most ${MAX_REINFORCE_REGIONS} reinforcement regions.`
              : `One object holds at most ${MAX_PAINT_DISKS} reinforcement disks. Clear some to add more.`;
          pushToast(msg, "warn");
        }
        warned = true;
        return;
      }
      state.reinforcement = added.regions;
      activeRegionIndex = added.activeIndex;
      last = disk;
      drawReinforce();
    },
    end() {
      flushEdit();
      if (state.reinforcement !== before) changed();
    },
    cancel() {
      state.reinforcement = before;
      activeRegionIndex = beforeIdx;
      flushEdit();
      drawReinforce();
    },
  };
}

/** Start a new paint region at the defaults (`density: 1`, `depthMm: 5`, `fillThrough: false`) and select it. */
export function addNewPaintRegion() {
  if (state.reinforcement.length >= MAX_REINFORCE_REGIONS) {
    pushToast(`One object holds at most ${MAX_REINFORCE_REGIONS} reinforcement regions.`, "warn");
    return;
  }
  const region = emptyPaintRegion(1, REINFORCE_DEPTH_DEFAULT_MM, false);
  state.reinforcement = [...state.reinforcement, region];
  activeRegionIndex = state.reinforcement.length - 1;
  drawReinforce();
}

/** Add a box or cylinder reinforcement volume on the selected object and select it. */
export function addReinforceVolume(kind: "box" | "cylinder") {
  if (!state.sourcePos) return;
  if (state.reinforcement.length >= MAX_REINFORCE_REGIONS) {
    pushToast(`One object holds at most ${MAX_REINFORCE_REGIONS} reinforcement regions.`, "warn");
    return;
  }
  beginEdit();
  const bounds = boundsOf(state.sourcePos);
  const volume = defaultReinforceVolume(kind, bounds, 1);
  state.reinforcement = [...state.reinforcement, volume];
  activeRegionIndex = state.reinforcement.length - 1;
  flushEdit();
  changed();
}

export function beginReinforceVolumeEdit() {
  noteEdit();
}

export function nudgeReinforceVolume(
  index: number,
  kind: "move" | "scale",
  axis: "x" | "y" | "z",
  deltaMeshMm: number,
) {
  const region = state.reinforcement[index];
  if (!region || (region.kind !== "box" && region.kind !== "cylinder")) return;
  const scale = state.partScale || 1;
  const next =
    kind === "scale"
      ? scaleReinforceVolume(region, axis, deltaMeshMm, scale)
      : moveReinforceVolume(region, axis, deltaMeshMm, scale);
  const list = [...state.reinforcement];
  list[index] = next;
  state.reinforcement = list;
  activeRegionIndex = index;
  syncPlateFromState();
  markProjectDirty();
  drawReinforce();
}

export function endReinforceVolumeEdit() {
  flushEdit();
  changed();
}

/** Drop empty paint regions when leaving the reinforce tool (`Done`). */
export function dropEmptyReinforceOnDone() {
  const cleaned = dropEmptyReinforce(state.reinforcement);
  if (cleaned.length !== state.reinforcement.length) {
    state.reinforcement = cleaned;
    activeRegionIndex = Math.max(0, cleaned.length - 1);
    syncPlateFromState();
    drawReinforce();
  }
}

export function setReinforceDepth(depthMm: number, commit: boolean) {
  const idx = currentReinforceIndex();
  const region = state.reinforcement[idx];
  if (!region || region.kind !== "paint") return;
  const clamped = Math.min(REINFORCE_DEPTH_MAX_MM, Math.max(REINFORCE_DEPTH_MIN_MM, depthMm));
  if (Math.abs(region.depthMm - clamped) < 1e-6 && !commit) return;
  noteEdit();
  const next = [...state.reinforcement];
  next[idx] = { ...region, depthMm: clamped };
  state.reinforcement = next;
  if (commit) {
    flushEdit();
    if (region.disks.length > 0) changed();
    else session.reinforceUi?.refresh();
  } else {
    session.reinforceUi?.refresh();
  }
}

export function setReinforceFillThrough(fillThrough: boolean) {
  const idx = currentReinforceIndex();
  const region = state.reinforcement[idx];
  if (!region || region.kind !== "paint") return;
  if (Boolean(region.fillThrough) === fillThrough) return;
  beginEdit();
  const next = [...state.reinforcement];
  const updated = { ...region };
  if (fillThrough) updated.fillThrough = true;
  else delete updated.fillThrough;
  next[idx] = updated;
  state.reinforcement = next;
  flushEdit();
  if (region.disks.length > 0) changed();
  else session.reinforceUi?.refresh();
}

export function setReinforceDensity(index: number, density: number, commit: boolean) {
  const region = state.reinforcement[index];
  if (!region) return;
  const clamped = Math.min(1, Math.max(0, Math.round(density * 100) / 100));
  if (Math.abs(region.density - clamped) < 1e-6 && !commit) return;
  noteEdit();
  const next = [...state.reinforcement];
  next[index] = { ...region, density: clamped };
  state.reinforcement = next;
  if (commit) {
    flushEdit();
    if (region.kind !== "paint" || region.disks.length > 0) changed();
    else session.reinforceUi?.refresh();
  } else {
    session.reinforceUi?.refresh();
  }
}

export function removeReinforceRegion(index: number) {
  const region = state.reinforcement[index];
  if (!region) return;
  const hadEffect = region.kind !== "paint" || region.disks.length > 0;
  if (hadEffect) beginEdit();
  state.reinforcement = state.reinforcement.filter((_, i) => i !== index);
  if (activeRegionIndex >= state.reinforcement.length) {
    activeRegionIndex = Math.max(0, state.reinforcement.length - 1);
  }
  if (hadEffect) {
    flushEdit();
    changed();
  } else {
    drawReinforce();
  }
}

export function clearReinforce() {
  if (state.reinforcement.length === 0) return;
  const hadNonEmpty = dropEmptyReinforce(state.reinforcement).length > 0;
  if (hadNonEmpty) beginEdit();
  state.reinforcement = [];
  activeRegionIndex = 0;
  if (hadNonEmpty) {
    flushEdit();
    changed();
  } else {
    drawReinforce();
  }
}
