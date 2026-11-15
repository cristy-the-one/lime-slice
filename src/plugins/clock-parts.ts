/**
 * --- Clock parts that ship with the app (docs/plan-clock-parts.md). Five plugins over `lime_recipe::horology`, each a
 * whole plugin file (front matter and recipe) kept here as text, so the window, the MCP server and the tests read one
 * copy: a ratchet wheel, the click for a ratchet, a Graham escape wheel, the Graham anchor for an escape wheel, and a
 * cycloidal clock wheel with the pinion it drives. Each makes its own parts with nothing open (`target: new`), refuses
 * with horology's own sentence, and stands its parts in model space where they belong: the wheel's axis on the model
 * origin, and the click (or the anchor, or the pinion) at the pivot (or centre distance) horology gives for that wheel,
 * turned so that it sits in its notch (rests on its pallet, meshes). A part's local origin is its own axis or pivot, so
 * a hinge at [0, 0, 0] about +Z is the right one for every part they make.
 *
 * `source-sha256` is the body's hash (`mcp/clock-parts.test.ts` checks it and the declared parameters against the
 * recipe's own describe run under lust and rustc). Change a body and its hash, raise its version, and keep the old text
 * in no file: a project keeps the code its parts were made with, and History offers "Use vN" for the newer one.
 */
import type { ModelTree, PluginStamp, PluginValue, Vec3 } from "../model-tree.ts";
import { applyPose, type Affine } from "../model-space.ts";
import { readPluginFile } from "../plugin-file.ts";
import { runsOnPath } from "../plugin-step.ts";
import { clickGeometry, clickOutline } from "../ratchet-click.ts";
import CLOCK_RECORD from "./clock-parts.json" with { type: "json" };

export const RATCHET_WHEEL = "clock-ratchet-wheel";
export const RATCHET_CLICK = "clock-ratchet-click";
export const ESCAPE_WHEEL = "clock-escape-wheel";
export const GRAHAM_ANCHOR = "clock-graham-anchor";
export const WHEEL_PINION = "clock-wheel-pinion";

/** The bore shared by every part: a steel pin of horology's sizes, its fit, and how much this printer shrinks a hole. */
const BORE_FNS = String.raw`fn fit_of(name: &str) -> Fit {
    if name == "running" {
        Fit::Running
    } else if name == "sliding" {
        Fit::Sliding
    } else {
        Fit::Press
    }
}

fn pin_mm(name: &str) -> f64 {
    if name == "1" {
        1.0
    } else if name == "1.5" {
        1.5
    } else if name == "2" {
        2.0
    } else if name == "3" {
        3.0
    } else {
        0.0
    }
}

/// A part cut to one outline between z 0 and thick: a box over the outline, then an extrude common with it.
fn plate_of(s: &mut Session, name: &str, reach: [f64; 2], thick: f64, outline: Json) -> Part {
    let part = s.solid_new(ops::cuboid(2.0 * reach[0] + 2.0, 2.0 * reach[1] + 2.0, thick).set("name", name)).unwrap();
    s.apply(&part, Json::obj().set("kind", "extrude").set("op", "common").set("origin", [0.0, 0.0, -1.0]).set("depth", thick + 2.0).set("loops", vec![outline])).unwrap();
    part
}

/// The farthest the points reach from the origin along X and along Y.
fn reach_of(points: &[[f64; 2]]) -> [f64; 2] {
    let mut r: [f64; 2] = [0.0, 0.0];
    for p in points.iter() {
        r[0] = r[0].max(p[0].abs());
        r[1] = r[1].max(p[1].abs());
    }
    r
}

/// The bore through the part's axis at the origin, or 0 when the pin is none. A bore that leaves less than half a
/// millimetre of wall inside radius wall_radius is refused.
fn bore(s: &mut Session, part: &Part, pin: &str, fit: &str, allowance: f64, thick: f64, wall_radius: f64, what: &str) -> f64 {
    let mm = pin_mm(pin);
    if mm == 0.0 {
        return 0.0;
    }
    let d = pin_bore(mm, fit_of(fit), allowance).unwrap();
    if 0.5 * d > wall_radius - 0.5 {
        s.refuse(&format!("A {} mm pin's bore leaves no wall in the {}: choose a smaller pin, or none.", pin, what));
    }
    s.apply(part, ops::hole_through([0.0, 0.0, thick], [0.0, 0.0, -1.0], d)).unwrap();
    d
}

/// Stands a part in model space: at x, y on the model's floor, turned turn_deg about +Z.
fn stand(s: &mut Session, part: &Part, x: f64, y: f64, turn_deg: f64) {
    s.call("model_place", Json::obj().set("object", part.object.as_str()).set("x", x).set("y", y).set("z", 0.0).set("turnZ", turn_deg)).unwrap();
}
`;

const BORE_PARAMS = (pin: string, fit: string) => String.raw`    let thick = s.number("thickness", 3.0).range(0.5, 50.0).step(0.1).unit("mm").label("Thickness").get();
    let pin = s.choice("pin", &["none", "1", "1.5", "2", "3"], "${pin}").label("Arbor pin, mm").help("The steel pin through its axis: 1, 1.5, 2 or 3 mm, or none for no bore.").get();
    let fit = s.choice("fit", &["running", "sliding", "press"], "${fit}").label("Fit on the pin").help("Running turns freely on the pin (H9/d9), sliding slides on by hand (H7/h6), press holds it (H7/p6).").get();
    let allowance = s.number("allowance", 0.2).range(0.0, 1.0).step(0.05).unit("mm").label("Hole allowance").help("How much this printer makes a small hole undersize. A fit coupon measures it.").get();
`;

const RATCHET_PARAMS = (help: string) => String.raw`    let teeth = s.count("teeth", 20).range(6, 200).label("Teeth").help("${help}Saw teeth round the wheel: 6 to 200.").get();
    let tip = s.number("tip", 12.0).range(1.0, 500.0).step(0.1).unit("mm").label("Tip radius").help("${help}From the axis to the tips of the teeth.").get();
    let root = s.number("root", 10.2).range(0.3, 485.0).step(0.1).unit("mm").label("Root radius").help("${help}From the axis to the bottom of a notch: 0.3 to 0.97 of the tip radius.").get();
`;

const ESCAPE_PARAMS = (help: string) => String.raw`    let teeth = s.count("teeth", 30).range(12, 200).label("Teeth").help("${help}The escape wheel's teeth: 12 to 200.").get();
    let tip = s.number("tip", 22.5).range(1.0, 500.0).step(0.1).unit("mm").label("Tip radius").help("${help}From the axis to the tips of the teeth.").get();
    let root = s.number("root", 17.5).range(0.1, 490.0).step(0.1).unit("mm").label("Root radius").help("${help}From the axis to the roots, under the tip radius.").get();
    let lean = s.number("lean", 12.0).range(0.0, 30.0).step(0.5).unit("°").label("Tooth lean").help("${help}How far the teeth lean forward: 0 to 30 degrees.").get();
    let span = s.number("span", 7.5).range(1.5, 50.5).step(1.0).label("Anchor span, teeth").help("How many teeth the anchor's pallets embrace: a whole number and a half, 7.5 on 30 teeth say.").get();
`;

const RATCHET_BODY = String.raw`use lime_recipe::horology::{pin_bore, Fit, Ratchet};
use lime_recipe::{ops, Json, Part, Session};

${BORE_FNS}
fn main() {
    let mut s = Session::start();
${RATCHET_PARAMS("")}${BORE_PARAMS("2", "press")}    let ratchet = Ratchet::new(teeth, tip, root);
    if let Some(why) = ratchet.refusal() {
        s.refuse(&why);
    }
    let outline = ratchet.outline(0.0).unwrap();
    let wheel = plate_of(&mut s, "Ratchet wheel", [tip, tip], thick, outline.to_loop());
    let d = bore(&mut s, &wheel, &pin, &fit, allowance, thick, root, "ratchet wheel");
    stand(&mut s, &wheel, 0.0, 0.0, 0.0);
    s.done_with(&wheel, Json::obj().set("teeth", teeth as f64).set("tip", tip).set("root", root).set("pitchDeg", ratchet.pitch_deg()).set("bore", d));
}
`;

const CLICK_BODY = String.raw`use lime_recipe::horology::{outline_points, pin_bore, Fit, Ratchet};
use lime_recipe::{ops, Json, Part, Session};

${BORE_FNS}
fn main() {
    let mut s = Session::start();
${RATCHET_PARAMS("The ratchet's, as its wheel was made (the defaults are the Ratchet wheel's). ")}    let length = s.number("length", 10.0).range(0.5, 1000.0).step(0.5).unit("mm").label("Click length").help("From the middle of the tooth face it bears on to its pivot.").get();
${BORE_PARAMS("1.5", "running")}    let ratchet = Ratchet::new(teeth, tip, root);
    if let Some(why) = ratchet.refusal() {
        s.refuse(&why);
    }
    let size = ratchet.click_size(length);
    let placed = ratchet.click(0.0, &size);
    if let Err(why) = &placed {
        s.refuse(why);
    }
    let placed = placed.unwrap();
    let points = outline_points(&placed.outline, 3.0);
    let click = plate_of(&mut s, "Click", reach_of(&points), thick, placed.outline.to_loop());
    let d = bore(&mut s, &click, &pin, &fit, allowance, thick, size.hub_radius, "click's hub");
    stand(&mut s, &click, placed.pivot[0], placed.pivot[1], placed.seat_deg);
    s.done_with(&click, Json::obj().set("teeth", teeth as f64).set("tip", tip).set("root", root).set("length", length).set("pivotX", placed.pivot[0]).set("pivotY", placed.pivot[1]).set("seatDeg", placed.seat_deg).set("liftDeg", placed.lift_deg).set("bore", d));
}
`;

const ESCAPE_BODY = String.raw`use lime_recipe::horology::{pin_bore, EscapeWheel, Fit, Graham};
use lime_recipe::{ops, Json, Part, Session};

${BORE_FNS}
fn main() {
    let mut s = Session::start();
${ESCAPE_PARAMS("")}${BORE_PARAMS("2", "press")}    let wheel = EscapeWheel::new(teeth, tip, root, lean);
    if let Some(why) = wheel.refusal() {
        s.refuse(&why);
    }
    // Turned to rest under the anchor of that span: a tooth on the entry pallet's locking face, as the Graham anchor stands.
    let rest = Graham::new(wheel, span).rest_pose();
    let mut phase = 0.0;
    if let Ok(pose) = &rest {
        phase = pose.0;
    } else if let Err(why) = &rest {
        s.log(&format!("No anchor of span {} fits this wheel, so tooth 0 stands on +X: {}", span, why));
    }
    let outline = wheel.outline(phase).unwrap();
    let part = plate_of(&mut s, "Escape wheel", [tip, tip], thick, outline.to_loop());
    let d = bore(&mut s, &part, &pin, &fit, allowance, thick, root, "escape wheel");
    stand(&mut s, &part, 0.0, 0.0, 0.0);
    s.done_with(&part, Json::obj().set("teeth", teeth as f64).set("tip", tip).set("root", root).set("lean", lean).set("phaseDeg", phase).set("bore", d));
}
`;

const ANCHOR_BODY = String.raw`use lime_recipe::horology::{outline_points, pin_bore, EscapeWheel, Fit, Graham};
use lime_recipe::{ops, Json, Part, Session};

${BORE_FNS}
fn main() {
    let mut s = Session::start();
${ESCAPE_PARAMS("The escape wheel's, as it was made (the defaults are the Graham escape wheel's). ")}${BORE_PARAMS("2", "press")}    let wheel = EscapeWheel::new(teeth, tip, root, lean);
    if let Some(why) = wheel.refusal() {
        s.refuse(&why);
    }
    let graham = Graham::new(wheel, span);
    if let Some(why) = graham.refusal() {
        s.refuse(&why);
    }
    let outline = graham.anchor().unwrap();
    let points = outline_points(&outline, 3.0);
    let anchor = plate_of(&mut s, "Graham anchor", reach_of(&points), thick, outline.to_loop());
    let d = bore(&mut s, &anchor, &pin, &fit, allowance, thick, graham.hub_radius, "anchor's hub");
    let rest = graham.rest_pose().unwrap();
    stand(&mut s, &anchor, 0.0, graham.pivot_distance(), rest.1);
    s.done_with(&anchor, Json::obj().set("pivotDistance", graham.pivot_distance()).set("swingDeg", graham.swing_deg()).set("restDeg", rest.1).set("wheelPhaseDeg", rest.0).set("bore", d));
}
`;

const PINION_BODY = String.raw`use lime_recipe::gears::mate_phase;
use lime_recipe::horology::{pin_bore, ClockWheel, Fit, LeafTop};
use lime_recipe::{ops, Json, Part, Session};

${BORE_FNS}
fn main() {
    let mut s = Session::start();
    let teeth = s.count("teeth", 60).range(12, 400).label("Wheel teeth").help("The wheel's teeth: 12 to 400.").get();
    let leaves = s.count("leaves", 8).range(6, 20).label("Pinion leaves").help("The leaves of the pinion it drives: 6 to 20.").get();
    let module = s.number("module", 1.0).range(0.1, 10.0).step(0.05).unit("mm").label("Module").help("Pitch diameter over teeth, the same for the wheel and its pinion.").get();
    let top = s.choice("top", &["standard", "round", "medium", "high"], "standard").label("Leaf top").help("How the leaves are rounded: standard is BS 978-2's choice, high for 6 or 7 leaves, medium for 8 or 9, round for 10 or more.").get();
${BORE_PARAMS("2", "press")}    let wheel = ClockWheel::new(teeth, module, leaves);
    if let Some(why) = wheel.refusal() {
        s.refuse(&why);
    }
    let leaf_top = if top == "round" {
        LeafTop::Round
    } else if top == "medium" {
        LeafTop::Medium
    } else if top == "high" {
        LeafTop::High
    } else if leaves <= 7 {
        LeafTop::High
    } else if leaves <= 9 {
        LeafTop::Medium
    } else {
        LeafTop::Round
    };
    let pinion = wheel.pinion(leaf_top);
    if let Some(why) = pinion.refusal() {
        s.refuse(&why);
    }
    let centre = wheel.centre_distance();
    let phase = mate_phase(0.0, teeth, 0.0, leaves);
    let wheel_part = plate_of(&mut s, "Clock wheel", [wheel.tip_radius(), wheel.tip_radius()], thick, wheel.outline(0.0).unwrap().to_loop());
    let wheel_bore = bore(&mut s, &wheel_part, &pin, &fit, allowance, thick, wheel.root_radius(), "wheel");
    stand(&mut s, &wheel_part, 0.0, 0.0, 0.0);
    let pinion_part = plate_of(&mut s, "Clock pinion", [pinion.tip_radius(), pinion.tip_radius()], thick, pinion.outline(phase).unwrap().to_loop());
    let pinion_bore = bore(&mut s, &pinion_part, &pin, &fit, allowance, thick, pinion.root_radius(), "pinion");
    stand(&mut s, &pinion_part, centre, 0.0, 0.0);
    s.done_with(&wheel_part, Json::obj().set("centreDistance", centre).set("pinionPhaseDeg", phase).set("wheelTip", wheel.tip_radius()).set("pinionTip", pinion.tip_radius()).set("wheelBore", wheel_bore).set("pinionBore", pinion_bore));
}
`;

export interface ShippedSource {
  id: string;
  title: string;
  description: string;
  version: number;
  body: string;
}

/** What `clock-parts.json` records of each: the body's hash and the parameters its describe run declares. */
export type ShippedRecord = Record<string, { sha256: string; params: Record<string, unknown>[] }>;

/** The recipes, before their headers: what `mcp/clock-parts.test.ts` builds and describes. */
export const CLOCK_SOURCES: readonly ShippedSource[] = [
  { id: RATCHET_WHEEL, title: "Ratchet wheel", version: 1, body: RATCHET_BODY, description: "A ratchet wheel of saw teeth from horology, its axis on the model origin and a bore for its arbor. Couple it in Pose: its numbers are read from it." },
  { id: RATCHET_CLICK, title: "Ratchet click", version: 1, body: CLICK_BODY, description: "The click for a ratchet wheel of these numbers, standing at horology's pivot with its nose in a notch. The defaults match Ratchet wheel's." },
  { id: ESCAPE_WHEEL, title: "Graham escape wheel", version: 1, body: ESCAPE_BODY, description: "A Graham escape wheel from horology, its axis on the model origin, turned to rest under the anchor of the span given." },
  { id: GRAHAM_ANCHOR, title: "Graham anchor", version: 1, body: ANCHOR_BODY, description: "The Graham (deadbeat) anchor for an escape wheel of these numbers, at its pivot above the wheel, resting on its entry pallet." },
  { id: WHEEL_PINION, title: "Clock wheel and pinion", version: 1, body: PINION_BODY, description: "A cycloidal clock wheel and the pinion it drives (BS 978-2), as two parts standing in mesh at their centre distance." },
];

/** The recipe API level the clock parts need: `horology` came with 1.14. */
export const CLOCK_API = "1.14";
const RECORD = CLOCK_RECORD as ShippedRecord;

/** A shipped plugin's whole file: the front matter the library writes, then the recipe. */
export function shippedText(src: ShippedSource, record: ShippedRecord = RECORD): string {
  const row = record[src.id];
  return [
    "//! ---",
    `//! plugin: ${src.id}`,
    `//! title: ${src.title}`,
    `//! version: ${src.version}`,
    `//! description: ${src.description}`,
    "//! author: Lime Slice",
    `//! api: ${CLOCK_API}`,
    `//! source-sha256: ${row?.sha256 ?? ""}`,
    "//! created: 2026-11-15",
    "//! target: new",
    `//! params: ${JSON.stringify(row?.params ?? [])}`,
    "//! ---",
    src.body,
  ].join("\n");
}

/** Every plugin that ships with the app, as whole files: the Plugins panel lists them as Built in, MCP finds them by id. */
export const SHIPPED_PLUGINS: readonly string[] = CLOCK_SOURCES.map((src) => shippedText(src));

/** The shipped plugin of this id, as text, or null. */
export function shippedPlugin(id: string): string | null {
  const src = CLOCK_SOURCES.find((row) => row.id === id);
  return src ? shippedText(src) : null;
}

/** The shipped plugin whose body has this hash, as text, or null. */
export function shippedBySha(sha256: string): string | null {
  const src = CLOCK_SOURCES.find((row) => RECORD[row.id]?.sha256 === sha256);
  return src ? shippedText(src) : null;
}

// ---------------------------------------------------------------------------
// Reading a ratchet's numbers from the parts (docs/plan-clock-parts.md, section 4).
// ---------------------------------------------------------------------------

/** A ratchet's teeth, tip radius and root radius: horology's `Ratchet::new(teeth, tip, root)`. */
export interface RatchetNumbers {
  teeth: number;
  tip: number;
  root: number;
}

/** A part a coupling reads: its name, and its Model tree, where the plugin's stamp is. */
export interface StampedPart {
  name: string;
  tree: ModelTree | null | undefined;
}

/** The text of the code a stamp names, by its hash: the project's copy (the shipped text is looked up first). */
export type CodeOf = (sha256: string) => string | null | undefined;

/** What one part's stamp says about its ratchet. */
export interface RatchetStamp {
  numbers: RatchetNumbers;
  stamp: PluginStamp;
  /** The plugin's title, as its code names it. */
  title: string;
  /** Every value the run was built with: the defaults of the code that ran, under the values it was given. */
  values: Record<string, PluginValue>;
}

/** The values of a stamped run: the code's declared defaults, under the values the run was given; null without the code. */
export function stampValues(stamp: PluginStamp, codeOf?: CodeOf): { values: Record<string, PluginValue>; title: string } | null {
  const text = shippedBySha(stamp.sha256) ?? codeOf?.(stamp.sha256) ?? null;
  const file = text ? readPluginFile(text) : null;
  if (!file || file.plugin !== stamp.plugin) return null;
  const values: Record<string, PluginValue> = {};
  for (const param of file.params) if (param.default !== null && param.default !== undefined) values[param.name] = param.default as PluginValue;
  return { values: { ...values, ...stamp.params }, title: file.title };
}

/** The newest Ratchet wheel or Ratchet click run on the part's shown path, read; null when it has none. */
export function ratchetStamp(tree: ModelTree | null | undefined, codeOf?: CodeOf, plugins: readonly string[] = [RATCHET_WHEEL, RATCHET_CLICK]): RatchetStamp | null {
  if (!tree) return null;
  const run = [...runsOnPath(tree)].reverse().find((row) => !!row.stamp && plugins.includes(row.stamp.plugin));
  if (!run?.stamp) return null;
  const read = stampValues(run.stamp, codeOf);
  if (!read) return null;
  const { teeth, tip, root } = read.values;
  if (typeof teeth !== "number" || typeof tip !== "number" || typeof root !== "number") return null;
  return { numbers: { teeth, tip, root }, stamp: run.stamp, title: read.title, values: read.values };
}

const mm = (value: number) => String(Math.round(value * 1000) / 1000);
export const numbersText = (n: RatchetNumbers) => `${n.teeth} teeth, tip ${mm(n.tip)} mm and root ${mm(n.root)} mm`;
const same = (a: RatchetNumbers, b: RatchetNumbers) => a.teeth === b.teeth && Math.abs(a.tip - b.tip) < 1e-9 && Math.abs(a.root - b.root) < 1e-9;

/** Whether a click's stamp is for this wheel: made by Ratchet click with the wheel's numbers. */
export function clickFits(click: RatchetStamp | null, wheel: RatchetNumbers): boolean {
  return !!click && click.stamp.plugin === RATCHET_CLICK && same(click.numbers, wheel);
}

/**
 * A ratchet coupling's numbers read from its parts: the wheel's own stamp (Ratchet wheel), else the click's (Ratchet
 * click, made for its wheel). `said` says where they came from, for the panel's line and the MCP reply. A click made for
 * other numbers than its wheel's is refused in one sentence. Null when neither part carries a stamp that gives them.
 */
export function readRatchet(wheel: StampedPart, click: StampedPart | null, codeOf?: CodeOf): { numbers: RatchetNumbers; said: string; from: "wheel" | "click" } | { reason: string } | null {
  const own = ratchetStamp(wheel.tree, codeOf, [RATCHET_WHEEL]);
  const clicked = click ? ratchetStamp(click.tree, codeOf, [RATCHET_CLICK]) : null;
  if (own && clicked && !same(own.numbers, clicked.numbers)) {
    return { reason: `${click!.name} was made for a ratchet of ${numbersText(clicked.numbers)}, and ${wheel.name} has ${numbersText(own.numbers)}: make the click again with the wheel's numbers.` };
  }
  if (own) return { numbers: own.numbers, from: "wheel", said: `${numbersText(own.numbers)}, read from ${wheel.name} (${own.title} v${own.stamp.version}).` };
  if (clicked) return { numbers: clicked.numbers, from: "click", said: `${numbersText(clicked.numbers)}, read from ${click!.name} (${clicked.title} v${clicked.stamp.version}, made for its wheel).` };
  return null;
}

/**
 * The way a Ratchet wheel runs free on a hinge about `axis` (in the wheel's own frame): horology's wheel runs free
 * clockwise seen from its +Z, so -1 on a hinge about +Z and 1 about -Z. Null for a hinge across the wheel.
 */
export function freeWayOf(axis: readonly number[]): 1 | -1 | null {
  const length = Math.hypot(axis[0] ?? 0, axis[1] ?? 0, axis[2] ?? 0);
  const z = length > 0 ? (axis[2] ?? 0) / length : 0;
  return z > 0.99 ? -1 : z < -0.99 ? 1 : null;
}

/**
 * The middle of a Ratchet click's body in its own frame (its pivot at the origin, as the plugin builds it): the click's
 * hand is read from where its body lies, which the box of a part only tells once the kernel has cut it.
 */
export function clickBodyCentre(click: RatchetStamp): [number, number, number] | null {
  const length = click.values.length, thickness = click.values.thickness;
  if (typeof length !== "number" || typeof thickness !== "number") return null;
  const shape = { ...click.numbers, arm: length };
  const points = clickOutline(shape);
  if (!points) return null;
  const { pivot, midRadius } = clickGeometry(shape);
  // The plugin turns horology's click (nose along +X about its pivot) by the seat angle: the angle of the face's middle
  // seen from the pivot. Undo that turn to read the outline in the part's own frame.
  const seat = Math.atan2(0 - pivot[1], midRadius - pivot[0]);
  const local = points.map(([x, y]) => {
    const dx = x - pivot[0], dy = y - pivot[1];
    return [dx * Math.cos(-seat) - dy * Math.sin(-seat), dx * Math.sin(-seat) + dy * Math.cos(-seat)] as const;
  });
  const xs = local.map((p) => p[0]), ys = local.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, thickness / 2];
}

/** A part of a ratchet coupling as a host has it: its stamp's tree, and where it stands. */
export interface CouplingPart extends StampedPart {
  /** Its pose in model space (the click's: where its body lies). */
  pose?: Affine | undefined;
  /** The axis of its hinge, in its own frame (the wheel's: which way it runs free). */
  hingeAxis?: readonly number[] | undefined;
}

/**
 * What a ratchet coupling takes from its parts' stamps, for the numbers the caller left out: teeth, tip and root (from
 * the wheel, else the click), the way the wheel runs free (as the wheel was cut, on its hinge), and where the click's
 * body lies (from its stamp, so the hand is read from the click's own outline). `said` names where they came from.
 */
export function ratchetFromStamps(wheel: CouplingPart, click: CouplingPart | null, given: Partial<RatchetNumbers> & { free?: 1 | -1 | undefined }, codeOf?: CodeOf): { fill: Partial<RatchetNumbers> & { free?: 1 | -1 }; clickCentre?: Vec3; said: string[] } | { reason: string } {
  const fill: Partial<RatchetNumbers> & { free?: 1 | -1 } = {};
  const said: string[] = [];
  const missing = (["teeth", "tip", "root"] as const).filter((key) => given[key] === undefined);
  const read = click && missing.length ? readRatchet(wheel, click, codeOf) : null;
  if (read && "reason" in read) return read;
  if (read) {
    for (const key of missing) fill[key] = read.numbers[key];
    said.push(missing.length === 3 ? `Teeth, tip and root: ${read.said}` : `${missing.join(", ")}: ${read.said}`);
  }
  const own = ratchetStamp(wheel.tree, codeOf, [RATCHET_WHEEL]);
  if (given.free === undefined && own && wheel.hingeAxis) {
    const free = freeWayOf(wheel.hingeAxis);
    if (free) {
      fill.free = free;
      said.push(`Runs free turning ${free === 1 ? "forward" : "back"} on its hinge, as ${own.title} cuts its teeth.`);
    }
  }
  const clicked = click ? ratchetStamp(click.tree, codeOf, [RATCHET_CLICK]) : null;
  const local = clicked ? clickBodyCentre(clicked) : null;
  return { fill, said, ...(local && click?.pose ? { clickCentre: applyPose(click.pose, local) } : {}) };
}
