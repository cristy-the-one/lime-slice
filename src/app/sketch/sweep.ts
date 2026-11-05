/** Sweep from the open sketch. */
import { S } from "./state";
import { demoMade } from "./demo";
import { endExtrude } from "./extrude";
import { afterFeature, committed, featureEdit } from "./feature";
import { PIPE_DIAMETER_MM } from "./helpers";
import { endLoft, loftTouches, pinnedRegion, pinnedRegionAt, sameRegionIn, scaleOf } from "./loft";
import { endRevolve } from "./revolve";
import { featureBlocked } from "./starts";
import type { SweepGesture, SweepRound } from "./types";
import { drawingFrame, publish } from "./view";
import { GHOST_PROBE_WAIT_MS, loftGhost } from "../../interact/ghosts";
import { formatMm } from "../../model-plane";
import { inversePose, applyPose } from "../../model-space";
import { type ModelOp } from "../../model-tree";
import { type SketchData, type Vec3 } from "../../sketch/model";
import { rayOnPlane, frameFromWorkplane, toWorld } from "../../sketch/frame";
import { activeSketch, editActiveSketch } from "../../sketch/session";
import { featureTitle } from "../../sketch/hints";
import { sharpCorners, REASON } from "../../sketch/reasons";
import { withExprs } from "../../modeling/params.ts";
import { workplaneIn } from "../../workplane";
import { type ModeChoice, chooseRegions, regionCentroid, sampleLoop, resolveExtrudeMode, modeLabel } from "../../sketch/extrude";
import { toLoops, sketchRegions, regionAt } from "../../sketch/regions";
import { sectionOutline } from "../../sketch/loft";
import { oneSketchSweep, openChain, buildSketchSweep, standUpProfile, pipeProfile, SHARP_CORNER, EDGE_MEET, extendPath } from "../../sketch/sweep";
import { routeCornerLines, smallestRouteRadius, roundRouteCorners } from "../../sketch/round-route";

export function beginSweep() {
  if (S.host.sketchHolesArmed()) S.host.endSketchHoles();
  if (S.gesture) endExtrude();
  if (S.revolve) endRevolve();
  if (S.loft) endLoft();
  const sketch = activeSketch(S.editor);
  if (!sketch || S.editor.phase !== "editing") return;
  const choice: ModeChoice = featureEdit() === "root" ? "new" : "auto";
  const blank = { scale: 1, edges: [], choice, dragging: false, down: null, note: "" };
  // S1: a shape and a route in this one sketch stand the shape up at the route's start.
  const split = oneSketchSweep(sketch);
  if (split) {
    S.sweep = roundedSweep(madeSweep({ ...blank, profileSketch: null, profile: null, pathSketch: null, path: [], check: [], oneSketch: { split, stance: "up", drawnProfile: split.profile, sketch } }));
    publish("open");
    armSweepProbe();
    return;
  }
  const region = chooseRegions(sketch, S.editor.selection.entities, S.editor.cursor)[0] ?? null;
  const chain = openChain(sketch);
  // S2: a route with no shape anywhere is a pipe.
  if (!region && chain && !pinnedRegion()) {
    S.sweep = roundedSweep(madeSweep({ ...blank, profileSketch: null, profile: null, pathSketch: null, path: [], check: [], pipe: { route: sketch, chain, diameter: PIPE_DIAMETER_MM, wall: 0 } }));
    publish("open");
    armSweepProbe();
    return;
  }
  let profileSketch: SketchData | null = region ? sketch : null;
  let profile = region;
  let pathSketch: SketchData | null = chain ? sketch : null;
  let path = chain?.path ?? [];
  let check = chain?.check ?? [];
  if (region && chain) {
    pathSketch = sketch;
    path = chain.path;
    check = chain.check;
  } else if (region) {
    const found = pinnedChain();
    if (found) {
      pathSketch = found.sketch;
      path = found.chain.path;
      check = found.chain.check;
    }
  } else if (chain) {
    const found = pinnedRegion();
    if (found) {
      profileSketch = found.sketch;
      profile = found.region;
    }
  }
  S.sweep = {
    profileSketch,
    profile,
    pathSketch,
    path,
    check,
    scale: 1,
    edges: [],
    choice: featureEdit() === "root" ? "new" : "auto",
    dragging: false,
    down: null,
    note: "",
  };
  if (profile && profileSketch && path.length >= 2) {
    const built = buildSketchSweep({ profileSketch, profile, path, check, pathSketch, scale: 1, mode: featureEdit() === "root" ? "new" : "fuse" });
    if ("error" in built) S.sweep = { ...S.sweep, note: built.error };
  }
  S.sweep = roundedSweep(S.sweep);
  publish("open");
  armSweepProbe();
}

/**
 * S1 and S2: the profile, route and sketches a one-sketch sweep or a pipe stands for, worked out again from its
 * stance or sizes. The fields are the strict sweep's, so the builder, the ghost and Apply don't tell them apart.
 */
export function madeSweep(next: SweepGesture): SweepGesture {
  const mode = featureEdit() === "root" ? "new" : "fuse";
  let made: SweepGesture = next;
  if (next.oneSketch) {
    const { split, stance, drawnProfile, sketch } = next.oneSketch;
    const stood = stance === "up" ? standUpProfile(split) : null;
    made = stood
      ? { ...next, ...stood, note: "" }
      : { ...next, profileSketch: sketch, profile: drawnProfile, pathSketch: sketch, path: split.chain.path, check: split.chain.check, note: "" };
  } else if (next.pipe) {
    const pipe = pipeProfile(next.pipe.route, next.pipe.chain, next.pipe.diameter, next.pipe.wall);
    if ("error" in pipe) return { ...next, profileSketch: null, profile: null, pathSketch: next.pipe.route, path: next.pipe.chain.path, check: next.pipe.chain.check, note: pipe.error };
    made = { ...next, ...pipe, note: "" };
  } else return next;
  if (made.profile && made.profileSketch && made.path.length >= 2) {
    const built = buildSketchSweep({ profileSketch: made.profileSketch, profile: made.profile, path: made.path, check: made.check, pathSketch: made.pathSketch, scale: made.scale, mode });
    if ("error" in built) made = { ...made, note: built.error };
  }
  return made;
}

/**
 * S3: the sweep with the open sketch `from` swapped for `to`, the drawing as drawn or with its corners rounded. A
 * profile or route picked from another sketch stays. The note is the builder's, as madeSweep gives it.
 */
function sweepOnSketch(s: SweepGesture, from: SketchData, to: SketchData): SweepGesture {
  if (s.oneSketch) {
    const split = oneSketchSweep(to);
    return split ? madeSweep({ ...s, oneSketch: { ...s.oneSketch, split, drawnProfile: split.profile, sketch: to } }) : s;
  }
  if (s.pipe) {
    const chain = openChain(to);
    return chain ? madeSweep({ ...s, pipe: { ...s.pipe, route: to, chain } }) : s;
  }
  let next = s;
  if (s.pathSketch === from && s.edges.length === 0) {
    const chain = openChain(to);
    if (chain) next = { ...next, path: chain.path, check: chain.check, pathSketch: to };
  }
  if (s.profileSketch === from && s.profile) next = { ...next, profileSketch: to, profile: sameRegionIn(to, toLoops(s.profile)) ?? s.profile };
  if (!next.profile || !next.profileSketch || next.path.length < 2) return next;
  const built = buildSketchSweep({ profileSketch: next.profileSketch, profile: next.profile, path: next.path, check: next.check, pathSketch: next.pathSketch, scale: next.scale, mode: featureEdit() === "root" ? "new" : "fuse" });
  const note = "error" in built ? built.error : "";
  return { ...next, note };
}

/** S3: the sweep on the drawing as drawn, Round corners' setting kept for the next `roundedSweep`. */
function plainSweep(s: SweepGesture): SweepGesture {
  const round = s.round;
  if (!round?.rounded) return s;
  return { ...sweepOnSketch(s, round.rounded, round.base), round: { ...round, rounded: null } };
}

/** S3: the route is drawn in the open sketch, so Round corners can add its arcs there. */
function routeHere(s: SweepGesture, base: SketchData): boolean {
  if (s.oneSketch) return s.oneSketch.sketch === base;
  if (s.pipe) return s.pipe.route === base;
  return s.pathSketch === base && s.edges.length === 0;
}

/** How far the profile reaches from its centre: the radius of a circle, the half diagonal of a square. */
function profileReach(s: SweepGesture): number {
  if (!s.profile) return 0;
  const centre = regionCentroid(s.profile);
  const outer = toLoops(s.profile)[0];
  if (!outer) return 0;
  return Math.max(0, ...sampleLoop(outer).map((point) => Math.hypot(point[0] - centre[0], point[1] - centre[1])));
}

/**
 * --- S3. Round sharp corners for me. ---
 * When the route in the open sketch turns sharply where two lines meet, the card offers Round corners, on, with the
 * smallest radius the sweep builds with, from the profile's own radius up (a typed radius stays). The sweep's fields
 * then come from the drawing with those corners filleted, so the ghost and Apply use the rounded route.
 */
export function roundedSweep(s: SweepGesture): SweepGesture {
  const keep = s.round;
  const { round: _round, ...bare } = plainSweep(s);
  const base = keep?.base ?? activeSketch(S.editor);
  if (!base || !routeHere(bare, base) || !bare.profile || !bare.profileSketch || bare.path.length < 3) return bare;
  const ids = routeCornerLines(base, sharpCorners(bare.path, bare.check));
  if (!ids) return bare;
  let radius = keep?.typed ? keep.radius : null;
  if (radius == null) {
    const found = smallestRouteRadius(base, ids, profileReach(bare), (rounded) => {
      const tried = sweepOnSketch(bare, base, rounded);
      return tried.note === "" && !!tried.profile && tried.path.length >= 2;
    });
    if (!found) return bare;
    radius = found.radius;
  }
  const round: SweepRound = { radius, on: keep?.on ?? true, typed: keep?.typed ?? false, base, rounded: null, corners: ids.length };
  if (!round.on) return { ...bare, round, note: bare.note === SHARP_CORNER ? REASON.sharpRound : bare.note };
  const rounded = roundRouteCorners(base, ids, radius);
  if ("error" in rounded) return { ...bare, round, note: rounded.error };
  return { ...sweepOnSketch(bare, base, rounded.sketch), round: { ...round, rounded: rounded.sketch } };
}

export function endSweep() {
  if (!S.sweep) return;
  S.sweep = null;
  window.clearTimeout(S.probeTimer);
  S.host.view.setGhost(null);
  S.host.clearExtrudePreview();
  publish("open");
}

export function pinnedChain(): { sketch: SketchData; chain: { path: Vec3[]; check: boolean[] } } | null {
  for (const item of S.editor.pinned) {
    if (item.id === S.editor.active) continue;
    const chain = openChain(item.sketch);
    if (chain) return { sketch: item.sketch, chain };
  }
  return null;
}

export function takeSweepSketch(id: number) {
  if (!S.sweep) return;
  const item = S.editor.pinned.find((pinned) => pinned.id === id);
  if (!item) return;
  S.sweep = plainSweep(S.sweep);
  const region = chooseRegions(item.sketch, [], null)[0] ?? null;
  const chain = openChain(item.sketch);
  if (!region && !chain) {
    S.sweep = { ...S.sweep, note: sketchRegions(item.sketch).length > 1 ? REASON.manyRegionsSweep : REASON.nothingToSweep };
    publish("open");
    return;
  }
  let next = S.sweep;
  if (region) next = { ...next, profile: region, profileSketch: item.sketch, note: "", oneSketch: undefined, pipe: undefined };
  if (chain && (!region || next.path.length < 2)) next = { ...next, path: chain.path, check: chain.check, pathSketch: item.sketch, edges: [], note: "" };
  S.sweep = roundedSweep(next);
  publish("open");
  armSweepProbe();
}

export function resolvedSweepMode() {
  return resolveExtrudeMode({
    choice: S.sweep?.choice ?? "auto",
    hasSolid: S.host.solid() != null,
    touches: loftTouches(),
    distance: 1,
    lockNew: featureEdit() === "root",
    stepEdit: featureEdit() === "step",
  });
}

function currentSweepOp(): ModelOp | null {
  if (!S.sweep?.profile || !S.sweep.profileSketch || S.sweep.path.length < 2) return null;
  const built = buildSketchSweep({
    profileSketch: S.sweep.profileSketch,
    profile: S.sweep.profile,
    path: S.sweep.path,
    check: S.sweep.check,
    pathSketch: S.sweep.pathSketch,
    scale: S.sweep.scale,
    edges: S.sweep.edges,
    mode: resolvedSweepMode(),
  });
  return "op" in built ? built.op : null;
}

export async function commitSweep() {
  const why = featureBlocked();
  if (why) {
    S.host.readout(why);
    return;
  }
  if (!S.sweep || (S.applying || S.holding)) return;
  if (!S.sweep.profile || !S.sweep.profileSketch) {
    S.sweep = { ...S.sweep, note: S.sweep.note || REASON.sweepProfile };
    S.host.readout(S.sweep.note);
    return;
  }
  const profileSketch = S.sweep.profileSketch;
  const profile = sameRegionIn(profileSketch, toLoops(S.sweep.profile)) ?? S.sweep.profile;
  const built = buildSketchSweep({
    profileSketch,
    profile,
    path: S.sweep.path,
    check: S.sweep.check,
    pathSketch: S.sweep.pathSketch,
    scale: S.sweep.scale,
    edges: S.sweep.edges,
    mode: resolvedSweepMode(),
  });
  if ("error" in built) {
    S.sweep = { ...S.sweep, note: built.error };
    publish("skip");
    S.host.readout(built.error);
    return;
  }
  const op = withExprs(built.op, S.sweep.scaleText ? { scale: S.sweep.scaleText } : undefined);
  const mode = resolvedSweepMode();
  // S3: the rounded corners are the sketch's from this Apply on, as if Fillet corner had made them.
  const round = S.sweep.round?.on && S.sweep.round.rounded ? { base: S.sweep.round.base, rounded: S.sweep.round.rounded } : null;
  if (S.demo) {
    demoMade(op);
    return;
  }
  const error = await committed(S.host.commitExtrude(op, mode === "new" ? "new" : "on-solid"));
  if (error === undefined) return;
  if (error) {
    if (S.sweep) S.sweep = { ...S.sweep, note: error };
    S.host.readout(error);
    return;
  }
  if (round && activeSketch(S.editor) === round.base) S.editor = editActiveSketch(S.editor, round.rounded);
  afterFeature();
}

export function armSweepProbe() {
  window.clearTimeout(S.probeTimer);
  if (!S.sweep || S.sweep.dragging) return;
  if (resolvedSweepMode() === "new" || !S.host.solid() || !currentSweepOp()) {
    S.host.clearExtrudePreview();
    return;
  }
  S.probeTimer = window.setTimeout(() => {
    const op = currentSweepOp();
    if (op) S.host.probeExtrude(op);
  }, GHOST_PROBE_WAIT_MS);
}

export function sweepReadout(): string {
  if (!S.sweep) return "";
  if (S.sweep.note) return S.sweep.note;
  const mode = modeLabel(resolvedSweepMode());
  if (S.sweep.round?.on && S.sweep.round.rounded) return featureTitle("sweep", `R${formatMm(S.sweep.round.radius)} corners · ${mode}`);
  const profile = S.sweep.profile ? "profile" : "no profile";
  const path = S.sweep.path.length >= 2 ? "path" : "no path";
  return featureTitle("sweep", `${profile}, ${path} · ${mode}`);
}

export function sweepPointer(ev: { phase: "down" | "move" | "up"; x: number; y: number; shift: boolean; ctrl: boolean }, _frame: ReturnType<typeof drawingFrame>) {
  if (!S.sweep) return;
  if (ev.phase === "down") {
    S.sweep = { ...S.sweep, down: { x: ev.x, y: ev.y, scale: scaleOf(S.sweep.scale) }, dragging: false };
    return;
  }
  if (ev.phase === "move" && S.sweep.down) {
    const moved = Math.hypot(ev.x - S.sweep.down.x, ev.y - S.sweep.down.y);
    // A pipe's size is its diameter, typed in the box; a drag doesn't scale it.
    if ((moved < 4 && !S.sweep.dragging) || S.sweep.pipe) return;
    let scale = S.sweep.down.scale + (S.sweep.down.y - ev.y) / 100;
    if (ev.ctrl) scale = Math.round(scale * 10) / 10;
    else scale = Math.round(scale * 100) / 100;
    scale = Math.max(0.05, scale);
    S.sweep = { ...S.sweep, dragging: true, scale, note: "" };
    S.host.clearExtrudePreview();
    publish("values");
    return;
  }
  if (ev.phase === "up" && S.sweep.down) {
    const moved = Math.hypot(ev.x - S.sweep.down.x, ev.y - S.sweep.down.y);
    const shifted = ev.shift;
    S.sweep = { ...S.sweep, down: null, dragging: false };
    if (shifted) {
      addSweepEdge(ev.x, ev.y);
      return;
    }
    if (moved < 4) pickSweepAt(ev.x, ev.y);
    else {
      publish("open");
      armSweepProbe();
    }
  }
}

function addSweepEdge(x: number, y: number) {
  if (!S.sweep) return;
  S.sweep = plainSweep(S.sweep);
  const hit = nearestEdge(x, y);
  if (!hit) {
    S.sweep = { ...S.sweep, note: EDGE_MEET };
    S.host.readout(EDGE_MEET);
    return;
  }
  // The view's edges are where the solid stands. The path, like the profile's plane, is in the solid's own frame.
  const back = inversePose(S.host.pose());
  const extended = extendPath(S.sweep.path, S.sweep.check, hit.points.map((point) => applyPose(back, point)));
  if ("error" in extended) {
    S.sweep = { ...S.sweep, note: extended.error };
    S.host.readout(extended.error);
    return;
  }
  const edges = S.sweep.edges.includes(hit.id) ? S.sweep.edges : [...S.sweep.edges, hit.id];
  // A route that runs on along the part's edges is no longer only the open sketch's, so it is not rounded there.
  S.sweep = roundedSweep({ ...S.sweep, path: extended.path, check: extended.check, edges, note: "", round: undefined });
  publish("open");
  armSweepProbe();
}

function edgePoints(points: ArrayLike<number>): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i + 2 < points.length; i += 3) out.push([points[i]!, points[i + 1]!, points[i + 2]!]);
  return out;
}

function nearestEdge(x: number, y: number): { id: number; points: Vec3[] } | null {
  let best: { id: number; points: Vec3[]; distance: number } | null = null;
  S.host.edges().forEach((edge, index) => {
    const points = edgePoints(edge.points);
    if (points.length < 2) return;
    const mid = points[Math.floor(points.length / 2)]!;
    const screen = S.host.view.projectPoint(mid);
    if (!screen) return;
    const distance = Math.hypot(screen.x - x, screen.y - y);
    if (distance > 14) return;
    const id = edge.id ?? index;
    if (!best || distance < best.distance) best = { id, points, distance };
  });
  return best;
}

export function pickSweepAt(x: number, y: number) {
  if (!S.sweep) return;
  S.sweep = plainSweep(S.sweep);
  const frame = drawingFrame();
  const sketch = activeSketch(S.editor);
  if (!frame || !sketch) return;
  const ray = S.host.view.pointerRay(x, y);
  const plane = rayOnPlane(frame, ray.origin, ray.direction);
  // A click on a region, on this sketch or a pinned one, makes it the profile in place of the last one.
  const own = plane ? regionAt(sketchRegions(sketch), plane.uv) : null;
  const pinned = pinnedRegionAt(x, y);
  const hit = own && (!pinned || plane!.t <= pinned.t) ? { sketch, region: own } : pinned;
  const chain = openChain(sketch);
  // A click on the shape a one-sketch sweep already stands up keeps it; any other shape ends Pipe and the stand-up.
  if (hit && S.sweep.oneSketch && hit.sketch === sketch) {
    S.sweep = roundedSweep(S.sweep);
    publish("open");
    return;
  }
  if (hit) {
    S.sweep = { ...S.sweep, profile: hit.region, profileSketch: hit.sketch, note: "", oneSketch: undefined, pipe: undefined };
  } else if (chain && S.sweep.path.length < 2) {
    S.sweep = { ...S.sweep, path: chain.path, check: chain.check, pathSketch: sketch, edges: [], note: "" };
  }
  S.sweep = roundedSweep(S.sweep);
  publish("open");
  armSweepProbe();
}

export function paintSweep() {
  if (!S.sweep || S.editor.phase !== "editing") return;
  S.host.view.setHandles([]);
  const op = currentSweepOp();
  if (!op || op.kind !== "loft") {
    S.host.view.setGhost(null);
    return;
  }
  const rings = op.sections.map((section) => sectionOutline(section));
  const soup = loftGhost(rings);
  S.host.view.setGhost(soup.length > 0 ? { kind: "soup", positions: soup } : null);
}

export function pinnedStrokes(): { xyz: number[]; role: "hint" }[] {
  const strokes: { xyz: number[]; role: "hint" }[] = [];
  for (const item of S.editor.pinned) {
    if (item.id === S.editor.active) continue;
    const frame = frameFromWorkplane(workplaneIn({ source: "global", origin: item.sketch.plane.origin, turn: item.sketch.plane.turn }, S.host.pose()));
    // Every region of a pinned sketch is drawn, so each one can be clicked as a section or a profile.
    for (const region of sketchRegions(item.sketch)) {
      const xyz: number[] = [];
      for (const point of sampleLoop(region.outer)) {
        const at = toWorld(frame, point);
        xyz.push(at[0], at[1], at[2]);
      }
      if (xyz.length >= 6) strokes.push({ xyz, role: "hint" });
    }
  }
  if (S.sweep && S.sweep.path.length >= 2) {
    const xyz: number[] = [];
    // The path is in the solid's own frame, as the op is; the view draws it where the solid stands.
    for (const point of S.sweep.path) xyz.push(...applyPose(S.host.pose(), point));
    strokes.push({ xyz, role: "hint" });
  }
  return strokes;
}
