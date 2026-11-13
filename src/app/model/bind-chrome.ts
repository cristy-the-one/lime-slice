/** The Model view's binders for this area: called once, in order, by bindModelView. */
import { mountContextBar } from "../../context-bar-ui";
import { unionBox } from "../../measure";
import { printFrame } from "../../model-check.ts";
import { PROBE_WAIT_MS } from "../../model-feasibility";
import { isFeatureTool } from "../../model-features";
import { throughLength } from "../../model-hole";
import { primitiveBounds } from "../../model-primitive";
import { isRepeatTool, repeatSourceIds, setRepeatSources } from "../../model-repeat";
import { applyPose, boxUnder, inversePose, isIdentity, placeFields, thenPose, toSolidOp, turnDir } from "../../model-space";
import { LetteringOp, ROOT } from "../../model-tree";
import { ModelPick } from "../../model-view";
import { meshToModel, meshTokenOf, modelPoseOf } from "../../plate";
import { holeMarks, holeSizeRefusal, holesInModel } from "../../sketch/holes.ts";
import { mountModelChrome, onModelSelection, openModelTool, syncModelChrome } from "../../ui/model-chrome";
import { paintRepeatSources } from "../../ui/model-history";
import { splitPrintHistory, splitPrintStep } from "../../ui/split-print.ts";
import { endStressPick, stressOpen, stressUndoState, takeStressRedo, takeStressUndo } from "../../ui/stress.ts";
import { printOrient } from "../../workplane";
import { livePlate, openMeshPicker, pickAddedMesh } from "../files";
import { fx } from "../fx";
import { sketchHistoryButtons, sketchRedo, sketchUndo } from "../sketch";
import { state } from "../state";
import { applyTool } from "./apply";
import { gearsInTree, type WorldGear } from "../../gear-pair";
import { modelTrees } from "../model-trees";
import { newSolidInView, plateBoxes } from "./create";
import { blendTarget, edgeStepChoices, editUntouched, paintBlendHighlight, refreshStepEdges, treeOf } from "./edges";
import { cancelEdit } from "./edit";
import { runExport } from "./export";
import { curvedKind, featureNow, oneFeatureFace, paintTextAnchor } from "./features";
import { drillAxis, shellSeat, splitLegal, splitState } from "./geometry";
import { sayJoin, solidObject } from "./join";
import { holeSizesNow } from "./ops";
import { currentParams } from "./parameters";
import { about, onPick, paintContextBar, readout } from "./pick";
import { alignOpenTo, endPlace, grabCancel, grabEnd, grabMove, grabReady, grabStart, placeFrame, placeMoved, placeStep, setPlaceFrame, turnHint } from "./place";
import { scheduleProbe, sendPending } from "./probe";
import { repeatNow } from "./repeat";
import { editJoinGhost } from "./run-edit";
import { userFontIdsOfTrees } from "./save";
import { S, surfacesOnly } from "./shared";
import { setMode, step } from "./tree";
import { syncUndo } from "./undo";
import { boxOf, frameModel, ghostId, inView, objectPose, openBox, openPose, pivotOf, present, refreshModelContext, viewFrame, viewed } from "./view";
import { endWorkplane, faceWorkplane, plateObjectOpen, printWUp, sameMat, workplaneMoved, workplaneOfOpen, workplaneStep } from "./workplane";

/** The readout says why the sketch holes' sizes cannot drill, so it is put back once they can. */
let holeRefused = false;

export function bindToolbar() {
  // --- P3 context bar ---
  mountContextBar({ project: (at) => fx.model?.projectPoint(at) ?? null });
  onModelSelection(() => paintContextBar());
  fx.model?.onPick((pick: ModelPick | null, shift: boolean, at: { x: number; y: number }) => void onPick(pick, shift, at));
  document.querySelector("#modelPickFace")?.addEventListener("click", () => setMode("face"));
  document.querySelector("#modelPickEdge")?.addEventListener("click", () => setMode("edge"));
  document.querySelector("#modelApply")?.addEventListener("click", () => void applyTool());
  document.querySelector("#modelStep")?.addEventListener("click", () => void runExport());
  // While Place is open, Undo and Redo step its moves; the solid's history waits until it closes.
  document.querySelector("#modelUndo")?.addEventListener("click", () => {
    // --- S2: an open sketch has its own undo, separate from the solid. ---
    if (sketchHistoryButtons()) {
      sketchUndo();
      return;
    }
    if (stressOpen() && !openModelTool() && stressUndoState().undo) {
      takeStressUndo();
      return;
    }
    // --- Split to print: while the card is open, Undo steps its cuts, a drag at a time; the solid's history waits.
    if (splitPrintHistory()) {
      splitPrintStep("undo");
      return;
    }
    if (openModelTool() === "place") placeStep("undo");
    else if (openModelTool() === "workplane") workplaneStep("undo");
    else void step("undo");
  });
  document.querySelector("#modelRedo")?.addEventListener("click", () => {
    if (sketchHistoryButtons()) {
      sketchRedo();
      return;
    }
    if (stressOpen() && !openModelTool() && stressUndoState().redo) {
      takeStressRedo();
      return;
    }
    if (splitPrintHistory()) {
      splitPrintStep("redo");
      return;
    }
    if (openModelTool() === "place") placeStep("redo");
    else if (openModelTool() === "workplane") workplaneStep("redo");
    else void step("redo");
  });
  document.querySelector("#modelResetView")?.addEventListener("click", (ev) => frameModel((ev as MouseEvent).shiftKey));
  document.querySelector("#modelEmptyNew")?.addEventListener("click", () => {
    document.querySelector<HTMLButtonElement>("#modelToolNew")?.click();
    // The card hides with its button: focus goes on to the primitive picked.
    document.querySelector<HTMLButtonElement>('#modelPrim [aria-checked="true"]')?.focus();
  });
  document.querySelector("#modelEmptyOpen")?.addEventListener("click", () => (state.plate.objects.length > 0 ? pickAddedMesh() : openMeshPicker()));
}

export function bindChrome() {
  mountModelChrome({
    clearSelection() {
      if (S.lens && !S.editing && S.open) {
        present(S.open.solid, about(S.open.solid));
        return;
      }
      S.picks = [];
      paintBlendHighlight();
      syncModelChrome([]);
      const solid = viewed();
      if (solid) readout(`${about(solid)} Pick a face or an edge.`);
    },
    split() {
      return splitState();
    },
    splitLegal() {
      return splitLegal();
    },
    usedFontIds() {
      return userFontIdsOfTrees();
    },
    paramsChanged(typed) {
      if (openModelTool()) endStressPick();
      // --- F4. The draft lives only while the Hole panel is the points layout. ---
      if (S.sketchHoleDraft && openModelTool() !== "hole" && !S.holdSketchHoles) S.sketchHoleDraft = null;
      // A size that cannot drill is said here, and nothing is sent for the engine to refuse.
      const holeRefusal = S.sketchHoleDraft && openModelTool() === "hole" ? holeSizeRefusal(holeSizesNow()) : null;
      if (holeRefusal) {
        readout(holeRefusal);
        holeRefused = true;
      } else if (holeRefused) {
        holeRefused = false;
        const shown = viewed();
        if (shown) readout(about(shown));
      }
      // Place closed while a typed move was settling: that move is its step now, before Undo means the solid again.
      if (S.placeBefore && openModelTool() !== "place") endPlace();
      if (S.wpBefore && openModelTool() !== "workplane") endWorkplane();
      if (ghostId() !== S.ghosted) refreshModelContext();
      sayJoin();
      // --- A5. Outline the step's edges, and ask the engine when the step or the filter changed. ---
      void refreshStepEdges();
      scheduleProbe(typed ? PROBE_WAIT_MS : 0);
      syncUndo();
      // P1/P2. A tool opening or closing arms or disarms the face push and the idle edge knob: closed with Esc or
      // Cancel, nothing else would wake the push before the next click.
      S.syncPullDrag?.();
      S.edgeDrag?.sync();
      // --- S2 sketch ---
      S.sketchUi?.sync();
    },
    probeNow() {
      if (!S.pendingProbe) return;
      window.clearTimeout(S.probeTimer);
      sendPending();
    },
    solidBox() {
      return openBox();
    },
    // --- A7 model check ---
    // --- D13. The check reads the part as it prints: the plate's turn and scale, lowered to the bed.
    checkSource() {
      const solid = viewed();
      const shown = solid ? state.plate.objects.find((item) => item.id === S.open?.objectId) : undefined;
      if (solid && shown && solid.positions.length >= 9) {
        const printed = printFrame(solid.positions, shown.orient, shown.partScale);
        return { positions: printed.positions, toModel: thenPose(printed.toSource, openPose()) };
      }
      const obj = state.plate.objects.find((item) => item.id === state.plate.selectedId);
      if (obj && obj.sourcePos.length >= 9) {
        const printed = printFrame(obj.sourcePos, obj.orient, obj.partScale);
        return { positions: printed.positions, toModel: thenPose(printed.toSource, inView(meshToModel(obj))) };
      }
      return null;
    },
    edgePoints(edge) {
      const points = viewed()?.edges.find((item) => item.id === edge)?.points;
      const pose = openPose();
      if (!points || isIdentity(pose)) return points ?? null;
      const out = new Float32Array(points.length);
      for (let i = 0; i + 2 < points.length; i += 3) out.set(applyPose(pose, [points[i]!, points[i + 1]!, points[i + 2]!]), i);
      return out;
    },
    holeAxis() {
      return drillAxis();
    },
    throughLength(origin, dir) {
      const solid = viewed();
      if (!solid) return null;
      // In the solid's own frame, from its own box, read once per solid, as the kernel measures it.
      const back = inversePose(openPose());
      return throughLength(boxOf(solid.positions), applyPose(back, origin), turnDir(back, dir));
    },
    // --- F4. The cylinders for the points H snapped. ---
    sketchHoleView() {
      const draft = S.sketchHoleDraft;
      if (!draft) return null;
      const sizes = holeSizesNow();
      const pose = openPose();
      const built = holesInModel({ sketch: draft.sketch, points: draft.points, pose, sizes });
      if (!("op" in built)) return null;
      const solid = viewed();
      const marks = holeMarks(toSolidOp(built.op, pose), pose, (origin, axis) => {
        if (!solid) return sizes.depth;
        const back = inversePose(pose);
        return throughLength(boxOf(solid.positions), applyPose(back, origin), turnDir(back, axis)) ?? sizes.depth;
      });
      return { marks };
    },
    placeFields() {
      if (!S.open) return null;
      const fields = placeFields(objectPose(), pivotOf(S.open.solid), turnHint());
      S.shownTurn = { id: S.open.objectId, turn: { rx: fields.rx, ry: fields.ry, rz: fields.rz } };
      return fields;
    },
    placeMoved,
    placeFrame,
    setPlaceFrame,
    placeAxes() {
      const frame = viewFrame();
      return isIdentity(frame) ? null : frame;
    },
    grabReady,
    grabStart,
    grabMove,
    grabEnd,
    grabCancel,
    openObject: (id) => fx.selectPlateObject?.(id),
    alignChoices() {
      const at = S.open;
      return at ? livePlate().filter((obj) => obj.id !== at.objectId && obj.sourcePos.length >= 9).map((obj) => ({ id: obj.id, name: obj.name })) : [];
    },
    alignTo: alignOpenTo,
    objectName(id) {
      return livePlate().find((obj) => obj.id === (id ?? S.open?.objectId))?.name ?? "";
    },
    workplane: workplaneOfOpen,
    workplaneMoved,
    faceWorkplane,
    workplaneSet(plane) {
      endWorkplane();
      workplaneMoved(plane, "end");
    },
    editing: () => !!S.editing,
    printsWUp() {
      const obj = plateObjectOpen();
      return !obj || sameMat(state.orient, printOrient(obj.workplane));
    },
    printWUp,
    newSolidAt: (spec) => newSolidInView(spec),
    gearMates(): WorldGear[] {
      const editing = S.editing;
      const openId = S.open?.objectId ?? "";
      const editingGear = !!editing && openId && (editing.op.kind === "root" || (editing.op.kind === "boolean" && editing.op.primitive === "gear"));
      const except = editingGear && editing ? { objectId: openId, step: editing.op.kind === "root" ? null : editing.node } : null;
      const gears: WorldGear[] = [];
      for (const obj of livePlate()) {
        const tree = obj.modelTree ? modelTrees.get(obj.modelTree) : undefined;
        if (!tree) continue;
        for (const gear of gearsInTree(tree, inView(modelPoseOf(obj)), obj.id, obj.name)) {
          if (except && gear.objectId === except.objectId && gear.step === except.step) continue;
          gears.push(gear);
        }
      }
      return gears;
    },
    frameNewSolid(spec) {
      const others = plateBoxes();
      const frame = viewFrame();
      fx.model?.frame(unionBox([primitiveBounds(newSolidInView(spec, others)), ...others.map((box) => boxUnder(box, frame))])!);
    },
    joinChoices() {
      const at = S.open;
      return at ? livePlate().filter((obj) => obj.id !== at.objectId && solidObject(obj)).map((obj) => ({ id: obj.id, name: obj.name })) : [];
    },
    joinGhost(id) {
      const obj = livePlate().find((item) => item.id === id);
      return obj ? { id, positions: obj.sourcePos, matrix: inView(meshToModel(obj)) } : null;
    },
    notATool(id) {
      const obj = state.plate.objects.find((item) => item.id === id);
      if (!obj) return;
      readout(surfacesOnly.has(meshTokenOf(obj.bytes)) ? `${obj.name} has surfaces but no closed solid, so it cannot be a tool.` : `${obj.name} is a mesh, so it cannot be a tool.`);
      S.joinSaid = "";
    },
    editClosed: cancelEdit,
    editJoinGhost,
    editUnchanged: editUntouched,
    // --- A3 composite features ---
    pickedCurved: () => curvedKind(oneFeatureFace()),
    centreText() {
      S.textAnchor = null;
      S.featureMemo = null;
      paintTextAnchor();
    },
    featureView() {
      const current = openModelTool();
      if (!isFeatureTool(current)) return { note: null, pieces: null, frame: null, outward: null, letters: null, round: null };
      const expanded = featureNow(current);
      // --- Text with real fonts: the lettering step, in the solid's own frame, which the card draws as outlines.
      const letters = expanded.letters ? (toSolidOp(expanded.letters, openPose()) as LetteringOp) : null;
      // --- Text on a cylinder or a cone: the engine lays the letters out on the face under the anchor, on the solid on screen.
      const at = S.open;
      const tree = treeOf(at);
      const on = at && tree ? (S.lens ? { key: S.lens.key, node: S.lens.node } : { key: at.key, node: tree.current }) : null;
      const round = expanded.round && on ? { surface: expanded.round.surface, ...on } : null;
      return { note: expanded.note, pieces: expanded.pieces, frame: expanded.frame, outward: expanded.outward, letters, round };
    },
    // --- end A3 ---
    // --- A4 pattern and mirror ---
    repeatView() {
      const current = openModelTool();
      if (!isRepeatTool(current)) return { note: null, pieces: null, repeating: "" };
      const expanded = repeatNow(current);
      return { note: expanded.note, pieces: expanded.pieces, repeating: expanded.repeating };
    },
    seedRepeat() {
      const tree = treeOf(S.open);
      if (!tree || S.lens) setRepeatSources([]);
      else setRepeatSources(tree.current === ROOT ? [] : [tree.current]);
      paintRepeatSources(repeatSourceIds());
    },
    // --- end A4 ---
    // --- A5. The blend is built on the step on screen, and can take edges from it or a step above it. ---
    shownNode() {
      return blendTarget()?.node ?? null;
    },
    edgeSteps() {
      return edgeStepChoices();
    },
    // --- A2 shell ---
    shellSeat() {
      return shellSeat();
    },
    parameters: () => currentParams(),
  });
}
