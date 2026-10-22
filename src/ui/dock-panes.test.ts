/**
 * A line between two dock panes moves height from one to the other, within each one's least height and its content.
 */
import { moveLine, type PaneHeight } from "./dock-panes.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const panes: PaneHeight[] = [
  { id: "history", height: 120, min: 90, max: 300 },
  { id: "params", height: 100, min: 90, max: 140 },
  { id: "stress", height: 500, min: 90, max: 800 },
];
const same = (got: Record<string, number>, want: Record<string, number>) => JSON.stringify(got) === JSON.stringify(want);

let got = moveLine(panes, "params", "stress", 30);
check("down gives the lower pane's height to the upper one", same(got, { history: 120, params: 130, stress: 470 }), JSON.stringify(got));

got = moveLine(panes, "params", "stress", 200);
check("the upper pane grows no further than its content", same(got, { history: 120, params: 140, stress: 460 }), JSON.stringify(got));

got = moveLine(panes, "params", "stress", -50);
check("up stops at the upper pane's least height", same(got, { history: 120, params: 90, stress: 510 }), JSON.stringify(got));

got = moveLine(panes, "history", "stress", 1e6);
check("a line can pass a folded pane to the next open one", same(got, { history: 300, params: 100, stress: 320 }), JSON.stringify(got));

got = moveLine([{ id: "history", height: 120, min: 90, max: 300 }, { id: "stress", height: 100, min: 90, max: 800 }], "history", "stress", 50);
check("down stops at the lower pane's least height", same(got, { history: 130, stress: 90 }), JSON.stringify(got));

got = moveLine([{ id: "params", height: 60, min: 90, max: 140 }, { id: "stress", height: 500, min: 90, max: 800 }], "params", "stress", -20);
check("a pane already squeezed under its least height does not jump", same(got, { params: 60, stress: 500 }), JSON.stringify(got));

got = moveLine(panes, "params", "tool", 30);
check("a pane that is not open leaves every height as it is", same(got, { history: 120, params: 100, stress: 500 }), JSON.stringify(got));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("dock-panes: ok");
