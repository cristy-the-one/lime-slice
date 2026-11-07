/**
 * The Pose stage (`docs/plan-pose.md`). M1 draws and selects: every object at its assembled pose, solid, with the
 * selected part and its jointed ancestors in the pose colours. It edits nothing, so it never touches the print layout or the slice.
 */
import { poseChain } from "../pose.ts";
import { createPoseView, type PoseCamera, type PoseView } from "../pose-view.ts";
import { assembledParts, assemblyClashes, liveAssemblies } from "./assemblies.ts";
import { fx } from "./fx.ts";
import { state } from "./state.ts";

let view: PoseView | null = null;

function mount(): PoseView | null {
  if (view) return view;
  const canvas = document.querySelector<HTMLCanvasElement>("#pose");
  if (!canvas) return null;
  view = createPoseView(canvas);
  view.onPick((id) => {
    if (id && id !== state.plate.selectedId) fx.selectPlateObject(id);
  });
  document.querySelector("#poseViewPresets")?.addEventListener("click", (ev) => {
    const preset = (ev.target as Element | null)?.closest<HTMLElement>("[data-pose-view]")?.dataset.poseView;
    if (preset === "top" || preset === "front" || preset === "iso") view?.setCamera(preset as PoseCamera);
  });
  fx.syncPose = syncPose;
  return view;
}

/** Shows the stage: mounts the view the first time, then draws what the plate holds now. */
export function showPose(): void {
  const poseView = mount();
  if (!poseView) return;
  poseView.resize();
  syncPose();
}

/** Redraws Pose from the plate and the assemblies. Cheap while the stage is hidden: it waits for the next visit. */
export function syncPose(): void {
  if (!view || state.stage !== "pose") return;
  const { bedX, bedY, bedZ } = state.profile;
  const { parts } = assembledParts(bedX, bedY);
  // The Assembly view's interference pass, inside each assembly only, cached per pose pair.
  const assemblies = liveAssemblies();
  const clashing = assemblies.length > 0 ? new Set(assemblyClashes().flatMap((row) => [row.a, row.b])) : new Set<string>();
  view.setBed(bedX, bedY, bedZ);
  view.setScene({ parts, selectedId: state.plate.selectedId, chain: poseChain(assemblies, state.plate.selectedId), clashing });
  const empty = document.querySelector<HTMLElement>("#poseEmpty");
  if (empty) empty.hidden = parts.length > 0;
}

/** The theme changed: the view repaints its materials and clear colour. */
export function setPoseTheme(): void {
  view?.setTheme();
}
