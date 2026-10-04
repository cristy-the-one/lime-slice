/** Copy the selected object's pose to and from the live session. */
import type { Mat3 } from "../mesh-place.ts";
import { selectedObject, withSelectedPose, type PlateState } from "../plate.ts";
import { state } from "./state.ts";

export function syncPlateFromState() {
  if (!state.plate.selectedId || !state.sourcePos || !state.mesh) return;
  state.plate = withSelectedPose(state.plate, {
    orient: state.orient,
    partScale: state.partScale,
    centered: state.centered,
    offset: state.offset,
    stepTolerance: state.stepTolerance,
    supportEdits: state.supportEdits,
    supportPaint: state.supportPaint,
    fileName: state.mesh.name,
    bytes: state.mesh.bytes,
    sourcePos: state.sourcePos,
  });
}

export function applySelectedToState(plate: PlateState) {
  const obj = selectedObject(plate);
  if (!obj) return;
  state.mesh = { name: obj.fileName, bytes: obj.bytes };
  state.sourcePos = obj.sourcePos;
  state.orient = [...obj.orient] as Mat3;
  state.partScale = obj.partScale;
  state.centered = obj.centered;
  state.offset = { ...obj.offset };
  state.stepTolerance = obj.stepTolerance;
  state.supportEdits = obj.supportEdits.map((entry) => structuredClone(entry));
  state.supportPaint = obj.supportPaint;
}
