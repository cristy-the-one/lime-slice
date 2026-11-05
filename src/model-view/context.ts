/** The other plate objects drawn grey behind the open solid, and the text tags beside them. */
import * as THREE from "three";
import { type Bounds, boundsOf } from "../mesh-place";
import type { ContextPart } from "../model-context";
import { boxUnder } from "../model-space";
import { contextMaterial } from "../context-look";
import type { ViewCtx } from "./ctx";

export function installContext(ctx: ViewCtx): void {
  const { borrowed, camera, canvas, context } = ctx;
  ctx.contextHeld = contextHeld;
  ctx.placeTags = placeTags;
  ctx.setContext = setContext;
  ctx.setTags = setTags;


  const contextMat = contextMaterial(ctx.colors.context);
  ctx.contextMat = contextMat;
  const targetMat = contextMaterial(ctx.colors.amber);
  ctx.targetMat = targetMat;
  /**
   * One geometry per source array, so a pose change or a new neighbour never re-uploads a mesh that did not change. A
   * join's ghost draws its tool from the same geometry, and its outline, built the first time, stays with it.
   */
  const contextGeometry = new Map<Float32Array, { geometry: THREE.BufferGeometry; box: Bounds; edges?: THREE.EdgesGeometry }>();
  ctx.objectPicking = false;
  ctx.objectPickCb = () => {};

  function contextHeld(positions: Float32Array) {
    let held = contextGeometry.get(positions);
    if (!held) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      borrowed.add(geometry);
      held = { geometry, box: boundsOf(positions) };
      contextGeometry.set(positions, held);
    }
    return held;
  }

  function setContext(parts: ContextPart[]) {
    const wanted = new Set(parts.map((part) => part.positions));
    if (ctx.ghost?.kind === "object") wanted.add(ctx.ghost.positions);
    for (const [positions, held] of contextGeometry) {
      if (wanted.has(positions)) continue;
      held.geometry.dispose();
      held.edges?.dispose();
      contextGeometry.delete(positions);
    }
    context.clear();
    ctx.contextList = parts;
    const published: string[] = [];
    for (const part of parts) {
      const held = contextHeld(part.positions);
      const mesh = new THREE.Mesh(held.geometry, part.id === ctx.markedTarget ? targetMat : contextMat);
      const { m, t } = part.matrix;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.set(m[0], m[1], m[2], t[0], m[3], m[4], m[5], t[1], m[6], m[7], m[8], t[2], 0, 0, 0, 1);
      mesh.renderOrder = 1;
      mesh.userData.id = part.id;
      context.add(mesh);
      const box = boxUnder(held.box, part.matrix);
      published.push(`${part.id}:${[...box.min, ...box.max].map((value) => value.toFixed(2)).join(",")}`);
    }
    canvas.dataset.contextCount = String(parts.length);
    if (published.length > 0) canvas.dataset.context = published.join(" ");
    else delete canvas.dataset.context;
    if (ctx.grabHooks && parts.length > 0) ctx.warmSnap();
    ctx.kick();
  }

  /** How far a tag keeps from the view's edge. */
  const TAG_EDGE_PX = 4;
  const tags: { el: HTMLDivElement; at: THREE.Vector3 }[] = [];

  function setTags(next: readonly { text: string; at: [number, number, number] }[]) {
    for (const tag of tags.splice(0)) tag.el.remove();
    for (const one of next) {
      const el = document.createElement("div");
      el.className = "model-part-tag";
      el.textContent = one.text;
      canvas.parentElement?.append(el);
      tags.push({ el, at: new THREE.Vector3(...one.at) });
    }
    if (next.length > 0) canvas.dataset.tags = next.map((one) => one.text).join(" ");
    else delete canvas.dataset.tags;
    placeTags();
    ctx.kick();
  }

  /** Each tag over its point, where the camera now sees it, kept inside the view (a point near its edge slides in); hidden behind the camera. */
  function placeTags() {
    if (tags.length === 0) return;
    const box = canvas.getBoundingClientRect();
    const parent = canvas.parentElement?.getBoundingClientRect() ?? box;
    for (const tag of tags) {
      const at = tag.at.clone().project(camera);
      tag.el.hidden = at.z > 1;
      const x = box.left - parent.left + ((at.x + 1) / 2) * box.width;
      const y = box.top - parent.top + ((1 - at.y) / 2) * box.height;
      const [halfW, halfH] = [tag.el.offsetWidth / 2 + TAG_EDGE_PX, tag.el.offsetHeight / 2 + TAG_EDGE_PX];
      const inside = (value: number, low: number, size: number, half: number) => (size > 2 * half ? Math.min(Math.max(value, low + half), low + size - half) : low + size / 2);
      tag.el.style.left = `${Math.round(inside(x, box.left - parent.left, box.width, halfW))}px`;
      tag.el.style.top = `${Math.round(inside(y, box.top - parent.top, box.height, halfH))}px`;
    }
  }
}
