/** Loft from the open sketch. */
import { S } from "./state";
import { demoMade } from "./demo";
import { endExtrude } from "./extrude";
import { afterFeature, committed, featureEdit, withSketchName } from "./feature";
import { endRevolve } from "./revolve";
import { featureBlocked } from "./starts";
import { endSweep } from "./sweep";
import type { LoftPick } from "./types";
import { drawingFrame, publish } from "./view";
import { GHOST_PROBE_WAIT_MS, loftGhost } from "../../interact/ghosts";
import { type ProfileLoop, type ModelOp, type LoftSection } from "../../model-tree";
import { sketchJson, type SketchData } from "../../sketch/model";
import { rayOnPlane, frameFromWorkplane } from "../../sketch/frame";
import { activeSketch } from "../../sketch/session";
import { featureTitle } from "../../sketch/hints";
import { REASON } from "../../sketch/reasons";
import { workplaneIn } from "../../workplane";
import { regionsCentroid, chooseRegions, resolveExtrudeMode, sketchTouchesSolid, modeLabel, regionsOfOutlines } from "../../sketch/extrude";
import { type Region, sketchRegions, regionAt } from "../../sketch/regions";
import { sectionFromRegion, buildSketchLoft, sectionOutline } from "../../sketch/loft";

// --- F3. Loft and sweep from the open sketch. ---
export function scaleOf(scale: number | number[]): number {
  return typeof scale === "number" ? scale : scale[0] ?? 1;
}

function regionKey(id: number, region: Region): string {
  const centre = regionsCentroid([region]);
  return `sketch:${id}:${centre[0].toFixed(3)},${centre[1].toFixed(3)}`;
}

export function beginLoft() {
  if (S.host.sketchHolesArmed()) S.host.endSketchHoles();
  if (S.gesture) endExtrude();
  if (S.revolve) endRevolve();
  if (S.sweep) endSweep();
  const sketch = activeSketch(S.editor);
  if (!sketch || S.editor.phase !== "editing" || S.editor.active == null) return;
  const chosen = chooseRegions(sketch, S.editor.selection.entities, S.editor.cursor);
  const picks = chosen.map((region) => ({
    key: regionKey(S.editor.active!, region),
    sketchId: S.editor.active,
    sketch: sketchJson(sketch),
    section: sectionFromRegion(sketch, region),
  }));
  S.loft = { picks, ruled: false, choice: featureEdit() === "root" ? "new" : "auto", note: "" };
  publish("open");
  armLoftProbe();
}

export function endLoft() {
  if (!S.loft) return;
  S.loft = null;
  window.clearTimeout(S.probeTimer);
  S.host.view.setGhost(null);
  S.host.clearExtrudePreview();
  publish("open");
}

export function pinnedRegion(): { sketch: SketchData; region: Region } | null {
  for (const item of S.editor.pinned) {
    if (item.id === S.editor.active) continue;
    const region = chooseRegions(item.sketch, [], null)[0];
    if (region) return { sketch: item.sketch, region };
  }
  return null;
}

export function takeLoftSketch(id: number) {
  if (!S.loft) return;
  const item = S.editor.pinned.find((pinned) => pinned.id === id);
  if (!item) return;
  const region = chooseRegions(item.sketch, [], null)[0];
  if (!region) {
    S.loft = { ...S.loft, note: sketchRegions(item.sketch).length > 1 ? REASON.manyRegionsLoft : REASON.noRegionLoft };
    publish("open");
    return;
  }
  const key = `sketch:${id}`;
  const pick: LoftPick = { key, sketchId: id, sketch: sketchJson(withSketchName(item.sketch, id)), section: sectionFromRegion(item.sketch, region) };
  const at = S.loft.picks.findIndex((itemPick) => itemPick.key === key);
  const picks = at >= 0 ? S.loft.picks.filter((_, index) => index !== at) : [...S.loft.picks, pick];
  S.loft = { ...S.loft, picks, note: "" };
  publish("open");
  armLoftProbe();
}

export function resolvedLoftMode() {
  const touches = loftTouches();
  return resolveExtrudeMode({
    choice: S.loft?.choice ?? "auto",
    hasSolid: S.host.solid() != null,
    touches,
    distance: 1,
    lockNew: featureEdit() === "root",
    stepEdit: featureEdit() === "step",
  });
}

export function loftTouches(): boolean {
  const sketch = activeSketch(S.editor);
  const frame = drawingFrame();
  const regions: Region[] = [];
  if (S.loft) {
    for (const pick of S.loft.picks) {
      const region = pick.sketchId === S.editor.active && pick.sketch ? sameRegionIn(pick.sketch, pick.section.loops as ProfileLoop[] | undefined) : null;
      if (region) regions.push(region);
    }
  } else if (S.sweep?.profile) regions.push(S.sweep.profile);
  return !!sketch && !!frame && regions.length > 0 && sketchTouchesSolid(frame, regions, S.host.bounds(), sketch.on?.kind === "face");
}

function freshLoftPicks(): LoftPick[] {
  if (!S.loft) return [];
  return S.loft.picks.map((pick) => {
    if (pick.sketchId == null) return pick;
    const live = pick.sketchId === S.editor.active ? activeSketch(S.editor) : S.editor.pinned.find((item) => item.id === pick.sketchId)?.sketch;
    if (!live) return pick;
    if (pick.sketch && JSON.stringify(sketchJson(live)) === JSON.stringify(sketchJson(pick.sketch))) return { ...pick, sketch: sketchJson(live) };
    const region = sameRegionIn(live, pick.section.loops as ProfileLoop[] | undefined);
    if (!region) return { ...pick, sketch: sketchJson(live) };
    return { ...pick, sketch: sketchJson(live), section: sectionFromRegion(live, region) };
  });
}

function currentLoftOp(): ModelOp | null {
  if (!S.loft || S.loft.picks.length < 2) return null;
  const built = buildSketchLoft({ picks: freshLoftPicks(), ruled: S.loft.ruled, mode: resolvedLoftMode() });
  return "op" in built ? built.op : null;
}

export async function commitLoft() {
  const why = featureBlocked();
  if (why) {
    S.host.readout(why);
    return;
  }
  if (!S.loft || (S.applying || S.holding)) return;
  const built = buildSketchLoft({ picks: freshLoftPicks(), ruled: S.loft.ruled, mode: resolvedLoftMode() });
  if ("error" in built) {
    S.loft = { ...S.loft, note: built.error };
    publish("skip");
    S.host.readout(built.error);
    return;
  }
  const mode = resolvedLoftMode();
  if (S.demo) {
    demoMade(built.op);
    return;
  }
  const error = await committed(S.host.commitExtrude(built.op, mode === "new" ? "new" : "on-solid"));
  if (error === undefined) return;
  if (error) {
    if (S.loft) S.loft = { ...S.loft, note: error };
    S.host.readout(error);
    return;
  }
  afterFeature();
}

export function armLoftProbe() {
  window.clearTimeout(S.probeTimer);
  if (!S.loft) return;
  if (resolvedLoftMode() === "new" || !S.host.solid() || S.loft.picks.length < 2) {
    S.host.clearExtrudePreview();
    return;
  }
  S.probeTimer = window.setTimeout(() => {
    const op = currentLoftOp();
    if (op) S.host.probeExtrude(op);
  }, GHOST_PROBE_WAIT_MS);
}

export function loftReadout(): string {
  if (!S.loft) return "";
  if (S.loft.note) return S.loft.note;
  const mode = modeLabel(resolvedLoftMode());
  const count = S.loft.picks.length;
  return featureTitle("loft", `${count} ${count === 1 ? "section" : "sections"} · ${mode}`);
}

export function loftPointer(ev: { phase: "down" | "move" | "up"; x: number; y: number }) {
  if (!S.loft || ev.phase !== "up") return;
  const frame = drawingFrame();
  const ray = S.host.view.pointerRay(ev.x, ev.y);
  const plane = frame ? rayOnPlane(frame, ray.origin, ray.direction) : null;
  const face = S.host.view.pickSolid(ev.x, ev.y);
  const sketch = activeSketch(S.editor);
  if (!sketch || S.editor.active == null) return;
  // The region under the click: on the sketch being drawn, or on a pinned one, the nearest first.
  const own = plane ? regionAt(sketchRegions(sketch), plane.uv) : null;
  const pinned = pinnedRegionAt(ev.x, ev.y);
  const hit = own && (!pinned || plane!.t <= pinned.t) ? { id: S.editor.active, sketch, region: own, t: plane!.t } : pinned;
  // A face in front of the region wins. A face behind the sketch plane is picked when the click is on no region.
  if (face && (!hit || face.t + 0.05 < hit.t)) {
    void addFaceSection(face.face);
    return;
  }
  if (!hit) return;
  const { id, region } = hit;
  const key = regionKey(id, region);
  const pick: LoftPick = { key, sketchId: id, sketch: sketchJson(withSketchName(hit.sketch, id)), section: sectionFromRegion(hit.sketch, region) };
  const at = S.loft.picks.findIndex((item) => item.key === key || item.key === `sketch:${id}`);
  const picks = at >= 0 ? S.loft.picks.filter((_, index) => index !== at) : [...S.loft.picks, pick];
  S.loft = { ...S.loft, picks, note: "" };
  publish("open");
  armLoftProbe();
}

async function addFaceSection(face: number) {
  const read = await S.host.faceLoops(face);
  if (!S.loft) return;
  if ("error" in read) {
    S.loft = { ...S.loft, note: read.error };
    S.host.readout(read.error);
    return;
  }
  const key = `face:${face}`;
  const section: LoftSection = { origin: read.origin, turn: read.turn, loops: read.loops };
  const pick: LoftPick = { key, sketchId: null, sketch: null, section };
  const at = S.loft.picks.findIndex((item) => item.key === key);
  const picks = at >= 0 ? S.loft.picks.filter((_, index) => index !== at) : [...S.loft.picks, pick];
  S.loft = { ...S.loft, picks, note: "" };
  publish("open");
  armLoftProbe();
}

/** The region of a pinned sketch, not the one being drawn, under the pointer: the nearest one along the ray. */
export function pinnedRegionAt(x: number, y: number): { id: number; sketch: SketchData; region: Region; t: number } | null {
  const ray = S.host.view.pointerRay(x, y);
  let best: { id: number; sketch: SketchData; region: Region; t: number } | null = null;
  for (const item of S.editor.pinned) {
    if (item.id === S.editor.active) continue;
    const frame = frameFromWorkplane(workplaneIn({ source: "global", origin: item.sketch.plane.origin, turn: item.sketch.plane.turn }, S.host.pose()));
    const hit = rayOnPlane(frame, ray.origin, ray.direction);
    if (!hit || (best && hit.t >= best.t)) continue;
    const region = regionAt(sketchRegions(item.sketch), hit.uv);
    if (region) best = { id: item.id, sketch: item.sketch, region, t: hit.t };
  }
  return best;
}

/** `region` found again in `sketch` after the drawing changed, by its outline or a point inside it. */
export function sameRegionIn(sketch: SketchData, loops: readonly ProfileLoop[] | undefined): Region | null {
  const outer = loops?.[0];
  return outer ? regionsOfOutlines(sketch, [outer])[0] ?? null : null;
}

export function paintLoft() {
  if (!S.loft || S.editor.phase !== "editing") return;
  S.host.view.setHandles([]);
  if (S.loft.picks.length < 2) {
    S.host.view.setGhost(null);
    return;
  }
  const rings = freshLoftPicks().map((pick) => sectionOutline(pick.section));
  if (rings.some((ring) => ring.length < 3)) {
    S.host.view.setGhost(null);
    return;
  }
  const soup = loftGhost(rings);
  S.host.view.setGhost(soup.length > 0 ? { kind: "soup", positions: soup } : null);
}
