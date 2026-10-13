import {
  type BedRect, type Box, type DimEdge, type Rect, type ScaleBar, type Vec3,
  MIN_TICK_GAP_PX, chooseEdges, cullByDistance, cullLabels, flatEdges, formatMm, labelBeside, majorTicks, nearBedEdges, scaleBar, tickPriority,
} from "./measure";
import { measureOn } from "./measure-pref";
import "./ui/measure.css";

/** What a view tells the overlay about itself each frame. Lengths are print millimetres, Z up; screen values are CSS pixels in the host. */
export interface MeasureFrame {
  w: number;
  h: number;
  /** The part's printed box, or null for none. */
  box: Box | null;
  /** The eye, or null for a view straight down with +Y up the screen. */
  cam: Vec3 | null;
  /** Null when the point is behind the camera. */
  project(p: Vec3): [number, number] | null;
  /** Millimetres one pixel spans at the view centre. */
  mmPerPx: number;
  /** The bed the numbers sit along, or null when the view draws no bed. */
  bed: BedRect | null;
}

export interface MeasureOverlay {
  /** Draw this frame, or clear the overlay for null. Draws nothing while the Measure toggle is off. */
  render(frame: MeasureFrame | null): void;
}

export interface MeasureOptions {
  /** Pixels between the scale bar and the right edge, for a view that has its own corner widget. */
  scaleRight?: number;
  /** Where the scale bar sits on a phone, where the layer slider, a Slice button and the playback bar float over the corners. */
  scalePhone?: { right: number; bottom: number };
}

const FONT_PX = 11;
/** Advance of the mono face: 0.6 of its size. */
const CHAR_PX = FONT_PX * 0.6;
const LABEL_H = FONT_PX + 3;
/** Shortest callout line worth drawing. */
const MIN_LINE_PX = 24;
/**
 * A callout line stands this far off the box's edge, so it reads against the part's own edge, with a short
 * extension at each end. Label, stand-off and extension fit in the air the 2D view leaves round a layer.
 */
const STAND_OFF_PX = 8;
const EXTEND_PX = 3;
const LABEL_GAP_PX = 3;
const SCALE_BOTTOM_PX = 8;

const textWidth = (text: string) => Math.ceil(text.length * CHAR_PX);
const n = (value: number) => value.toFixed(1);

/** One callout: its line from `a` to `b` on screen, and its label's rectangle. */
interface Callout extends Rect {
  edge: DimEdge;
  a: [number, number];
  b: [number, number];
  perp: [number, number];
  label: string;
  /** Text turned to read along the line: the 2D view's Y, which has no room beside the layer for it to lie flat. */
  turned: boolean;
}

function callouts(frame: MeasureFrame, box: Box, edges: DimEdge[]): Callout[] {
  const center = frame.project([
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ]);
  if (!center) return [];
  const out: Callout[] = [];
  for (const edge of edges) {
    const a = frame.project(edge.from);
    const b = frame.project(edge.to);
    if (!a || !b) continue;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < MIN_LINE_PX) continue;
    const axis = edge.axis === "x" ? 0 : edge.axis === "y" ? 1 : 2;
    const label = formatMm(edge.to[axis]! - edge.from[axis]!);
    // Off the line, on the side away from the part.
    const perp: [number, number] = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (perp[0] * (mid[0] - center[0]) + perp[1] * (mid[1] - center[1]) < 0) {
      perp[0] = -perp[0];
      perp[1] = -perp[1];
    }
    const at: [number, number] = [mid[0] + perp[0] * STAND_OFF_PX, mid[1] + perp[1] * STAND_OFF_PX];
    const turned = !frame.cam && edge.axis === "y";
    const [w, h] = turned ? [LABEL_H, textWidth(label)] : [textWidth(label), LABEL_H];
    out.push({ edge, a, b, perp, label, turned, ...labelBeside(at, perp, w, h, LABEL_GAP_PX) });
  }
  return out;
}

function calloutMarkup(c: Callout): string {
  const reach = STAND_OFF_PX + EXTEND_PX;
  const at = (p: [number, number], d: number) => `${n(p[0] + c.perp[0] * d)} ${n(p[1] + c.perp[1] * d)}`;
  const path = `M${at(c.a, 0)}L${at(c.a, reach)}M${at(c.b, 0)}L${at(c.b, reach)}M${at(c.a, STAND_OFF_PX)}L${at(c.b, STAND_OFF_PX)}`;
  const cx = n(c.x + c.w / 2);
  const cy = n(c.y + c.h / 2);
  const turn = c.turned ? ` transform="rotate(-90 ${cx} ${cy})"` : "";
  return `<path class="m-line" d="${path}"/><text class="m-dim" data-axis="${c.edge.axis}" x="${cx}" y="${cy}" dy="0.35em" text-anchor="middle"${turn}>${c.label}</text>`;
}

/** A bed number: its value and where its text is centred. */
interface BedLabel {
  mm: number;
  x: number;
  y: number;
}

/** The numbers at the bed's 50 mm lines along its front and near side, thinned to what the screen can hold. */
function bedLabels(frame: MeasureFrame, bed: BedRect, cam: Vec3, taken: Rect[]): BedLabel[] {
  const edges = nearBedEdges(cam, bed);
  const found: (Rect & { mm: number })[] = [];
  const lay = (mm: number, at: Vec3, out: Vec3) => {
    const p = frame.project(at);
    const q = frame.project(out);
    if (!p || !q) return;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const dir: [number, number] = len > 1e-6 ? [(q[0] - p[0]) / len, (q[1] - p[1]) / len] : [0, 1];
    found.push({ mm, ...labelBeside(p, dir, textWidth(String(mm)), LABEL_H, 5) });
  };
  for (const mm of majorTicks(bed.x1)) {
    if (mm >= bed.x0) lay(mm, [mm, edges.frontY, 0], [mm, edges.frontY + edges.outY, 0]);
  }
  for (const mm of majorTicks(bed.y1)) {
    if (mm >= bed.y0) lay(mm, [edges.sideX, mm, 0], [edges.sideX + edges.outX, mm, 0]);
  }
  found.sort((p, q) => tickPriority(p.mm) - tickPriority(q.mm) || p.mm - q.mm);
  const fits = cullLabels(found, frame.w, frame.h, taken);
  return cullByDistance(fits.map((l) => ({ mm: l.mm, x: l.x + l.w / 2, y: l.y + l.h / 2 })), MIN_TICK_GAP_PX);
}

function bedMarkup(label: BedLabel): string {
  return `<text class="m-bed" x="${n(label.x)}" y="${n(label.y)}" dy="0.35em" text-anchor="middle">${label.mm}</text>`;
}

/** The scale bar in the bottom right corner: its parts, and the rectangle it takes. Null when the view is too small for one. */
function scaleLayout(frame: MeasureFrame, right: number, bottom: number): { bar: ScaleBar; x0: number; x1: number; y: number; rect: Rect } | null {
  const bar = scaleBar(frame.mmPerPx);
  if (!bar) return null;
  const x1 = frame.w - right;
  const x0 = x1 - bar.px;
  const y = frame.h - bottom;
  if (x0 < 8 || y < 24) return null;
  return { bar, x0, x1, y, rect: { x: x0, y: y - 11 - LABEL_H / 2, w: bar.px, h: 11 + LABEL_H / 2 } };
}

function scaleMarkup(s: NonNullable<ReturnType<typeof scaleLayout>>): string {
  return `<path class="m-scale" d="M${n(s.x0)} ${n(s.y - 5)}L${n(s.x0)} ${n(s.y)}L${n(s.x1)} ${n(s.y)}L${n(s.x1)} ${n(s.y - 5)}"/>`
    + `<text class="m-scale-label" x="${n((s.x0 + s.x1) / 2)}" y="${n(s.y - 11)}" text-anchor="middle">${s.bar.label}</text>`;
}

export function mountMeasureOverlay(host: HTMLElement, options: MeasureOptions = {}): MeasureOverlay {
  const root = document.createElement("div");
  root.className = "measure";
  root.setAttribute("aria-hidden", "true");
  host.append(root);
  let shown = "";
  const show = (html: string) => {
    if (html === shown) return;
    shown = html;
    root.innerHTML = html;
  };
  return {
    render(frame) {
      if (!frame || !measureOn() || frame.w < 2 || frame.h < 2) {
        show("");
        return;
      }
      const phone = options.scalePhone && document.documentElement.classList.contains("layout-compact") ? options.scalePhone : null;
      const scale = scaleLayout(frame, phone?.right ?? options.scaleRight ?? 14, phone?.bottom ?? SCALE_BOTTOM_PX);
      const edges = !frame.box ? [] : frame.cam ? chooseEdges(frame.cam, frame.box) : flatEdges(frame.box);
      const kept = frame.box ? cullLabels(callouts(frame, frame.box, edges), frame.w, frame.h, scale ? [scale.rect] : []) : [];
      let body = kept.map(calloutMarkup).join("");
      if (frame.bed && frame.cam) body += bedLabels(frame, frame.bed, frame.cam, scale ? [...kept, scale.rect] : kept).map(bedMarkup).join("");
      if (scale) body += scaleMarkup(scale);
      show(body ? `<svg width="${frame.w}" height="${frame.h}">${body}</svg>` : "");
    },
  };
}
