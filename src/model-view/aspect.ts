/** The aspect of a lit handle: its lines, live dimension label, cut trace and the field it belongs to. */
import * as THREE from "three";
import { type CutTrace, traceContour, traceSheet } from "../cut-trace";
import type { DragHandle, Vec3 } from "../model-drag";
import { type HandleAspect, aspectFor, meshPoint } from "../handle-emphasis";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import type { ModelGhost } from "./types";
import type { Workplane } from "../workplane";
import { darkenHex, fieldOf, holeOf, writeAspectDescription } from "./helpers";
import { hexToThree } from "../theme";
import { turnCentre } from "../model-primitive";
import type { ViewCtx } from "./ctx";

export function installAspect(ctx: ViewCtx): void {
  const { aspectGroup, aspectLabel, body, camera, canvas, controls, depthRay, fatLines, ghosts, posed, solidMaterial } = ctx;
  ctx.collectFieldInputs = collectFieldInputs;
  ctx.cutSquare = cutSquare;
  ctx.drawTrace = drawTrace;
  ctx.paintAspect = paintAspect;
  ctx.placeAspectLabel = placeAspectLabel;
  ctx.publishAspectSample = publishAspectSample;
  ctx.setOverHandle = setOverHandle;
  ctx.syncFocusedField = syncFocusedField;

  /** Which side the live dimension sits on. -1 is the far side, used when the label would cover the knob. */
  let aspectGapSign: 1 | -1 = 1;
  let aspectGapFor = "";
  /** Label size from the last text change, so a frame does not measure it again. */
  let labelMeasure = { text: "", width: 0, height: 0 };
  let labelPlaced = { x: 0, y: 0, key: "" };
  let aspectKey = "";
  /** Model dock and HUD inputs, filled when the handles are set, so a drag does not search the document. */
  const fieldInputs = new Map<string, HTMLInputElement[]>();
  /** Aspect lines, in screen pixels. Full axis colour, thick enough to read on the ghost. */
  const ASPECT_LINE_PX = 4;
  let focusSyncs = 0;
  let aspectLines: LineSegments2 | null = null;
  let aspectHidden: LineSegments2 | null = null;
  let aspectBodyLines: LineSegments2 | null = null;
  let aspectBodyHidden: LineSegments2 | null = null;
  /** The lit segments, for a screen-space sample of the line colour. */
  let aspectSample: { positions: number[]; body: boolean } | null = null;
  let aspectSampleKey = "";
  /** Keeps the lit aspect for a moment after the pointer leaves, so a gap between knobs does not flash. */
  let aspectLeaveTimer: number | null = null;

  /**
   * An aspect dims the ghost only. The solid's material is left alone: a sketch dims it through `setSketchDim`,
   * and a handle must not wash the part out.
   */
  function setAspectDim(next: boolean) {
    if (ctx.aspectDim === next) return;
    ctx.aspectDim = next;
    canvas.dataset.aspectDim = next ? "1" : "0";
    canvas.dataset.solidOpacity = String(solidMaterial.opacity);
    ctx.restyleGhostFaces();
    ctx.restyleGhostLines();
    ctx.kick();
  }

  function setOverHandle(next: string | null) {
    if (next) {
      if (aspectLeaveTimer != null) {
        window.clearTimeout(aspectLeaveTimer);
        aspectLeaveTimer = null;
      }
      if (ctx.overHandle === next) return;
      ctx.overHandle = next;
      ctx.paintHandles();
      return;
    }
    if (ctx.overHandle == null || aspectLeaveTimer != null) return;
    aspectLeaveTimer = window.setTimeout(() => {
      aspectLeaveTimer = null;
      ctx.overHandle = null;
      ctx.paintHandles();
    }, 120);
  }

  function paintAspect() {
    const handle = ctx.aspectHandle();
    const id = handle?.id ?? "";
    if (id !== aspectGapFor) {
      aspectGapSign = 1;
      aspectGapFor = id;
    }
    const valueKey = handle ? handle.values.map((value) => value.toFixed(4)).join(",") : "";
    const key = `${id}|${aspectGapSign}|${valueKey}|${ctx.ghostSerial}`;
    if (key === aspectKey) return;
    aspectKey = key;
    const aspect = handle ? aspectFor(handle, { ...aspectContext(handle), gapSign: aspectGapSign }) : null;
    ctx.aspectNow = aspect;
    const world = aspect?.space === "world" ? aspect.lines : [];
    const bodyLines = aspect?.space === "body" ? aspect.lines : [];
    const color = aspect ? ctx.handleColor(aspect.color) : ctx.accent;
    aspectSample = world.length >= 6 ? { positions: world, body: false } : bodyLines.length >= 6 ? { positions: bodyLines, body: true } : null;
    aspectLines = replaceAspect(aspectGroup, aspectLines, world, color, false);
    aspectHidden = replaceAspect(aspectGroup, aspectHidden, world, color, true);
    aspectBodyLines = replaceAspect(body, aspectBodyLines, bodyLines, color, false);
    aspectBodyHidden = replaceAspect(body, aspectBodyHidden, bodyLines, color, true);
    setAspectDim(aspect?.dim === true);
    markAspectFields(aspect);
    publishAspect(handle, aspect);
    placeAspectLabel();
  }

  function aspectContext(handle: DragHandle): Parameters<typeof aspectFor>[1] {
    const current = ctx.ghost;
    const siblings: Record<string, number> = {};
    for (const part of ctx.handleParts) {
      if (part.handle.fields.length === 1) siblings[part.handle.fields[0]!] = part.handle.values[0] ?? 0;
    }
    if (ctx.drag && ctx.drag.handle.fields.length === 1) siblings[ctx.drag.handle.fields[0]!] = ctx.drag.values[0] ?? 0;
    const framed = handle.frame ? handle : ctx.handleParts.find((part) => part.handle.frame)?.handle;
    const at = framed && framed.seat.at === "feature" ? framed.seat.origin : undefined;
    return {
      spec: current?.kind === "primitive" ? current.spec : null,
      pieces: current?.kind === "pieces" ? current.parts.map((part) => part.spec) : undefined,
      hole: ctx.lightEveryHole ? null : current?.kind === "hole" ? current : current?.kind === "holes" ? current.holes[handle.holeIndex ?? 0] ?? current.holes[0] ?? null : null,
      holes: ctx.lightEveryHole && current?.kind === "holes" ? current.holes : null,
      edgePoints: current?.kind === "blend" ? worldEdgePoints(current.edges) : null,
      soup: current?.kind === "soup" ? worldPoints(current.positions) : null,
      measure: current?.kind === "measure" ? { a: current.a, b: current.b } : null,
      plane: current?.kind === "plane" ? { origin: current.origin, normal: current.normal, span: Math.max(ctx.extent * 1.45, 30) } : cutOf(current, handle),
      bodyBox: ctx.ownBox,
      anchor: aspectAnchor(),
      extent: ctx.extent,
      frame: framed?.frame as Workplane | undefined,
      at,
      siblings,
      values: handle.values,
    };
  }

  /** --- Split to print. The one plane a cut's arrow or its tilt rings change, so only that plane's outline lights. */
  function cutOf(current: ModelGhost | null, handle: DragHandle): { origin: Vec3; normal: Vec3; span: number } | null {
    const plane = current?.kind === "cuts" && handle.cutIndex != null ? current.planes[handle.cutIndex] : undefined;
    return plane ? { ...cutSquare(plane), normal: plane.normal } : null;
  }

  /**
   * A cut's square: centred where the solid's middle drops onto the plane, and twice as wide as the furthest corner of the
   * solid's box from there, in the plane, so it clears the section however the plane turns about its normal.
   */
  /**
   * A shaped cut's path, in model space: the line its profile leaves on the part, bold where it is seen and faint through
   * the part, and the sheet it sweeps, folded along the profile, a little past the part. False when it misses the part.
   */
  function drawTrace(trace: CutTrace): boolean {
    if (!ctx.solid) return false;
    // The part's triangles are in its own frame: the trace goes there, and the path comes back with the solid's pose.
    const back = posed.matrix.clone().invert();
    const point = (p: Vec3) => new THREE.Vector3(...p).applyMatrix4(back).toArray() as Vec3;
    const dir = (d: Vec3) => new THREE.Vector3(...d).transformDirection(back).toArray() as Vec3;
    const own: CutTrace = { ...trace, origin: point(trace.origin), across: dir(trace.across), sweep: dir(trace.sweep), w: dir(trace.w) };
    const key = JSON.stringify(own);
    if (ctx.tracesHeld.positions !== ctx.solid.positions) ctx.tracesHeld = { positions: ctx.solid.positions, paths: new Map() };
    const contour = ctx.tracesHeld.paths.get(key) ?? traceContour(ctx.solid.positions, own);
    // A drag traces a new path each step: only the last few are worth keeping.
    if (ctx.tracesHeld.paths.size >= 8) ctx.tracesHeld.paths.clear();
    ctx.tracesHeld.paths.set(key, contour);
    if (contour.length < 6) return false;
    const sheet = traceSheet(own, contour, Math.max(ctx.extent * 0.04, 2));
    const posedLine = (positions: ArrayLike<number>, width: number, opacity: number, color: number, seen: boolean) => {
      const line = ctx.fatLine(Array.from(positions), width, opacity, color);
      if (!line) return;
      const material = line.material as LineMaterial;
      material.depthTest = seen;
      material.toneMapped = false;
      line.matrixAutoUpdate = false;
      line.matrix.copy(posed.matrix);
      line.renderOrder = seen ? 5 : 4;
      ghosts.add(line);
    };
    if (sheet) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(sheet.triangles, 3));
      geometry.computeVertexNormals();
      const meshGhost = new THREE.Mesh(geometry, ctx.ghostMaterial(0.12));
      meshGhost.matrixAutoUpdate = false;
      meshGhost.matrix.copy(posed.matrix);
      meshGhost.renderOrder = 2;
      meshGhost.raycast = () => undefined;
      ghosts.add(meshGhost);
      posedLine(sheet.edges, 1.25, 0.75, ctx.accent, true);
    }
    const ink = hexToThree(ctx.colors.text);
    posedLine(contour, 1.5, 0.35, ink, false);
    posedLine(contour, 3, 1, ink, true);
    canvas.dataset.cutPath = String(Number(canvas.dataset.cutPath ?? 0) + contour.length / 6);
    return true;
  }

  function cutSquare(plane: { origin: Vec3; normal: Vec3 }): { origin: Vec3; span: number } {
    const box = ctx.solidBox ?? { min: [0, 0, 0], max: [0, 0, 0] };
    const mid = new THREE.Vector3((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
    const normal = new THREE.Vector3(...plane.normal).normalize();
    const middle = mid.clone().addScaledVector(normal, -normal.dot(mid.clone().sub(new THREE.Vector3(...plane.origin))));
    let far = 0;
    for (let corner = 0; corner < 8; corner += 1) {
      const d = new THREE.Vector3(corner & 1 ? box.max[0] : box.min[0], corner & 2 ? box.max[1] : box.min[1], corner & 4 ? box.max[2] : box.min[2]).sub(middle);
      far = Math.max(far, d.addScaledVector(normal, -d.dot(normal)).length());
    }
    return { origin: [middle.x, middle.y, middle.z], span: Math.max(far * 2.3, 20) };
  }

  function aspectAnchor(): Vec3 {
    if (ctx.solidBox) return [(ctx.solidBox.min[0] + ctx.solidBox.max[0]) / 2, (ctx.solidBox.min[1] + ctx.solidBox.max[1]) / 2, (ctx.solidBox.min[2] + ctx.solidBox.max[2]) / 2];
    if (ctx.ghost?.kind === "primitive") return meshPoint(ctx.ghost.spec, turnCentre(ctx.ghost.spec));
    return [0, 0, 0];
  }

  /** Solid-frame points, in model space, so a cap lines up with a handle that already sits in model space. */
  function worldPoints(local: ArrayLike<number>): Float32Array {
    body.updateMatrixWorld(true);
    const out = new Float32Array(local.length);
    const point = new THREE.Vector3();
    for (let i = 0; i + 2 < local.length; i += 3) {
      point.set(local[i]!, local[i + 1]!, local[i + 2]!).applyMatrix4(body.matrixWorld);
      out[i] = point.x;
      out[i + 1] = point.y;
      out[i + 2] = point.z;
    }
    return out;
  }

  function worldEdgePoints(ids: readonly number[]): number[] {
    if (!ctx.solid) return [];
    const local: number[] = [];
    for (const id of ids) {
      const edge = ctx.solid.edges.find((item) => item.id === id);
      if (edge) local.push(...edge.points);
    }
    return [...worldPoints(local)];
  }

  function dropAspect(parent: THREE.Object3D, current: LineSegments2 | null) {
    if (!current) return;
    parent.remove(current);
    const material = current.material as LineMaterial;
    const index = fatLines.indexOf(material);
    if (index >= 0) fatLines.splice(index, 1);
    ctx.disposeObject(current);
  }

  /** Full axis colour. The solid pass reads through the ghost; the dashed pass is only the part the solid hides. */
  function replaceAspect(parent: THREE.Object3D, current: LineSegments2 | null, positions: number[], color: number, hidden: boolean): LineSegments2 | null {
    if (positions.length < 6) {
      dropAspect(parent, current);
      return null;
    }
    const hex = hidden ? darkenHex(color, 0.6) : color;
    if (current?.parent === parent) {
      (current.geometry as LineSegmentsGeometry).setPositions(positions);
      if (hidden) current.computeLineDistances();
      const material = current.material as LineMaterial;
      material.color.setHex(hex);
      material.linewidth = ASPECT_LINE_PX;
      if (hidden) applyDash(material);
      return current;
    }
    dropAspect(parent, current);
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    const material = new LineMaterial({
      color: hex,
      linewidth: ASPECT_LINE_PX,
      transparent: hidden,
      opacity: 1,
      depthTest: true,
      depthWrite: false,
      worldUnits: false,
      dashed: hidden,
      dashScale: 1,
      dashSize: 1,
      gapSize: 1,
      toneMapped: false,
    });
    material.depthFunc = hidden ? THREE.GreaterDepth : THREE.LessEqualDepth;
    if (hidden) applyDash(material);
    material.resolution.copy(ctx.lineResolution());
    fatLines.push(material);
    const lines = new LineSegments2(geometry, material);
    if (hidden) lines.computeLineDistances();
    lines.renderOrder = hidden ? 9 : 8;
    lines.raycast = () => undefined;
    parent.add(lines);
    return lines;
  }

  function rememberInput(input: HTMLInputElement) {
    const id = input.id || input.dataset.field || "";
    if (!id) return;
    const list = fieldInputs.get(id) ?? [];
    if (!list.includes(input)) list.push(input);
    fieldInputs.set(id, list);
  }

  /** The dock's fields, taken once when the tool's handles are built. */
  function collectFieldInputs() {
    fieldInputs.clear();
    document.getElementById("modelPanel")?.querySelectorAll<HTMLInputElement>("input").forEach(rememberInput);
    document.querySelectorAll<HTMLInputElement>(".interact-hud input[data-field]").forEach(rememberInput);
  }

  function inputsFor(id: string): HTMLInputElement[] {
    const known = (fieldInputs.get(id) ?? []).filter((input) => input.isConnected);
    if (known.length > 0) {
      fieldInputs.set(id, known);
      return known;
    }
    const found: HTMLInputElement[] = [];
    const byId = document.getElementById(id);
    if (byId instanceof HTMLInputElement) found.push(byId);
    const hud = document.querySelector<HTMLInputElement>(`.interact-hud input[data-field="${CSS.escape(id)}"]`);
    if (hud && !found.includes(hud)) found.push(hud);
    if (found.length > 0) fieldInputs.set(id, found);
    return found;
  }

  function markAspectFields(aspect: HandleAspect | null) {
    const wanted = new Set(aspect?.fields ?? []);
    if (aspect) for (const id of aspect.fields) inputsFor(id);
    for (const [id, inputs] of fieldInputs) {
      const on = wanted.has(id);
      for (const input of inputs) {
        if (!input.isConnected) continue;
        if (on && aspect) {
          input.classList.add("is-aspect");
          input.dataset.aspectColor = aspect.color;
          input.setAttribute("aria-describedby", "modelAspectDesc");
        } else if (input.classList.contains("is-aspect")) {
          input.classList.remove("is-aspect");
          delete input.dataset.aspectColor;
          input.removeAttribute("aria-describedby");
        }
      }
    }
    placeAspectBadge(aspect);
    writeAspectDescription(aspect);
  }

  function placeAspectBadge(aspect: HandleAspect | null) {
    let badge = document.getElementById("modelAspectBadge");
    if (!badge) {
      badge = document.createElement("span");
      badge.id = "modelAspectBadge";
      badge.className = "model-aspect-badge";
      badge.setAttribute("aria-hidden", "true");
      document.getElementById("modelPanel")?.append(badge);
    }
    const letter = aspect?.color === "x" ? "X" : aspect?.color === "y" ? "Y" : aspect?.color === "z" ? "Z" : "";
    const input = aspect ? inputsFor(aspect.fields[0] ?? "").find((item) => item.id) : undefined;
    const panel = document.getElementById("modelPanel");
    if (!letter || !input || !panel) {
      badge.hidden = true;
      return;
    }
    badge.hidden = false;
    badge.textContent = letter;
    badge.dataset.color = aspect!.color;
    const host = panel.getBoundingClientRect();
    const box = input.getBoundingClientRect();
    badge.style.left = `${Math.round(box.right - host.left - 16)}px`;
    badge.style.top = `${Math.round(box.top - host.top + 3)}px`;
  }

  function publishAspect(handle: DragHandle | null, aspect: HandleAspect | null) {
    if (!handle || !aspect) {
      delete canvas.dataset.aspect;
      delete canvas.dataset.aspectTip;
      delete canvas.dataset.aspectField;
      delete canvas.dataset.aspectMapped;
      delete canvas.dataset.aspectLines;
      delete canvas.dataset.aspectAt;
      if (!ctx.aspectDim) canvas.dataset.aspectDim = "0";
      return;
    }
    canvas.dataset.aspect = handle.id;
    canvas.dataset.aspectTip = aspect.tip;
    canvas.dataset.aspectField = aspect.fields.join(" ");
    canvas.dataset.aspectMapped = aspect.mapped ? "1" : "0";
    canvas.dataset.aspectLines = String(Math.floor(aspect.lines.length / 6));
    publishAspectAt(handle);
  }

  /** The lit hole's centre, in canvas pixels, so a test can tell hole 2 from hole 1. */
  function publishAspectAt(handle: DragHandle | null) {
    const holes = ctx.ghost?.kind === "holes" ? ctx.ghost.holes : null;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (holes && holes.length > 0) {
      const centres = holes.map((item) => {
        const at = new THREE.Vector3(item.x, item.y, item.z).project(camera);
        return `${Math.round((at.x * 0.5 + 0.5) * width)},${Math.round((-at.y * 0.5 + 0.5) * height)}`;
      }).join(" ");
      if (canvas.dataset.holeCentres !== centres) canvas.dataset.holeCentres = centres;
    } else delete canvas.dataset.holeCentres;
    const hole = holes && handle?.holeIndex != null ? holes[handle.holeIndex] : null;
    if (!hole) {
      delete canvas.dataset.aspectAt;
      return;
    }
    const projectedAt = new THREE.Vector3(hole.x, hole.y, hole.z).project(camera);
    const text = `${Math.round((projectedAt.x * 0.5 + 0.5) * width)},${Math.round((-projectedAt.y * 0.5 + 0.5) * height)}`;
    if (canvas.dataset.aspectAt !== text) canvas.dataset.aspectAt = text;
  }

  /** Dashes of a few screen pixels, so a short walk along a hidden edge crosses a gap. */
  function applyDash(material: LineMaterial) {
    const dist = Math.max(1e-3, camera.position.distanceTo(controls.target));
    const mm = (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, canvas.clientHeight) / Math.max(1e-3, camera.zoom);
    // Longer than a 5×5 patch, so a gap's sample is the part behind the dash and a dash's sample is the dash.
    material.dashSize = mm * 12;
    material.gapSize = mm * 12;
  }

  /** A line point the solid sits in front of. A point on the surface still counts as seen. */
  function lineHidden(point: THREE.Vector3): boolean {
    if (!ctx.mesh) return false;
    const dir = point.clone().sub(camera.position);
    const dist = dir.length();
    if (dist < 1e-4) return false;
    depthRay.set(camera.position, dir.normalize());
    return depthRay.intersectObject(ctx.mesh, false).some((hit) => hit.distance < dist - 0.4);
  }

  /**
   * A seen midpoint (`data-aspect-sample`) and a point behind the solid (`data-aspect-hidden`,
   * `x,y,dx,dy` with a unit screen direction along that edge).
   */
  function publishAspectSample() {
    const sample = aspectSample;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const key = sample ? `${aspectKey}|${width}|${height}|${camera.matrixWorld.elements.join(",")}` : "";
    if (key === aspectSampleKey) return;
    aspectSampleKey = key;
    if (!sample || sample.positions.length < 6) {
      delete canvas.dataset.aspectSample;
      delete canvas.dataset.aspectHidden;
      return;
    }
    let visible: string | null = null;
    let hidden: string | null = null;
    const positions = sample.positions;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const world = new THREE.Vector3();
    // The middle of an edge sits on the face, and that face is more saturated than the axis line.
    // Use the long run, in from the end that sticks furthest into empty space.
    const ghostBox = ctx.ghostBounds();
    const centreMark = ghostBox ? ghostBox.centre.clone().project(camera) : null;
    const originX = centreMark && centreMark.z >= -1 && centreMark.z <= 1 ? (centreMark.x * 0.5 + 0.5) * width : width / 2;
    const originY = centreMark && centreMark.z >= -1 && centreMark.z <= 1 ? (-centreMark.y * 0.5 + 0.5) * height : height / 2;
    const project = (point: THREE.Vector3) => {
      const mark = point.clone().project(camera);
      return { x: (mark.x * 0.5 + 0.5) * width, y: (-mark.y * 0.5 + 0.5) * height, z: mark.z };
    };
    let bestLen = 0;
    let bestAt: { x: number; y: number } | null = null;
    for (let i = 0; i + 5 < positions.length; i += 6) {
      a.set(positions[i]!, positions[i + 1]!, positions[i + 2]!);
      b.set(positions[i + 3]!, positions[i + 4]!, positions[i + 5]!);
      if (sample.body) {
        body.localToWorld(a);
        body.localToWorld(b);
      }
      const sa = project(a);
      const sb = project(b);
      const segLen = Math.hypot(sb.x - sa.x, sb.y - sa.y);
      for (const t of [0.5, 0.25, 0.75]) {
        world.lerpVectors(a, b, t);
        const mark = project(world);
        if (mark.z < -1 || mark.z > 1) continue;
        if (mark.x < 1 || mark.y < 1 || mark.x > width - 1 || mark.y > height - 1) continue;
        const behind = lineHidden(world);
        if (behind && !hidden) {
          const dx = sb.x - sa.x;
          const dy = sb.y - sa.y;
          const len = Math.hypot(dx, dy) || 1;
          hidden = `${Math.round(mark.x)},${Math.round(mark.y)},${(dx / len).toFixed(3)},${(dy / len).toFixed(3)}`;
        }
        if (behind || segLen + 1e-3 < bestLen) continue;
        const end = Math.hypot(sa.x - originX, sa.y - originY) >= Math.hypot(sb.x - originX, sb.y - originY) ? sa : sb;
        const inward = 28;
        const vx = mark.x - end.x;
        const vy = mark.y - end.y;
        const span = Math.hypot(vx, vy) || 1;
        const dist = Math.min(inward, span / 2);
        const x = end.x + (vx / span) * dist;
        const y = end.y + (vy / span) * dist;
        if (segLen > bestLen + 1e-3 || !bestAt) {
          bestLen = segLen;
          bestAt = { x, y };
        }
      }
    }
    if (bestAt) visible = `${Math.round(bestAt.x)},${Math.round(bestAt.y)}`;
    if (visible) canvas.dataset.aspectSample = visible;
    else delete canvas.dataset.aspectSample;
    if (hidden) canvas.dataset.aspectHidden = hidden;
    else delete canvas.dataset.aspectHidden;
  }

  function placeAspectLabel() {
    const dimension = ctx.aspectNow?.dimension;
    if (!dimension) {
      aspectLabel.hidden = true;
      aspectLabel.textContent = "";
      labelMeasure.text = "";
      return;
    }
    const mid: Vec3 = [
      (dimension.from[0] + dimension.to[0]) / 2,
      (dimension.from[1] + dimension.to[1]) / 2,
      (dimension.from[2] + dimension.to[2]) / 2,
    ];
    const point = new THREE.Vector3(...mid);
    if (ctx.aspectNow?.space === "body") body.localToWorld(point);
    const projectedAt = point.project(camera);
    if (projectedAt.z < -1 || projectedAt.z > 1) {
      aspectLabel.hidden = true;
      return;
    }
    const parent = canvas.parentElement?.getBoundingClientRect();
    const rect = canvas.getBoundingClientRect();
    if (!parent) return;
    aspectLabel.hidden = false;
    if (labelMeasure.text !== dimension.text) {
      aspectLabel.textContent = dimension.text;
      const measured = aspectLabel.getBoundingClientRect();
      labelMeasure = { text: dimension.text, width: measured.width, height: measured.height };
    }
    aspectLabel.dataset.color = ctx.aspectNow?.color ?? "accent";
    const x = rect.left + (projectedAt.x * 0.5 + 0.5) * rect.width - parent.left;
    const y = rect.top + (-projectedAt.y * 0.5 + 0.5) * rect.height - parent.top;
    aspectLabel.style.left = `${Math.round(x)}px`;
    aspectLabel.style.top = `${Math.round(y)}px`;
    const moved = Math.hypot(x - labelPlaced.x, y - labelPlaced.y) > 2 || aspectKey !== labelPlaced.key;
    labelPlaced = { x, y, key: aspectKey };
    if (moved && aspectGapSign === 1 && labelCoversKnob(x - (rect.left - parent.left), y - (rect.top - parent.top))) {
      aspectGapSign = -1;
      paintAspect();
    }
  }

  /** The label's cached box against the knob's grip, both in canvas pixels. */
  function labelCoversKnob(lx: number, ly: number): boolean {
    const handle = ctx.aspectHandle();
    if (!handle || aspectLabel.hidden) return false;
    const part = ctx.drawnHandles().find((item) => item.handle.id === handle.id);
    if (!part) return false;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const at = ctx.gripPoint(handle, part.root.position, part.root.scale.x).project(camera);
    const kx = (at.x * 0.5 + 0.5) * width;
    const ky = (-at.y * 0.5 + 0.5) * height;
    const pad = 12;
    return lx < kx + pad && lx + labelMeasure.width > kx - pad && ly < ky + pad && ly + labelMeasure.height > ky - pad;
  }

  function handleOwns(id: string): boolean {
    return ctx.handleParts.some((part) => part.handle.fields.includes(id));
  }

  function syncFocusedField() {
    focusSyncs += 1;
    canvas.dataset.focusSyncs = String(focusSyncs);
    const active = document.activeElement;
    const id = fieldOf(active);
    const hole = holeOf(active);
    const next = id && handleOwns(id) ? id : null;
    const nextHole = next ? hole : null;
    if (next === ctx.focusedField && nextHole === ctx.focusedHole) return;
    ctx.focusedField = next;
    ctx.focusedHole = nextHole;
    ctx.paintHandles();
  }
}
