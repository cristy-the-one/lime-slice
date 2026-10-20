/**
 * Status-bar titles and the numbered steps that used to share one line.
 * A title is what the status bar shows. Steps open in the How popover.
 */

export const HINT_LIMIT = 80;
export const TITLE_LIMIT = 40;

export interface StatusHint {
  id: string;
  /** Status bar. A feature title stays within {@link TITLE_LIMIT}. */
  title: string;
  steps: string[];
  feature?: boolean;
}

export const STATUS_HINTS: readonly StatusHint[] = [
  {
    id: "extrude",
    feature: true,
    title: "Extrude {detail}",
    steps: ["Click a region.", "Drag the arrow or type the distance.", "Enter applies, Esc cancels."],
  },
  {
    id: "revolve",
    feature: true,
    title: "Revolve {detail}",
    steps: ["Click a region.", "Drag the ring or type the angle.", "Enter applies, Esc cancels."],
  },
  {
    id: "loft",
    feature: true,
    title: "Loft {detail}",
    steps: ["Pick sections in order.", "R rules the loft.", "Enter applies, Esc cancels."],
  },
  {
    id: "sweep",
    feature: true,
    title: "Sweep {detail}",
    steps: ["Click a region for the profile.", "Pick a path.", "Drag or type the end scale. Enter applies."],
  },
  { id: "choose", title: "Click a flat face, an origin plane, or the workplane.", steps: ["Esc cancels."] },
  { id: "pinned", title: "Sketch kept. A feature can use it.", steps: ["Discard drops the sketch."] },
  { id: "look", title: "Look around is on. O locks the view.", steps: ["O locks the view for drawing."] },
  { id: "line", title: "Line. Click points. Type a length and an angle.", steps: ["Double-click or Esc ends the line.", "Click the start point to close."] },
  { id: "rectangle", title: "Rectangle. Click two corners.", steps: ["Hold Ctrl to start from the centre.", "Type a width and a height."] },
  { id: "circle", title: "Circle. Click the centre. Type a diameter.", steps: ["Click the centre, then a point on the radius."] },
  { id: "arc", title: "Arc. Click the start, the end, and a point.", steps: ["Hold Shift for an arc tangent to the last line.", "Type a radius and a sweep."] },
  { id: "polygon", title: "Polygon. Type across corners and the sides.", steps: ["Click the centre, then a corner."] },
  { id: "slot", title: "Slot. Click two centres, then the width.", steps: ["Type a length and a width."] },
  { id: "spline", title: "Spline. Click points. Double-click ends it.", steps: ["Click the start point to close."] },
  { id: "trim", title: "Trim. Click the piece to remove.", steps: ["Click the piece that should go."] },
  { id: "offset", title: "Offset. Click a line and drag, or type.", steps: ["Type a distance."] },
  { id: "fillet", title: "Fillet corner. Click two lines that meet.", steps: ["Drag the radius, or type it."] },
  { id: "construction", title: "Construction. Click a line to toggle it.", steps: ["X toggles the selection."] },
  { id: "use", title: "Use. Click a faint edge to copy it.", steps: ["Or click the face outline."] },
  { id: "select", title: "Select. Click a line or a point.", steps: ["Drag a point to move it.", "Drag empty space to box-select."] },
  { id: "horizontal", title: "Horizontal. Click a line or two points.", steps: ["Selected lines are made horizontal."] },
  { id: "vertical", title: "Vertical. Click a line or two points.", steps: ["Selected lines are made vertical."] },
  { id: "parallel", title: "Parallel. Click two lines.", steps: ["The second line follows the first."] },
  { id: "perpendicular", title: "Perpendicular. Click two lines.", steps: ["The second line turns square to the first."] },
  { id: "tangent", title: "Tangent. Click a line and a circle.", steps: ["Or click two circles or arcs."] },
  { id: "equal", title: "Equal. Click two lines or two circles.", steps: ["They keep the same length or radius."] },
  { id: "concentric", title: "Concentric. Click two circles or arcs.", steps: ["They share a centre."] },
  { id: "fixed", title: "Fixed. Click a point or a line.", steps: ["It stays where it is."] },
  { id: "midpoint", title: "Midpoint. Click a point and a line.", steps: ["The point stays at the middle."] },
  { id: "coincident", title: "Coincident. Click two points.", steps: ["Or a point and a line, circle, or arc."] },
  { id: "distance", title: "Distance. Click two points. Type it.", steps: ["Or a point and a line."] },
  { id: "length", title: "Length. Click a line and type it.", steps: ["The label on the line takes the number."] },
  { id: "radius", title: "Radius. Click a circle or an arc.", steps: ["Type the radius on the label."] },
  { id: "diameter", title: "Diameter. Click a circle or an arc.", steps: ["Type the diameter on the label."] },
  { id: "angle", title: "Angle. Click two lines and type it.", steps: ["The label takes the angle."] },
];

const BY_ID = new Map(STATUS_HINTS.map((hint) => [hint.id, hint]));

export function hintById(id: string): StatusHint | undefined {
  return BY_ID.get(id);
}

/** Drop extra spaces and keep a status line inside the limit. */
export function fitStatus(text: string, limit = HINT_LIMIT): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/** A feature's status title. `detail` is the short value, such as "10 mm · Join". */
export function featureTitle(kind: "extrude" | "revolve" | "loft" | "sweep", detail: string): string {
  const hint = hintById(kind);
  const title = (hint?.title ?? kind).replace("{detail}", detail);
  return fitStatus(title, TITLE_LIMIT);
}

export function hintSteps(id: string): string[] {
  return hintById(id)?.steps ?? [];
}
