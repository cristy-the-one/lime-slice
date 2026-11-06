/** The Model view's binders for this area: called once, in order, by bindModelView. */
import { faceCentre } from "../../model-plane";
import { faceLoopsRequest } from "../../model-request";
import { faceBoundarySegments } from "../../model-select";
import { readFaceLoops } from "../../sketch/loft";
import { sketchJson } from "../../sketch/model.ts";
import { closeModelTool, openModelTool, openSketchHolePanel, sketchHoleCount, sketchHolesArmed } from "../../ui/model-chrome";
import { fx } from "../fx";
import { mountSketch } from "../sketch";
import { treeOf } from "./edges";
import { cancelSketchFeature, clearExtrudePreview, commitSketchExtrude, probeExtrude } from "./edit";
import { treeCall } from "./engine";
import { flatFace } from "./geometry";
import { currentParams } from "./parameters";
import { about, readout } from "./pick";
import { pullLiveNow } from "./pull";
import { S } from "./shared";
import { syncUndo } from "./undo";
import { frameModel, openBox, openPose, posePoints, viewed } from "./view";
import { posedFace, workplaneOfOpen } from "./workplane";

export function bindSketch() {
  // --- S2 sketch ---
  const sketchCanvas = document.querySelector<HTMLCanvasElement>("#model");
  if (fx.model && sketchCanvas) {
    S.sketchUi = mountSketch({
      view: fx.model,
      canvas: sketchCanvas,
      readout,
      parameters: () => currentParams(),
      idleReadout() {
        const solid = viewed();
        return solid ? `${about(solid)} Pick a face or an edge.` : "";
      },
      closeTool() {
        if (openModelTool()) closeModelTool();
      },
      solid: viewed,
      pose: openPose,
      origin() {
        const t = openPose().t;
        return [t[0], t[1], t[2]];
      },
      focus() {
        const box = openBox();
        if (!box) return [openPose().t[0], openPose().t[1], openPose().t[2]];
        return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
      },
      extent() {
        const box = openBox();
        if (!box) return 80;
        return Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2], 20);
      },
      workplane: workplaneOfOpen,
      faceInfo(face) {
        const solid = viewed();
        if (!solid) return null;
        const own = flatFace(solid, face);
        const posed = posedFace(own);
        if (!own || !posed) return null;
        const mid = faceCentre(solid.positions, solid.triangles, face) ?? own.point;
        const info = solid.faces.find((item) => item.id === face);
        return { ref: { index: face, mid, areaMm2: info?.areaMm2 ?? 0 }, plane: posed };
      },
      edges() {
        const solid = viewed();
        if (!solid) return [];
        const pose = openPose();
        return solid.edges.map((edge) => ({ id: edge.id, points: posePoints(edge.points, pose) }));
      },
      outline(face) {
        const solid = viewed();
        if (!solid || face == null) return [];
        const raw = faceBoundarySegments(solid.positions, solid.triangles).get(face) ?? [];
        return posePoints(raw, openPose());
      },
      pullArmed: pullLiveNow,
      syncPull() {
        S.syncPullDrag?.();
      },
      syncEdge() {
        S.edgeDrag?.sync();
      },
      onHistory() {
        syncUndo();
      },
      // --- F1/E1. The sketch applies an extrude here. The context bar and the card call these. ---
      bounds: openBox,
      selectedFace() {
        return S.picks.find((pick) => pick.kind === "face")?.index ?? null;
      },
      featureEdit() {
        return S.sketchRootEdit ? "root" : S.editing?.sketch ? "step" : null;
      },
      commitExtrude(op, placement) {
        return commitSketchExtrude(op, placement);
      },
      probeExtrude(op) {
        void probeExtrude(op);
      },
      clearExtrudePreview() {
        clearExtrudePreview();
      },
      // --- F4. H in a face sketch opens the Hole panel on these points. ---
      beginSketchHoles(sketch, targets) {
        S.holdSketchHoles = true;
        S.sketchHoleDraft = {
          sketch: sketchJson(sketch),
          points: targets.map((point) => ({ id: point.id, at: [point.at[0], point.at[1]] })),
        };
        openSketchHolePanel(targets.length);
        S.holdSketchHoles = false;
        if (openModelTool() !== "hole") S.sketchHoleDraft = null;
      },
      endSketchHoles() {
        S.holdSketchHoles = false;
        if (sketchHolesArmed()) closeModelTool();
        else S.sketchHoleDraft = null;
      },
      sketchHolesArmed,
      sketchHoleCount,
      cancelFeatureEdit() {
        cancelSketchFeature();
      },
      frameSolid() {
        frameModel(false);
      },
      // --- F3. A flat face becomes loft loops. No solid, or a curved face, is a sentence. ---
      async faceLoops(face) {
        const at = S.open;
        const tree = treeOf(at);
        if (!at || !tree || !viewed()) return { error: "A face section needs a solid." };
        const body = await treeCall(at.key, tree.current, faceLoopsRequest(at.key, tree.current, face));
        return readFaceLoops(body);
      },
    });
  }
}
