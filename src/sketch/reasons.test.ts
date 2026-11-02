/**
 * --- P1 and P3. Every card button has a purpose, every reason ends with what to do, and the marks sit where the
 * problem is. ---
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { addArc, addCircle, addLine, emptySketch, type SketchData } from "./model.ts";
import { axisCrossings, blockedTip, EDIT_BUTTONS, endsWithAction, MAKE_BUTTONS, noShapeReason, openEnds, PURPOSE, REASON, sharpCorners } from "./reasons.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

// P1: one purpose per card button, and no purpose for a button the card doesn't have.
const buttons = [...EDIT_BUTTONS, ...MAKE_BUTTONS];
eq("every card button has a purpose, and only those", Object.keys(PURPOSE).sort(), [...buttons].sort());
for (const id of buttons) {
  const line = PURPOSE[id];
  check(`${id} purpose is one sentence or two`, line.length > 10 && line.length <= 90 && line.endsWith(".") && !line.includes("\n"));
  check(`${id} purpose says what it is for, not a key`, !/\([A-Z]\)/.test(line) && !/^Click /.test(line));
}
check("the Construction tip doesn't depend on the button's name", !/construction/i.test(PURPOSE.construction));
check("the Use tip doesn't depend on the button's name", !/\buse\b/i.test(PURPOSE.use));
eq("an idle tip is the purpose", blockedTip("Spin a shape (V)", ""), "Spin a shape (V)");
eq("a greyed tip keeps the purpose and adds the reason", blockedTip("Spin a shape (V)", REASON.pickRevolve), `Spin a shape (V)\n${REASON.pickRevolve}`);

// R1: the check itself.
check("an action ending passes", endsWithAction("Your lines don't close. Drag one end onto the other."));
check("a statement ending fails", !endsWithAction("Pick a line. A sweep that follows the corner is not available yet."));
check("a bare statement fails", !endsWithAction("The loft has no volume: its sections lie in one plane."));

for (const [name, text] of Object.entries(REASON)) check(`REASON.${name} ends with an action: ${text}`, endsWithAction(text));

// R1 over the source: every refusal constant and every `error:` sentence in src/sketch, and the card's notes.
const here = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(here)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => join(here, name));
sources.push(join(here, "..", "app", "sketch.ts"));
const patterns = [
  /export const [A-Z_]*(?:REFUSAL|CORNER|MEET) = (["`])((?:\\.|(?!\1)[^\\])*)\1/g,
  /\berror: (["`])((?:\\.|(?!\1)[^\\])*)\1/g,
  /\bnote: (["`])((?:\\.|(?!\1)[^\\])+)\1/g,
];
let seen = 0;
for (const file of sources) {
  const text = readFileSync(file, "utf8");
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      seen += 1;
      const sentence = match[2]!;
      check(`${file.split(/[\\/]/).slice(-2).join("/")} ends with an action: ${sentence}`, endsWithAction(sentence));
    }
  }
}
check("the source scan finds the reasons", seen > 40);

// R2: open ends.
function polyline(points: [number, number][]): SketchData {
  let sketch = emptySketch();
  for (let i = 1; i < points.length; i += 1) sketch = addLine(sketch, points[i - 1]!, points[i]!).sketch;
  return sketch;
}
const open = polyline([[0, 0], [10, 0], [10, 10], [0, 10], [0, 1]]);
eq("a nearly closed square has its two ends open", openEnds(open), [[0, 0], [0, 1]]);
eq("the reason for it names the red ends", noShapeReason(open), REASON.openEnds);
const closed = polyline([[0, 0], [10, 0], [10, 10], [0, 0]]);
eq("a closed triangle has no open ends", openEnds(closed), []);
const tee = addLine(polyline([[0, 0], [10, 0]]), [5, 0], [5, 5]).sketch;
eq("an end on another line is not open", openEnds(tee), [[0, 0], [10, 0], [5, 5]]);
eq("a circle has no ends", openEnds(addCircle(emptySketch(), [0, 0], 5).sketch), []);
const arc = addArc(emptySketch(), [0, 0], [5, 5], [10, 0]).sketch;
eq("an arc has two ends", openEnds(arc).length, 2);
eq("nothing drawn says to draw", noShapeReason(emptySketch()), REASON.empty);
const helper = addLine(emptySketch(), [0, 0], [10, 0], true).sketch;
eq("only helper lines says so", noShapeReason(helper), REASON.onlyHelpers);

// R2: sharp corners on a route, by the sweep's own 25° rule.
eq("an L route has one sharp corner", sharpCorners([[0, 0, 0], [10, 0, 0], [10, 10, 0]]), [[10, 0, 0]]);
eq("a gentle bend has none", sharpCorners([[0, 0, 0], [10, 0, 0], [20, 2, 0]]), []);
eq("an unchecked point is skipped", sharpCorners([[0, 0, 0], [10, 0, 0], [10, 10, 0]], [true, false, true]), []);

// R2: where a shape crosses the revolve axis.
const box: [number, number][] = [[-5, 0], [5, 0], [5, 10], [-5, 10]];
eq("a box across the Y axis crosses it twice", axisCrossings(box, { origin: [0, 0], dir: [0, 1], kind: "v" } as never), [[0, 0], [0, 10]]);
eq("a box beside the axis doesn't cross it", axisCrossings(box.map(([x, y]) => [x + 6, y] as [number, number]), { origin: [0, 0], dir: [0, 1], kind: "v" } as never), []);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("reasons ok");
