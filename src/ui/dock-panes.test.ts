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

got = moveLine([{ id: "tool", height: 348, min: 120, max: 348 }, { id: "history", height: 400, min: 90, max: 80 }], "tool", "history", -60);
check("a pane stretched past its content (the one that fills the dock) still takes height: the card above shrinks", same(got, { tool: 288, history: 460 }), JSON.stringify(got));

got = moveLine([{ id: "tool", height: 348, min: 120, max: 348 }, { id: "history", height: 400, min: 90, max: 80 }], "tool", "history", 60);
check("and the card above still grows no taller than its content", same(got, { tool: 348, history: 400 }), JSON.stringify(got));

got = moveLine([{ id: "tool", height: 348, min: 135, max: 348 }, { id: "history", height: 82, min: 82, max: 82 }], "tool", "history", -60, 300);
check("over a short History, the card above still shrinks: the height it gives stays free", same(got, { tool: 288, history: 82 }), JSON.stringify(got));

got = moveLine([{ id: "tool", height: 200, min: 135, max: 348 }, { id: "history", height: 82, min: 82, max: 82 }], "tool", "history", 60, 100);
check("down, the card grows into the free height before it takes any from below", same(got, { tool: 260, history: 82 }), JSON.stringify(got));

got = moveLine([{ id: "tool", height: 200, min: 135, max: 348 }, { id: "history", height: 300, min: 90, max: 300 }], "tool", "history", 60, 20);
check("past the free height, the pane below gives the rest", same(got, { tool: 260, history: 260 }), JSON.stringify(got));

got = moveLine(panes, "params", "tool", 30);
check("a pane that is not open leaves every height as it is", same(got, { history: 120, params: 100, stress: 500 }), JSON.stringify(got));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("dock-panes: ok");
