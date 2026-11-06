/** The Model view's binders for this area: called once, in order, by bindModelView. */
import { boundsOf } from "../../mesh-place";
import { faceCentre } from "../../model-plane";
import { applyPose } from "../../model-space";
import { withStudy } from "../../plate";
import { markProjectDirty } from "../../project-dirty";
import { faceTriangles } from "../../sim/bridge-body.ts";
import { paintCorners } from "../../sim/paint-mesh.ts";
import { beltLayerNormal, boxMap } from "../../sim/study.ts";
import { beltStamp, cardsOf, saveMaterialCard } from "../../ui/machine-library.ts";
import { modelCardOpen, openModelTool } from "../../ui/model-chrome";
import { mountStress } from "../../ui/stress.ts";
import { fx } from "../fx";
import { flushEdit, noteEdit, redoUserEdit, undoUserEdit } from "../history";
import { loadMachineLibrary, storeMachineLibrary } from "../machine-library.ts";
import { refreshObjectList } from "../settings";
import { state } from "../state";
import { stressSliceRequest } from "../stress-slice.ts";
import { S } from "./shared";
import { setMode } from "./tree";
import { syncUndo } from "./undo";
import { openPose, stressMesh, viewed } from "./view";
import { openObject } from "./workplane";

export function bindStress() {
  mountStress({
    study: () => openObject()?.sim ?? null,
    objectId: () => S.open?.objectId ?? state.plate.selectedId,
    commit(study) {
      const id = S.open?.objectId ?? state.plate.selectedId;
      if (!id) return;
      noteEdit();
      state.plate = withStudy(state.plate, id, study);
      flushEdit();
      markProjectDirty();
      refreshObjectList();
    },
    facePoint(index) {
      const solid = viewed();
      return solid ? faceCentre(solid.positions, solid.triangles, index) : null;
    },
    bounds() {
      const mesh = stressMesh();
      if (!mesh || "reason" in mesh) return null;
      const box = boundsOf(mesh.positions);
      return { min: [box.min[0], box.min[1], box.min[2]], max: [box.max[0], box.max[1], box.max[2]] };
    },
    modelPoint: (at) => applyPose(openPose(), at),
    cards: () => cardsOf(loadMachineLibrary()),
    saveCard(card) {
      storeMachineLibrary(saveMaterialCard(loadMachineLibrary(), card));
    },
    view: () => fx.model ?? null,
    changed: () => syncUndo(),
    printerAxis() {
      const belt = beltStamp(loadMachineLibrary());
      return belt ? beltLayerNormal(belt.angleDeg) : [0, 0, 1];
    },
    toolOpen: () => openModelTool() != null || modelCardOpen() != null,
    picking(on) {
      if (on) setMode("face");
      S.syncPullDrag?.();
      S.edgeDrag?.sync();
    },
    undo: () => undoUserEdit(),
    redo: () => redoUserEdit(),
    sliceRequest(patch) {
      const mesh = stressMesh();
      if (mesh && "reason" in mesh) return { reason: mesh.reason };
      return stressSliceRequest(patch, mesh ?? undefined);
    },
    faceTriangles(faces) {
      const mesh = stressMesh();
      if (!mesh || "reason" in mesh || !mesh.triangles) return [];
      return faceTriangles(mesh.positions, mesh.triangles, faces);
    },
    paintSurface(edgeMm) {
      const mesh = stressMesh();
      const solid = viewed();
      if (!mesh || "reason" in mesh || !solid || solid.positions.length < 9) return null;
      return { corners: paintCorners(mesh.positions, edgeMm), toSolid: boxMap(boundsOf(mesh.positions), boundsOf(solid.positions)) };
    },
  });
}
