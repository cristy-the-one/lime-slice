/**
 * --- P2 (`docs/plan-sketch-for-people.md`). Show me: a small ready-made sketch for each Make tool, opened from the How
 * popover on the plane the person is drawing on, ready for the tool's next click. ---
 *
 * Each drawing is a saved sketch in `demos/` (the same JSON the editor writes), drawn around (0, 0) on a plain plane.
 * `placeDemo` moves it onto the person's plane, centred where they are looking. A demo is never saved: the card puts the
 * person's own sketch back when it closes, and its Apply builds the op without sending it (`src/app/sketch.ts`).
 */
import extrudeJson from "./demos/extrude.json" with { type: "json" };
import holesJson from "./demos/holes.json" with { type: "json" };
import loftTopJson from "./demos/loft-top.json" with { type: "json" };
import loftJson from "./demos/loft.json" with { type: "json" };
import pipeJson from "./demos/pipe.json" with { type: "json" };
import revolveJson from "./demos/revolve.json" with { type: "json" };
import sweepJson from "./demos/sweep.json" with { type: "json" };
import type { HoleSizes } from "./holes.ts";
import { planeAbove } from "./loft-above.ts";
import { readSketch, sketchJson, type Pt, type SketchData, type SketchOn, type SketchPlane } from "./model.ts";

export type DemoKind = "extrude" | "revolve" | "loft" | "sweep" | "pipe" | "holes";

/** The Make tools in the card's order, with Pipe (Sweep with a route alone) after Sweep. */
export const DEMO_KINDS: readonly DemoKind[] = ["extrude", "revolve", "loft", "sweep", "pipe", "holes"];

export interface DemoSpec {
  /** The tool's name on the card. */
  label: string;
  /** What to do next. The status line and the demo's strip say it until Apply. */
  tryIt: string;
  /** What the tool made, said once Apply has run in the demo. */
  made: string;
  /** The op kind the tool's Apply builds: a sweep and a pipe store a loft, holes a group. */
  op: "extrude" | "revolve" | "loft" | "group";
}

export const DEMOS: Readonly<Record<DemoKind, DemoSpec>> = {
  extrude: {
    label: "Extrude",
    tryIt: "Drag the arrow, or type a distance such as 8 and press Enter.",
    made: "Extrude pushed the plate into a solid, and the circle stayed a hole.",
    op: "extrude",
  },
  revolve: {
    label: "Revolve",
    tryIt: "Click your helper line under Spin around, then click Apply.",
    made: "Revolve spun the wall around the helper line into a cup.",
    op: "revolve",
  },
  loft: {
    label: "Loft",
    tryIt: "Click the circle above the square, or its card, then click Apply.",
    made: "Loft blended the square into the circle above it.",
    op: "loft",
  },
  sweep: {
    label: "Sweep",
    tryIt: "The circle stands up at the route's start. Click Apply.",
    made: "Sweep carried the circle along the route.",
    op: "loft",
  },
  pipe: {
    label: "Pipe",
    tryIt: "Type a diameter such as 8 in the box, and press Enter.",
    made: "Pipe made a round rod along the route, its corner rounded to fit.",
    op: "loft",
  },
  holes: {
    label: "Holes",
    tryIt: "Press H, or click Holes, then click Yes.",
    made: "Yes picked all 3 circles. On your part, the Hole panel then sets their size and depth.",
    op: "group",
  },
};

/** The status line once a demo's Apply has run. */
export const DEMO_DONE = "Done. Nothing was added to your part. Click Back to my sketch.";
/** The Make row's How: one line above its Show me buttons. */
export const DEMO_LEAD = "Show me each one on a small ready-made sketch. Your part stays as it is.";
/** The sizes the Holes demo's group is built with: 4 mm holes, 5 mm deep. Nothing is drilled. */
export const DEMO_HOLE_SIZES: HoleSizes = { radius: 2, depth: 5, through: false, counterboreRadius: null, counterboreDepth: null };
/** The section the loft's top shape sits on, above the square, and the name of its card. */
export const LOFT_TOP_HEIGHT_MM = 20;
export const LOFT_TOP_NAME = "Top shape";

/** The How popovers that belong to a Make tool, and the demo each opens. The split's profile has none. */
const HOW_DEMO: Readonly<Record<string, DemoKind>> = {
  extrude: "extrude",
  revolve: "revolve",
  loft: "loft",
  sweep: "sweep",
  "sweep-one": "sweep",
  pipe: "pipe",
};

export function demoForHow(kind: string): DemoKind | null {
  return HOW_DEMO[kind] ?? null;
}

/** A face that isn't on the part: Holes needs a sketch on a face, and a demo drills nothing. */
const DEMO_FACE: SketchOn = { kind: "face", face: { index: -1, mid: [0, 0, 0], areaMm2: 0 } };

const FILES: Readonly<Record<DemoKind | "loft-top", unknown>> = {
  extrude: extrudeJson,
  revolve: revolveJson,
  loft: loftJson,
  "loft-top": loftTopJson,
  sweep: sweepJson,
  pipe: pipeJson,
  holes: holesJson,
};

/** A demo's drawing as stored, around (0, 0) on the ground plane. */
export function demoDrawing(kind: DemoKind | "loft-top"): SketchData {
  const sketch = readSketch(FILES[kind]);
  if (!sketch) throw new Error(`The ${kind} demo is not a sketch.`);
  return sketch;
}

export interface PlacedDemo {
  /** The sketch that opens. */
  drawing: SketchData;
  /** Sketches kept as cards beside it: the loft's top shape. */
  cards: { name: string; sketch: SketchData }[];
}

/**
 * The demo on the person's plane, moved so its (0, 0) sits at `centre`. A face sketch stays on that face; Holes always
 * gets a face to drill into, the person's or a stand-in, since nothing is drilled.
 */
export function placeDemo(kind: DemoKind, at: { plane: SketchPlane; on?: SketchOn; centre: Pt }): PlacedDemo {
  const on = kind === "holes" ? (at.on?.kind === "face" ? at.on : DEMO_FACE) : at.on;
  const drawing = moved(demoDrawing(kind), at.plane, at.centre, on);
  if (kind !== "loft") return { drawing, cards: [] };
  // The top shape is drawn on the plane above, as Add a shape above would put it, with no face under it.
  const top = moved(demoDrawing("loft-top"), planeAbove(at.plane, LOFT_TOP_HEIGHT_MM), at.centre, undefined);
  return { drawing, cards: [{ name: LOFT_TOP_NAME, sketch: top }] };
}

function moved(sketch: SketchData, plane: SketchPlane, centre: Pt, on: SketchOn | undefined): SketchData {
  const [du, dv] = centre;
  const shift = (pt: Pt): Pt => [pt[0] + du, pt[1] + dv];
  const { on: _drop, ...rest } = sketchJson(sketch);
  const out: SketchData = {
    ...rest,
    plane: { origin: [plane.origin[0], plane.origin[1], plane.origin[2]], turn: [plane.turn[0], plane.turn[1], plane.turn[2]] },
    points: rest.points.map((point) => ({ ...point, at: shift(point.at) })),
    entities: rest.entities.map((entity) => (entity.kind === "arc" ? { ...entity, through: shift(entity.through) } : entity)),
  };
  if (on) out.on = on;
  return out;
}
