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

function paint(edges: readonly number[]) {
  const host = document.querySelector<HTMLElement>("#modelEdgeBadges");
  if (!host) return;
  const tool = openModelTool();
  if (tool !== "patch" && tool !== "blend") {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  host.hidden = false;
  const keep = new Set(edges);
  for (const index of [...chosen.keys()]) if (!keep.has(index)) chosen.delete(index);
  host.replaceChildren();
  for (const index of edges) {
    const mid = edgeMid(index);
    const at = mid ? fx.model?.projectPoint(mid) : null;
    if (!at) continue;
    const button = document.createElement("button");
    button.type = "button";
    const continuity = continuityOf(index);
    button.textContent = continuity.toUpperCase();
    button.dataset.edge = String(index);
    button.style.left = `${at.x}px`;
    button.style.top = `${at.y}px`;
    button.title = tool === "patch" ? "Click to change this edge between G0, G1, and G2." : continuity.toUpperCase();
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
    host.appendChild(button);
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
