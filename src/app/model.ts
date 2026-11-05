/** The Model view's entry: binds its buttons and cards. Its other parts live in ./model/. */
import { boundsOf } from "../mesh-place";
import {
  applyPose,
  boxUnder,
  inversePose,
  isIdentity,
  placeFields,
  thenPose,
  toSolidOp,
  turnDir,
} from "../model-space";
import { editRefusal, toolEditRefusal } from "../model-edit";
import { primitiveBounds } from "../model-primitive";
import { markProjectDirty } from "../project-dirty";
import { unionBox } from "../measure";
import type { ModelPick } from "../model-view";
import { lastFace, selectedEdges } from "../model-blend";
import { throughLength } from "../model-hole";
import { faceBoundarySegments } from "../model-select";
import { PROBE_WAIT_MS } from "../model-feasibility";
import { printFrame } from "../model-check.ts";
import { isFeatureTool } from "../model-features";
import { isRepeatTool, repeatSourceIds, setRepeatSources, toggleRepeatSource } from "../model-repeat";
import { faceCentre, planeFor } from "../model-plane";
import { ROOT } from "../model-tree";
import type { LetteringOp } from "../model-tree";
import { faceLoopsRequest } from "../model-request";
import { mountPull, pullFieldText } from "../push-pull-ui";
import { mountContextBar } from "../context-bar-ui";
import {
  closeModelTool,
  modelCardOpen,
  openSketchHolePanel,
  sketchHoleCount,
  sketchHolesArmed,
  mountModelChrome,
  openPlaceTool,
  openModelTool,
  followParameters,
  setAllowPullPreview,
  setPullLive,
  modelPreviewFresh,
  syncModelChrome,
  onModelSelection,
} from "../ui/model-chrome";
import { mountDockPanes } from "../ui/dock-panes";
import { mountModelHistory, paintRepeatSources } from "../ui/model-history";
import { recipesUnavailable } from "../recipe/runtime";
import { mountPluginAuthor, mountPluginsPanel, pluginAuthor } from "../ui/plugins-panel";
import { mountModelLook, onExplode } from "../ui/model-look";
import { readRow, rowKey, rowStep } from "../model-history";
import { meshToModel, meshTokenOf, withStudy } from "../plate";
import { livePlate, openMeshPicker, pickAddedMesh } from "./files";
import { flushEdit, noteEdit, redoUserEdit, undoUserEdit } from "./history";
import { fx } from "./fx";
import { mountEdgeDrag } from "./edge-drag";
import {
  closeSketchSession,
  mountSketch,
  openProfileSketch,
  sketchHistoryButtons,
  sketchRedo,
  sketchUndo,
} from "./sketch";
import { chainFromSketch } from "../modeling/sketch-profile.ts";
import { holeMarks, holeSizeRefusal, holesInModel } from "../sketch/holes.ts";
import { sketchJson } from "../sketch/model.ts";
import { readFaceLoops } from "../sketch/loft";
import { modelTrees } from "./model-trees";
import { plateObjectSizes, refreshObjectList } from "./settings";
import { mountModelInspect } from "../ui/model-inspect";
import { session, state } from "./state";
import { mountParameters } from "../ui/parameters.ts";
import { faceTriangles } from "../sim/bridge-body.ts";
import { paintCorners } from "../sim/paint-mesh.ts";
import {
  endStressPick,
  mountStress,
  stressOpen,
  stressUndoState,
  takeStressRedo,
  takeStressUndo,
} from "../ui/stress.ts";
import { stressSliceRequest } from "./stress-slice.ts";
import { beltLayerNormal, boxMap } from "../sim/study.ts";
import { beltStamp, cardsOf, saveMaterialCard, selection, setMeasuredFits } from "../ui/machine-library.ts";
import { mountSplitPrint, splitPrintHistory, splitPrintStep } from "../ui/split-print.ts";
import { mountTransitionCard, transitionPicked } from "../ui/transition-card.ts";
import { transitionFloorMm } from "../model-transition.ts";
import { cutTraces } from "../split-print.ts";
import { defaultsFor, enterMeasured, resetMeasured } from "../modeling/partition.ts";
import { loadMachineLibrary, storeMachineLibrary } from "./machine-library.ts";
import { printOrient } from "../workplane";
import { S } from "./model/shared";
import { applyPull, applyTool } from "./model/apply";
import { commitModel } from "./model/commit";
import { newSolidInView, plateBoxes } from "./model/create";
import { applyEdge, beginEdgeEdit, commitEdgeEdit, edgeArmed, matchedEdgeIds, probeEdge } from "./model/edge-tool";
import {
  blendTarget,
  edgeStepChoices,
  editUntouched,
  paintBlendHighlight,
  refreshStepEdges,
  takeEdgeStep,
  treeOf,
} from "./model/edges";
import {
  cancelEdit,
  cancelSketchFeature,
  clearExtrudePreview,
  commitSketchExtrude,
  probeExtrude,
  startEdit,
} from "./model/edit";
import { treeCall } from "./model/engine";
import { exportPieceFiles, exportsRow, runExport } from "./model/export";
import { curvedKind, featureNow, oneFeatureFace, paintTextAnchor } from "./model/features";
import { drillAxis, flatFace, kernelBox, modelExtent, num, shellSeat, splitLegal, splitState } from "./model/geometry";
import { dropBranch, jumpTo, ownStep, peekTool, renameStep, whyKeepBranch } from "./model/history";
import { sayJoin, solidObject } from "./model/join";
import { followSelection, forgetModelTrees } from "./model/lifecycle";
import { holeSizesNow } from "./model/ops";
import {
  affectedNodeIds,
  currentParams,
  noteParametersBuilt,
  rebuildFromParameters,
  usedByName,
} from "./model/parameters";
import {
  about,
  cancelPluginFacePick,
  onPick,
  paintContextBar,
  plateSketches,
  readout,
  startPluginFacePick,
} from "./model/pick";
import {
  alignOpenTo,
  endPlace,
  followAssemblyPoses,
  grabCancel,
  grabEnd,
  grabMove,
  grabReady,
  grabStart,
  placeFrame,
  placeMoved,
  placeStep,
  resetPose,
  setPlaceFrame,
  turnHint,
} from "./model/place";
import { clearPluginPreview, runPanelPlugin, savePluginRow, useLibraryVersion } from "./model/plugin-panel";
import { projectPluginFiles, rebuildPluginRow, syncPluginEnv } from "./model/plugins";
import { scheduleProbe, sendPending } from "./model/probe";
import { clearPullPreview, probePull, pullLiveNow, syncPullDiameter } from "./model/pull";
import { repeatNow } from "./model/repeat";
import { editJoinGhost, editPull } from "./model/run-edit";
import { releaseModelTrees, userFontIdsOfTrees } from "./model/save";
import { surfacesOnly } from "./model/shared";
import {
  checkSplitPrint,
  exportedPart,
  exportSplitNote,
  fitSplitPrint,
  labelSizes,
  partitionContext,
  printFitCoupon,
  profileRefs,
  splitPrinters,
  splitPrintFrame,
  splitStored,
} from "./model/split-print";
import {
  checkTransition,
  findTransitions,
  fixTransitions,
  keepStale,
  reaimStale,
  requestReaim,
  transitionPose,
  transitionStaleNote,
  transitionWedges,
} from "./model/transition";
import { setMode, step } from "./model/tree";
import { syncUndo } from "./model/undo";
import {
  boxOf,
  frameModel,
  ghostId,
  inView,
  objectPose,
  openBox,
  openPose,
  pivotOf,
  posePoints,
  present,
  refreshModelContext,
  stressMesh,
  viewed,
  viewFrame,
} from "./model/view";
import {
  endWorkplane,
  faceWorkplane,
  openObject,
  plateObjectOpen,
  posedFace,
  printWUp,
  sameMat,
  workplaneMoved,
  workplaneOfOpen,
  workplaneStep,
} from "./model/workplane";
export { commonVolume, exportAssemblyStep } from "./model/assembly";
export { captureOpenSolid, commitModel } from "./model/commit";
export { createFeatureSolid } from "./model/create";
export { warmHeldPieces } from "./model/engine";
export { followSelection, forgetModelTrees, leaveModel, showModel } from "./model/lifecycle";
export { noteParametersBuilt } from "./model/parameters";
export { adoptHeldPieces, adoptSavedTrees, historyToSave, releaseModelTrees } from "./model/save";
export type { HeldToSave } from "./model/save";
export { exportSplitNote, exportedPart } from "./model/split-print";
export { keepStale, requestReaim, transitionStaleNote } from "./model/transition";
export { frameInModel, frameModel, refreshModelContext, requestModelCheck } from "./model/view";

/** The readout says why the sketch holes' sizes cannot drill, so it is put back once they can. */
let holeRefused = false;

/** P1's face-drag sync, so a sketch can arm it again on the way out. */
let syncPullDrag: (() => void) | null = null;

export function bindModelView() {
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
      syncPullDrag?.();
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
  // --- Split to print: the Features menu's card.
  mountSplitPrint({
    undoChanged: () => syncUndo(),
    solidBox: () => (viewed()?.editable && !S.lens ? openBox() : null),
    frame: splitPrintFrame,
    plan(base, cut) {
      const at = viewed();
      if (!at) return null;
      const pose = openPose();
      return planeFor(base, cut.value, [cut.tiltA, cut.tiltB], (normal) => modelExtent(at, pose, normal), kernelBox(at, pose));
    },
    fit: fitSplitPrint,
    printers: splitPrinters,
    plate: () => selection(loadMachineLibrary())?.printer.id ?? null,
    numberSizes: labelSizes,
    exportPieces: () => void exportPieceFiles(),
    pickedFace() {
      const solid = viewed();
      const face = lastFace(S.picks);
      if (!solid || face == null) return null;
      return posedFace(flatFace(solid, face)) ?? "curved";
    },
    check: checkSplitPrint,
    connectors(typed) {
      const stored = splitStored(typed);
      return stored && !("reason" in stored) ? { notes: stored.notes, fits: stored.fits, marks: stored.marks, dropped: stored.dropped } : null;
    },
    refusal(typed) {
      const stored = splitStored(typed);
      return stored && "reason" in stored ? stored.reason : "";
    },
    shaped(typed) {
      const stored = splitStored(typed);
      return stored && !("reason" in stored) ? (stored.shaped ?? []) : [];
    },
    traces(typed) {
      const solid = viewed();
      return solid ? cutTraces(typed, partitionContext(solid), openPose(), solid.positions) : [];
    },
    profileSketch(plane, u, sketch, check, done) {
      openProfileSketch({
        sketch,
        refs: profileRefs(plane, u),
        check(drawn) {
          const chain = chainFromSketch(drawn);
          return ("reason" in chain ? chain.reason : check(chain)).replace(/^Cut \d+: /, "");
        },
        done,
      });
    },
    endProfileSketch: () => closeSketchSession(),
    defaults(target) {
      const solid = viewed();
      if (!solid) return null;
      const ctx = partitionContext(solid);
      return defaultsFor(target ?? ctx.plateTarget, ctx);
    },
    holeCompensation: () => state.xyHoleCompensationMm,
    printCoupon: printFitCoupon,
    material: () => selection(loadMachineLibrary())?.filament.material ?? "",
    fits: () => loadMachineLibrary().measuredFits,
    enterFits(key, results) {
      storeMachineLibrary(setMeasuredFits(loadMachineLibrary(), enterMeasured(loadMachineLibrary().measuredFits, key, results)));
    },
    resetFits(key) {
      storeMachineLibrary(setMeasuredFits(loadMachineLibrary(), resetMeasured(loadMachineLibrary().measuredFits, key)));
    },
    cancelled: cancelEdit,
    parameters: () => currentParams(),
    view: () => fx.model ?? null,
    readout,
  });
  // --- Print transitions: the Features menu's card.
  // --- Plugins (D13): the Features menu's card. app/model.ts runs the plugin; the card holds the form.
  mountPluginsPanel({
    project: () => projectPluginFiles(),
    partName: () => (S.open && viewed()?.editable && !S.lens ? openObject()?.name ?? S.open.objectId : null),
    runner: recipesUnavailable,
    run: (plugin, params, mode) => runPanelPlugin(plugin, params, mode),
    clearPreview: () => clearPluginPreview(),
    readout,
    libraryChanged: () => {
      S.pluginEnvFor = null;
      syncPluginEnv();
    },
    sketches: () => plateSketches(),
    pickFace: (done) => startPluginFacePick(done),
    cancelPick: () => cancelPluginFacePick(false),
  });
  mountPluginAuthor();
  mountTransitionCard({
    solidOpen: () => !!viewed()?.editable && !S.lens,
    pickedEdges: () => selectedEdges(S.picks),
    pose: () => transitionPose(openObject()),
    printerName: (id) => loadMachineLibrary().printers.find((row) => row.id === id)?.name ?? (id || "plate's printer"),
    supportAngle: () => state.supportAngle,
    shallowSkins: () => state.shallowSkins,
    floorMm: () => transitionFloorMm(state.profile.nozzleDiameter),
    check: checkTransition,
    wedges: transitionWedges,
    cancelled: cancelEdit,
    readout,
    find: (numbers) => void findTransitions(numbers),
    fix: (op, numbers) => void fixTransitions(op, numbers),
    flag: (edges, lit) => fx.model?.setFlaggedEdges(edges, lit),
    pick(edge) {
      if (!viewed()?.edges.some((row) => row.id === edge)) return;
      S.picks = [{ kind: "edge", index: edge }];
      fx.model?.highlight(S.picks);
      syncModelChrome(S.picks);
      transitionPicked();
    },
  });
  mountParameters({
    table: () => session.parameters,
    setTable(table) {
      const before = currentParams();
      session.parameters = table;
      followAssemblyPoses(before);
      markProjectDirty();
      // --- D17. An open tool's expression fields and its dry-run follow the table.
      followParameters();
    },
    usedBy: usedByName,
    affected: () => affectedNodeIds().length,
    rebuild() {
      void rebuildFromParameters();
    },
    projectId: () => session.projectTitle?.trim() || "",
  });
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
      syncPullDrag?.();
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
  noteParametersBuilt();
  // --- E3. Inspect, the right dock in Model. ---
  mountModelInspect({
    objects: () => plateObjectSizes(),
    openId: () => S.open?.objectId ?? state.plate.selectedId,
  });
  // --- P1: face push/pull. The default when no other model tool is open. ---
  if (fx.model) {
    const pull = mountPull(fx.model, {
      live: pullLiveNow,
      toolOpen: () => openModelTool() === "pushpull",
      solid: () => viewed(),
      pose: () => openPose(),
      selectedFaces: () => S.picks.filter((pick) => pick.kind === "face").map((pick) => pick.index),
      distance: () => num("#modelPull"),
      setField(distance) {
        const input = document.querySelector<HTMLInputElement>("#modelPull");
        if (!input || document.activeElement === input) return;
        input.value = pullFieldText(distance);
      },
      readout,
      parameters: () => currentParams(),
      hold(on) {
        S.pullProbe = on;
      },
      armPreview: setAllowPullPreview,
      previewFresh: modelPreviewFresh,
      probe(op) {
        probePull(op);
      },
      clearPreview: clearPullPreview,
      apply: applyPull,
      edit: editPull,
      busy: () => S.busy || S.jumping,
      current: () => treeOf(S.open)?.current ?? null,
    });
    syncPullDrag = () => {
      pull.sync();
      syncPullDiameter();
    };
    S.pullPanel = pull;
    // A typed diameter is the distance that reaches it: Distance follows, and the panel checks that as it would a typed distance.
    document.querySelector<HTMLInputElement>("#modelPullDiameter")?.addEventListener("input", (ev) => {
      // An emptied field is not a diameter of 0: Distance waits for a number.
      const text = (ev.currentTarget as HTMLInputElement).value.trim();
      const typed = Number(text);
      const distance = text !== "" && Number.isFinite(typed) && typed > 0 ? pull.pickedDistance(typed) : null;
      const field = document.querySelector<HTMLInputElement>("#modelPull");
      if (distance == null || !field) return;
      field.value = pullFieldText(distance);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    S.endPullDrag = () => pull.end();
    setPullLive(() => pull.sync());
  }
  // P2. Hover an edge and drag its knob: a fillet, or a chamfer while Alt is held. No toolbar tool.
  S.edgeDrag = mountEdgeDrag({
    stage: () => state.stage,
    armed: edgeArmed,
    solid: viewed,
    pose: openPose,
    center() {
      const solid = viewed();
      return solid ? pivotOf(solid) : [0, 0, 0];
    },
    selectedEdges: () => selectedEdges(S.picks),
    highlight(edges) {
      fx.model?.highlight(edges.map((index) => ({ kind: "edge" as const, index })));
    },
    restoreHighlight() {
      fx.model?.highlight(S.picks);
    },
    readout,
    about() {
      const solid = viewed();
      return solid ? about(solid) : "";
    },
    probe: probeEdge,
    apply: applyEdge,
    beginEdit: beginEdgeEdit,
    commitEdit: commitEdgeEdit,
    abortEdit() {
      if (S.editing?.edgeOp) cancelEdit();
    },
    editing: () => !!S.editing?.edgeOp,
    matchedEdges: matchedEdgeIds,
    nodeOp(node) {
      return treeOf(S.open)?.nodes.get(node)?.op ?? null;
    },
    view: () => fx.model ?? null,
    canvas: () => document.querySelector<HTMLCanvasElement>("#model"),
    setGhost(ghost) {
      fx.model?.setGhost(ghost);
    },
    setPreview(shape) {
      fx.model?.setPreview(shape);
    },
    ray(x, y) {
      return fx.model?.pointerRay(x, y) ?? { origin: [0, 0, 0], direction: [0, 0, -1] };
    },
    params: () => currentParams(),
    current: () => treeOf(S.open)?.current ?? null,
  });
  S.edgeDrag.sync();
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
        syncPullDrag?.();
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
  mountModelHistory({
    jump(row) {
      // --- A5. While Fillet or Chamfer takes a step's edges, a history row chooses that step. ---
      if (takeEdgeStep(row)) return;
      const step = ownStep(row);
      if (step != null) void jumpTo(step);
      else void peekTool(row);
    },
    rename: renameStep,
    dropRefusal: whyKeepBranch,
    drop: dropBranch,
    editRefusal(row) {
      const tree = treeOf(S.open);
      const step = tree ? rowStep(modelTrees, tree, row) : null;
      if (!step) return "This step is no longer in the history.";
      return step.joins.length === 0 ? editRefusal(step.tree, step.id) : toolEditRefusal(step.tree, step.joins, step.id);
    },
    edit(row) {
      // Shift+E away from History edits the step shown; while an edit is open that is its parent, so the key waits.
      const tree = treeOf(S.open);
      if (row != null) void startEdit(row);
      else if (tree && !S.editing) void startEdit(S.lens?.row ?? rowKey([], tree.current));
    },
    exportable: exportsRow,
    exportPieces: (row) => void exportPieceFiles(row),
    openPlace: openPlaceTool,
    resetPosition: resetPose,
    // --- A10. Hovering or focusing a row tints the faces that step made.
    highlight(id) {
      fx.model?.setStepHighlight(id);
    },
    // --- Print transitions (decision 5): the note's Re-aim and Keep.
    reaim: () => void reaimStale(),
    keepPose: () => keepStale(S.open?.objectId ?? null),
    // --- Plugin steps (milestone 6): a plugin step's values change in the card and rebuild here.
    pluginRunner: recipesUnavailable,
    async pluginRebuild(row, changes, edited) {
      const next = await rebuildPluginRow(row, changes, edited);
      return next ? { row: next } : { reason: S.readoutText || "The step was not rebuilt." };
    },
    pluginSketches: () => plateSketches(),
    pluginPickFace: (done) => startPluginFacePick(done),
    pluginCancelPick: () => cancelPluginFacePick(false),
    // --- Milestone 7: Use vN from the library, Save as plugin… for a draft, and the author the dialog starts with.
    async pluginUseVersion(row) {
      const next = await useLibraryVersion(row);
      return next ? { row: next } : { reason: S.readoutText || "The step was not rebuilt." };
    },
    pluginSave: (row, words) => savePluginRow(row, words),
    pluginAuthor,
    // --- A4. Ctrl-click adds or removes a step of this solid. A tool's step is not one of those. ---
    picking: () => isRepeatTool(openModelTool()) && !S.lens,
    pickSource(row) {
      if (!isRepeatTool(openModelTool())) return false;
      const parsed = readRow(row);
      if (!parsed || parsed.via.length !== 0) {
        readout("A pattern repeats a step of this solid.");
        return true;
      }
      toggleRepeatSource(parsed.id);
      paintRepeatSources(repeatSourceIds());
      syncModelChrome(S.picks);
      return true;
    },
  });
  // The tool, History, Parameters, and Stress share the dock's height; after History has its header.
  mountDockPanes();
  // --- A10. Section view and colour by step, from the View menu in the model foot.
  if (fx.model) {
    mountModelLook({
      setLook: (state) => fx.model?.setLook(state),
      onSectionDrag: (cb) => fx.model?.onSectionDrag(cb),
      posed(plane) {
        const at = posedFace({ point: plane.origin, normal: plane.normal })!;
        return { origin: at.point, normal: at.normal };
      },
    });
    onExplode(() => refreshModelContext());
  }
}

Object.assign(fx, { refreshModelContext, commitModel, exportedPart, exportSplitNote, transitionStaleNote, requestReaim, keepStale, forgetModelTrees, followSelection, releaseModelTrees });
