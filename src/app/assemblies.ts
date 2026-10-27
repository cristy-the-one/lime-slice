/**
 * Assemblies in the app (docs/plan-assemblies.md, M5): the session's assemblies against the plate, a hand move that
 * carries a root's members or re-seats a member, Attach and Ungroup from the object list, and the assembly view, which
 * draws every object at its pose in model space on Prepare's viewport.
 */
import { assemblyOf, attached, movedTo, readAssemblies, samePose, type Assembly } from "../assembly.ts";
import type { Bounds } from "../mesh-place.ts";
import type { ContextPart } from "../model-context.ts";
import { movedPose, posedBounds, thenPose, type Affine } from "../model-space.ts";
import { meshToModel, modelPoseOf, plateUnionBounds, withModelPose } from "../plate.ts";
import { markProjectDirty } from "../project-dirty.ts";
import { fx } from "./fx.ts";
import { refreshObjectList } from "./settings.ts";
import { session, state } from "./state.ts";

/**
 * The session's assemblies against the objects on the plate: a removed member is dropped, its children re-seated (D10).
 * Read, not stored: a project still loading its meshes, or an Undo of the removal, finds the assemblies whole.
 */
export function liveAssemblies(): Assembly[] {
  if (session.assemblies.length === 0) return session.assemblies;
  return readAssemblies(session.assemblies, state.plate.objects);
}

export function assemblyOfObject(id: string): Assembly | undefined {
  return assemblyOf(liveAssemblies(), id);
}

function poseOf(id: string): Affine | undefined {
  const obj = state.plate.objects.find((item) => item.id === id);
  return obj ? modelPoseOf(obj) : undefined;
}

/**
 * `id` was put at `pose` by hand. Its root carries the assembly (D9); a member's offset becomes the one that keeps it
 * there. Writes the other members' poses and says whether any moved.
 */
export function followAssemblyMove(id: string, pose: Affine): boolean {
  const live = liveAssemblies();
  const assembly = assemblyOf(live, id);
  if (!assembly) return false;
  const moved = movedTo(assembly, id, pose, poseOf);
  session.assemblies = live.map((row) => (row === assembly ? moved.assembly : row));
  let changed = false;
  for (const [object, next] of moved.poses) {
    const now = poseOf(object);
    if (object === id || !now || samePose(now, next)) continue;
    state.plate = withModelPose(state.plate, object, next);
    changed = true;
  }
  return changed;
}

/** Seat `child` on `parent` where it stands. Null when done, else the reason it was refused. */
export function attachTo(child: string, parent: string): string | null {
  const name = state.plate.objects.find((obj) => obj.id === parent)?.name ?? "Assembly";
  const next = attached(liveAssemblies(), child, parent, poseOf, name.replace(/\.[a-z0-9]+$/i, ""));
  if ("reason" in next) return next.reason;
  session.assemblies = next;
  return null;
}

/** The assembly is gone; its parts keep the poses they have. */
export function ungroup(id: string) {
  session.assemblies = liveAssemblies().filter((row) => row.id !== id);
}

/** View state: Prepare draws the assembled poses instead of the print layout. Not saved, not in the undo stack. */
export const assemblyView = { on: false };

/**
 * The Print layout / Assembly chip under Prepare's camera chip, shown while the plate has an assembly, and the viewport
 * drawn as it says. Leaving the last assembly returns to the print layout.
 */
export function syncAssemblyView() {
  const has = liveAssemblies().length > 0;
  if (!has) assemblyView.on = false;
  const host = document.querySelector("#prepareBody");
  let chip = document.querySelector<HTMLElement>("#assemblyViewChip");
  if (host && !chip) {
    chip = document.createElement("div");
    chip.id = "assemblyViewChip";
    chip.className = "modes stage-chip view-mode-chip";
    chip.setAttribute("role", "group");
    chip.setAttribute("aria-label", "View");
    for (const [mode, label, tip] of [["print", "Print layout", "Where each part prints on the bed"], ["assembly", "Assembly", "Every part where it sits in the assembly"]] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn";
      button.dataset.assemblyView = mode;
      button.dataset.tip = tip;
      button.textContent = label;
      button.addEventListener("click", () => setAssemblyView(mode === "assembly"));
      chip.append(button);
    }
    host.append(chip);
  }
  if (chip) {
    chip.hidden = !has;
    for (const button of chip.querySelectorAll<HTMLButtonElement>("[data-assembly-view]")) button.setAttribute("aria-pressed", String((button.dataset.assemblyView === "assembly") === assemblyView.on));
  }
  const { bedX, bedY } = state.profile;
  fx.prepare?.setAssembled?.(assemblyView.on ? assembledParts(bedX, bedY).parts : null, state.plate.selectedId);
}

export function setAssemblyView(on: boolean) {
  if (assemblyView.on === on) return;
  assemblyView.on = on;
  syncAssemblyView();
  const { bedX, bedY } = state.profile;
  const bounds = on ? assembledParts(bedX, bedY).bounds : state.placed ? plateUnionBounds(state.plate.objects, bedX, bedY) : null;
  if (bounds) fx.prepare?.frameBounds(bounds);
  refreshObjectList();
}

/** --- In the assembly view a move nudge moves the selected part in model space, carrying what sits on it. */
export function nudgeAssembled(axis: "x" | "y" | "z", mm: number): boolean {
  const obj = state.plate.objects.find((item) => item.id === state.plate.selectedId);
  if (!obj) return false;
  const delta: [number, number, number] = [axis === "x" ? mm : 0, axis === "y" ? mm : 0, axis === "z" ? mm : 0];
  const pose = movedPose(modelPoseOf(obj), delta);
  state.plate = withModelPose(state.plate, obj.id, pose);
  followAssemblyMove(obj.id, pose);
  markProjectDirty();
  syncAssemblyView();
  return true;
}

/**
 * Every plate object at its pose in model space, moved as one onto the bed: centred on it in X and Y, standing on it.
 * `bounds` is the whole set's box in that frame, for framing the camera.
 */
export function assembledParts(bedX: number, bedY: number): { parts: ContextPart[]; bounds: Bounds | null } {
  const placed = state.plate.objects.filter((obj) => obj.sourcePos.length >= 9).map((obj) => ({ obj, pose: meshToModel(obj) }));
  let box: Bounds | null = null;
  for (const { obj, pose } of placed) {
    const one = posedBounds(obj.sourcePos, pose);
    if (!one) continue;
    box = box
      ? { min: [Math.min(box.min[0], one.min[0]), Math.min(box.min[1], one.min[1]), Math.min(box.min[2], one.min[2])], max: [Math.max(box.max[0], one.max[0]), Math.max(box.max[1], one.max[1]), Math.max(box.max[2], one.max[2])] }
      : one;
  }
  if (!box) return { parts: [], bounds: null };
  const shift: Affine = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [bedX / 2 - (box.min[0] + box.max[0]) / 2, bedY / 2 - (box.min[1] + box.max[1]) / 2, -box.min[2]] };
  const parts = placed.map(({ obj, pose }) => ({ id: obj.id, name: obj.name, positions: obj.sourcePos, matrix: thenPose(pose, shift) }));
  const bounds: Bounds = { min: [box.min[0] + shift.t[0], box.min[1] + shift.t[1], 0], max: [box.max[0] + shift.t[0], box.max[1] + shift.t[1], box.max[2] - box.min[2]] };
  return { parts, bounds };
}
