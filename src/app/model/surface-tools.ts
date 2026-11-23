/**
 * Patch edge badges. A picked edge touches a face, so it starts at G1. Clicking the badge cycles G0, G1, G2.
 */
import { fx } from "../fx";
import { defaultBoundaryContinuity, nextContinuity, type SeamContinuity } from "../../model-surface.ts";
import { openModelTool } from "../../ui/model-chrome";
import { viewed } from "./view";

export type { SeamContinuity };
export { defaultBoundaryContinuity, nextContinuity };

const chosen = new Map<number, SeamContinuity>();
let frame = 0;

/** The continuity the Patch tool will ask for on this edge. */
export function continuityOf(index: number): SeamContinuity {
  return chosen.get(index) ?? defaultBoundaryContinuity(true);
}

function edgeMid(index: number): [number, number, number] | null {
  const edge = viewed()?.edges.find((row) => row.id === index);
  if (!edge || edge.points.length < 3) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  let count = 0;
  for (let i = 0; i + 2 < edge.points.length; i += 3) {
    x += edge.points[i]!;
    y += edge.points[i + 1]!;
    z += edge.points[i + 2]!;
    count += 1;
  }
  if (count === 0) return null;
  return [x / count, y / count, z / count];
}

/** The badges on screen: built once per tool and edge set, then only moved and relabelled each frame. */
let built: { key: string; buttons: Map<number, HTMLButtonElement> } | null = null;

function badge(index: number, tool: "patch" | "blend", edges: readonly number[]): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.edge = String(index);
  if (tool === "patch") {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      chosen.set(index, nextContinuity(continuityOf(index)));
      paint(edges);
    });
  } else {
    button.disabled = true;
  }
  return button;
}

function paint(edges: readonly number[]) {
  const host = document.querySelector<HTMLElement>("#modelEdgeBadges");
  if (!host) return;
  const tool = openModelTool();
  if (tool !== "patch" && tool !== "blend") {
    host.hidden = true;
    host.replaceChildren();
    built = null;
    return;
  }
  host.hidden = false;
  const keep = new Set(edges);
  for (const index of [...chosen.keys()]) if (!keep.has(index)) chosen.delete(index);
  // Rebuilt only when the tool or the picked edges change, so a badge keeps focus and a click whose press and release
  // fall in different frames lands on the same button.
  const key = `${tool}:${edges.join(",")}`;
  const first = built?.buttons.values().next().value;
  if (!built || built.key !== key || (first && !first.isConnected)) {
    built = { key, buttons: new Map(edges.map((index) => [index, badge(index, tool, edges)])) };
    host.replaceChildren(...built.buttons.values());
  }
  for (const [index, button] of built.buttons) {
    const mid = edgeMid(index);
    const at = mid ? fx.model?.projectPoint(mid) : null;
    if (!at) {
      button.hidden = true;
      continue;
    }
    button.hidden = false;
    const left = `${at.x}px`;
    const top = `${at.y}px`;
    if (button.style.left !== left) button.style.left = left;
    if (button.style.top !== top) button.style.top = top;
    const continuity = continuityOf(index);
    const label = continuity.toUpperCase();
    if (button.textContent !== label) button.textContent = label;
    const title = tool === "patch" ? "Click to change this edge between G0, G1, and G2." : label;
    if (button.title !== title) button.title = title;
  }
}

/** Draw the badges for the edges picked now, and keep them on the edges while the view moves. */
export function syncEdgeBadges(edges: readonly number[]) {
  window.cancelAnimationFrame(frame);
  const draw = () => {
    paint(edges);
    if (openModelTool() === "patch" || openModelTool() === "blend") frame = window.requestAnimationFrame(draw);
  };
  draw();
}
