/**
 * --- P2 (`docs/plan-sketch-for-people.md`). Show me: a small ready-made sketch for each Make tool, opened from the How
 * popover on the plane the person is drawing on, ready for the tool's next click. ---
 *
 * Each drawing is a saved sketch in `demos/` (the same JSON the editor writes), drawn around (0, 0) on a plain plane.
 * `placeDemo` moves it onto the person's plane, centred where they are looking. A demo is never saved: the card puts the
 * person's own sketch back when it closes, and its Apply builds the op without sending it (`src/app/sketch.ts`).
 *
 * --- Milestone 6: the Edit tools' demos (Trim, Offset, Fillet corner, Helper line, Copy edge). An edit changes only the
 * demo's own drawing, which is thrown away with it; `aim` is where the tool's next click goes. ---
 */
import extrudeJson from "./demos/extrude.json" with { type: "json" };
import holesJson from "./demos/holes.json" with { type: "json" };
import loftTopJson from "./demos/loft-top.json" with { type: "json" };
import loftJson from "./demos/loft.json" with { type: "json" };
import pipeJson from "./demos/pipe.json" with { type: "json" };
import revolveJson from "./demos/revolve.json" with { type: "json" };
import sweepJson from "./demos/sweep.json" with { type: "json" };
import trimJson from "./demos/trim.json" with { type: "json" };
import offsetJson from "./demos/offset.json" with { type: "json" };
import filletJson from "./demos/fillet.json" with { type: "json" };
import constructionJson from "./demos/construction.json" with { type: "json" };
import useJson from "./demos/use.json" with { type: "json" };
import useFaceJson from "./demos/use-face.json" with { type: "json" };
import { curveOf, pointOn } from "./geom.ts";
import type { RefGeom } from "./refs.ts";
import type { HoleSizes } from "./holes.ts";
import { planeAbove } from "./loft-above.ts";
import { readSketch, sketchJson, type Pt, type SketchData, type SketchOn, type SketchPlane } from "./model.ts";

export type MakeDemoKind = "extrude" | "revolve" | "loft" | "sweep" | "pipe" | "holes";
/** Milestone 6: the Edit tools with a demo. Each is the tool's `data-sketch-tool` value. */
export type EditDemoKind = "trim" | "offset" | "fillet" | "construction" | "use";
export type DemoKind = MakeDemoKind | EditDemoKind;

/** The Make tools in the card's order, with Pipe (Sweep with a route alone) after Sweep. */
export const DEMO_KINDS: readonly MakeDemoKind[] = ["extrude", "revolve", "loft", "sweep", "pipe", "holes"];
/** The Edit tools with a demo, in the Edit row's order. */
export const EDIT_DEMO_KINDS: readonly EditDemoKind[] = ["trim", "offset", "fillet", "construction", "use"];

export function isEditDemo(kind: DemoKind): kind is EditDemoKind {
  return (EDIT_DEMO_KINDS as readonly string[]).includes(kind);
}

export interface DemoSpec {
  /** The tool's name on the card. */
  label: string;
  /** What to do next. The status line and the demo's strip say it until Apply. */
  tryIt: string;
  /** What the tool made, said once Apply has run in the demo. */
  made: string;
  /** The op kind the tool's Apply builds: a sweep and a pipe store a loft, holes a group. An Edit tool's is its own name. */
  op: "extrude" | "revolve" | "loft" | "group" | EditDemoKind;
  /** Where the tool's next click goes, in the stored drawing's coordinates. */
  aim?: Pt;
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
  trim: {
    label: "Trim",
    tryIt: "The red piece sticks out past the corner. Click it to cut it away.",
    made: "Trim cut the red piece away at the crossing, so the outline is clean.",
    op: "trim",
    aim: [18.5, 10],
  },
  offset: {
    label: "Offset",
    tryIt: "Both sides and Close the ends are on. Type 1.5 in the box, press Enter.",
    made: "Offset drew a line each side and closed the ends: a 3 mm wall, ready to extrude.",
    op: "offset",
    aim: [0, -4],
  },
  fillet: {
    label: "Fillet corner",
    tryIt: "Click a corner of the plate, then type a radius such as 4 and press Enter.",
    made: "Fillet corner rounded the corner you clicked and trimmed both lines to the arc.",
    op: "fillet",
    aim: [15, 10],
  },
  construction: {
    label: "Helper line",
    tryIt: "The line down the middle splits the plate in two. Click it to make it a helper.",
    made: "It is a helper line now: it still snaps, and the plate is one shape again.",
    op: "construction",
    aim: [0, 4],
  },
  use: {
    label: "Copy edge",
    tryIt: "The faint outline stands in for your part's face. Click inside it to copy it.",
    made: "Copy edge copied the face's whole outline, its hole too, into your sketch.",
    op: "use",
    aim: [-8, 0],
  },
};

/** The status line once a demo's Apply has run. */
export const DEMO_DONE = "Done. Nothing was added to your part. Click Back to my sketch.";
/** The Make row's How: one line above its Show me buttons. */
export const DEMO_LEAD = "Show me each one on a small ready-made sketch. Your part stays as it is.";
/** The Edit row's How: the same, for the Edit tools, which change only the demo's drawing. */
export const EDIT_DEMO_LEAD = "Show me each one on a small ready-made sketch. Your own sketch comes back after.";
/** The wall Offset's demo opens with: both sides, the ends closed, the line kept as a helper. */
export const DEMO_WALL = { both: true, close: true, helper: true } as const;
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

const FILES: Readonly<Record<DemoKind | "loft-top" | "use-face", unknown>> = {
  trim: trimJson,
  offset: offsetJson,
  fillet: filletJson,
  construction: constructionJson,
  use: useJson,
  "use-face": useFaceJson,
  extrude: extrudeJson,
  revolve: revolveJson,
  loft: loftJson,
  "loft-top": loftTopJson,
  sweep: sweepJson,
  pipe: pipeJson,
  holes: holesJson,
};

/** A demo's drawing as stored, around (0, 0) on the ground plane. */
export function demoDrawing(kind: DemoKind | "loft-top" | "use-face"): SketchData {
  const sketch = readSketch(FILES[kind]);
  if (!sketch) throw new Error(`The ${kind} demo is not a sketch.`);
  return sketch;
}

export interface PlacedDemo {
  /** The sketch that opens. */
  drawing: SketchData;
  /** Sketches kept as cards beside it: the loft's top shape. */
  cards: { name: string; sketch: SketchData }[];
  /** Copy edge's stand-in for a face of the part: its outline as the faint reference edges. */
  refs?: RefGeom;
  /** Where the tool's next click goes, on the plane. */
  aim?: Pt;
}

/**
 * The demo on the person's plane, moved so its (0, 0) sits at `centre`. A face sketch stays on that face; Holes always
 * gets a face to drill into, the person's or a stand-in, since nothing is drilled.
 */
export function placeDemo(kind: DemoKind, at: { plane: SketchPlane; on?: SketchOn; centre: Pt }): PlacedDemo {
  const on = kind === "holes" ? (at.on?.kind === "face" ? at.on : DEMO_FACE) : at.on;
  const drawing = moved(demoDrawing(kind), at.plane, at.centre, on);
  const aim = DEMOS[kind].aim;
  const aimed: Pick<PlacedDemo, "aim"> = aim ? { aim: [aim[0] + at.centre[0], aim[1] + at.centre[1]] } : {};
  if (kind === "use") return { drawing, cards: [], refs: outlineRefs(demoDrawing("use-face"), at.centre), ...aimed };
  if (kind !== "loft") return { drawing, cards: [], ...aimed };
  // The top shape is drawn on the plane above, as Add a shape above would put it, with no face under it.
  const top = moved(demoDrawing("loft-top"), planeAbove(at.plane, LOFT_TOP_HEIGHT_MM), at.centre, undefined);
  return { drawing, cards: [{ name: LOFT_TOP_NAME, sketch: top }] };
}

/** A drawing as the faint face outline Copy edge reads: each curve in short straight pieces, as the view's edges are. */
function outlineRefs(sketch: SketchData, centre: Pt): RefGeom {
  const segments: RefGeom["segments"] = [];
  for (const entity of sketch.entities) {
    const curve = curveOf(sketch, entity);
    if (!curve) continue;
    const count = curve.kind === "line" ? 1 : 32;
    for (let i = 0; i < count; i += 1) {
      const a = pointOn(curve, i / count);
      const b = pointOn(curve, (i + 1) / count);
      segments.push({ a: [a[0] + centre[0], a[1] + centre[1]], b: [b[0] + centre[0], b[1] + centre[1]], source: "outline" });
    }
  }
  return { segments, vertices: [] };
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
