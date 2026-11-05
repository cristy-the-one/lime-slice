/** A4 pattern and mirror: the repeat panel's axes, planes, and expansion. */
import { applyPose, isIdentity, turnDir } from "../../model-space";
import type { ModelPick } from "../../model-view";
import { lastFace } from "../../model-blend";
import { lastEdge } from "../../model-select";
import {
  expandRepeat,
  isRepeatTool,
  lockMirrorFace,
  panelRepeatChoices,
  pushPathPoint,
  readRepeatSpec,
  repeatTargets,
  repeatingText,
  setHeldAxis,
  REPEAT_ONLY,
  REPEAT_PICK,
  type RepeatChoices,
  type RepeatTool,
} from "../../model-repeat";
import { type ModelOp } from "../../model-tree";
import { openModelTool, setMirrorOrigin, setPatternCentre, showPathPoint } from "../../ui/model-chrome";
import { stepLabel } from "../../model-history";
import { S } from "./shared";
import { treeOf } from "./edges";
import { flatFace, num } from "./geometry";
import { openPose, viewed } from "./view";

// --- A4 pattern and mirror ---
let repeatMemo: { key: string; value: ReturnType<typeof expandRepeat> & { repeating: string } } | null = null;

function unitDir(dir: readonly number[]): [number, number, number] | null {
  const length = Math.hypot(dir[0] ?? 0, dir[1] ?? 0, dir[2] ?? 0);
  if (!(length > 1e-9)) return null;
  return [(dir[0] ?? 0) / length, (dir[1] ?? 0) / length, (dir[2] ?? 0) / length];
}

/** An edge's direction in model space, from its first point to its last. */
function edgeDirection(edge: number): [number, number, number] | null {
  const points = viewed()?.edges.find((item) => item.id === edge)?.points;
  if (!points || points.length < 6) return null;
  const pose = openPose();
  const at = (index: number): [number, number, number] => {
    const point: [number, number, number] = [points[index]!, points[index + 1]!, points[index + 2]!];
    return isIdentity(pose) ? point : applyPose(pose, point);
  };
  const a = at(0);
  const b = at(points.length - 3);
  return unitDir([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
}

/** The middle of an edge's first and last points, in model space. */
function edgeMiddle(edge: number): [number, number, number] | null {
  const points = viewed()?.edges.find((item) => item.id === edge)?.points;
  if (!points || points.length < 6) return null;
  const last = points.length - 3;
  const mid: [number, number, number] = [(points[0]! + points[last]!) / 2, (points[1]! + points[last + 1]!) / 2, (points[2]! + points[last + 2]!) / 2];
  const pose = openPose();
  return isIdentity(pose) ? mid : applyPose(pose, mid);
}

/** A cylinder or cone face's axis in model space, and a point on it. */
function roundFaceAxis(face: number): { axis: [number, number, number]; at: [number, number, number] | null } | null {
  const row = viewed()?.faces.find((item) => item.id === face);
  if (!row?.axis || (row.surface !== "cylinder" && row.surface !== "cone")) return null;
  const pose = openPose();
  const axis = unitDir(isIdentity(pose) ? row.axis : turnDir(pose, row.axis));
  if (!axis) return null;
  const at = row.axisPoint ? (isIdentity(pose) ? row.axisPoint : applyPose(pose, row.axisPoint)) : null;
  return { axis, at };
}

/** The picked flat face's outward normal in model space. */
function mirrorNormalOf(face: number): [number, number, number] | null {
  const solid = viewed();
  if (!solid) return null;
  const plane = flatFace(solid, face);
  if (!plane) return null;
  const pose = openPose();
  return unitDir(isIdentity(pose) ? plane.normal : turnDir(pose, plane.normal));
}

function mirrorPointOf(face: number): [number, number, number] | null {
  const solid = viewed();
  if (!solid) return null;
  const plane = flatFace(solid, face);
  if (!plane) return null;
  const pose = openPose();
  return isIdentity(pose) ? plane.point : applyPose(pose, plane.point);
}

/** The axis a polar pattern turns about: the last edge, else a round face, else the one an edit saved. */
function livePatternAxis(choices: RepeatChoices): [number, number, number] | null {
  const edge = lastEdge(S.picks);
  if (edge != null) return edgeDirection(edge);
  const face = lastFace(S.picks);
  if (face != null) {
    const round = roundFaceAxis(face);
    if (round) return round.axis;
  }
  return choices.axisVec;
}

export function opForRepeat(tree: NonNullable<ReturnType<typeof treeOf>>, id: number): ModelOp | null {
  const node = tree.nodes.get(id);
  if (!node) return null;
  if (node.op) return node.op;
  if (node.parent === null && tree.root.kind === "primitive") return { kind: "root", ...tree.root.solid };
  if (node.parent === null && tree.root.kind === "feature") return tree.root.op;
  return null;
}

function repeatLabels(of: readonly number[]): string[] {
  const tree = treeOf(S.open);
  if (!tree) return [];
  return of.flatMap((id) => {
    const node = tree.nodes.get(id);
    return node ? [stepLabel(node)] : [];
  });
}

/** The open pattern or mirror, expanded on the steps it names. Memoized across the ghost, the note, and Apply. */
export function repeatNow(tool: RepeatTool) {
  const choices = panelRepeatChoices();
  const resolved: RepeatChoices = choices.mode === "polar" && choices.axis === "pick" ? { ...choices, axisVec: livePatternAxis(choices) } : choices;
  const repeating = repeatingText(repeatLabels(resolved.of));
  const tree = treeOf(S.open);
  const missing = repeatTargets(resolved.of, (id) => !!tree?.nodes.has(id));
  if (missing || !tree) {
    const note = missing ?? REPEAT_PICK;
    return { note, pieces: null, group: null, repeating: note === repeating ? "" : repeating };
  }
  const spec = readRepeatSpec(tool, (id) => num(`#${id}`), resolved);
  if ("reason" in spec && typeof spec.reason === "string") return { note: spec.reason, pieces: null, group: null, repeating: spec.reason === repeating ? "" : repeating };
  const steps: { id: number; op: ModelOp }[] = [];
  for (const id of resolved.of) {
    const op = opForRepeat(tree, id);
    if (!op) return { note: REPEAT_ONLY, pieces: null, group: null, repeating };
    steps.push({ id, op });
  }
  const pose = openPose();
  const key = JSON.stringify({ spec, pose, steps });
  if (repeatMemo?.key === key) return repeatMemo.value;
  const value = { ...expandRepeat(spec, steps, pose), repeating };
  repeatMemo = { key, value };
  return value;
}

/** A click while Pattern or Mirror is open: a path point, a polar axis, or a mirror face. */
export function noteRepeatPick(pick: ModelPick | null) {
  const tool = openModelTool();
  if (!pick || !isRepeatTool(tool)) return;
  const choices = panelRepeatChoices();
  if (tool === "pattern" && choices.mode === "path" && pick.kind === "face" && pick.at) {
    pushPathPoint(pick.at);
    showPathPoint(pick.at);
    return;
  }
  if (tool === "pattern" && choices.axis === "pick") {
    if (pick.kind === "edge") {
      const axis = edgeDirection(pick.index);
      if (axis) setHeldAxis(axis);
      // --- D15. The axis runs along the edge, so the centre is on it too: its middle.
      const at = edgeMiddle(pick.index);
      if (axis && at) setPatternCentre(at);
    } else {
      const round = roundFaceAxis(pick.index);
      if (round) {
        setHeldAxis(round.axis);
        if (round.at) setPatternCentre(round.at);
      }
    }
  }
  if (tool === "mirror" && choices.plane === "face" && pick.kind === "face") {
    const normal = mirrorNormalOf(pick.index);
    const point = mirrorPointOf(pick.index);
    if (normal) lockMirrorFace(normal);
    if (point) setMirrorOrigin(point);
  }
}

// --- end A4 ---
