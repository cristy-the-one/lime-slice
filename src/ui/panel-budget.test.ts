import { dockBudget, dockDefaults, dockMode, DRAWER_PX, dragMax, fitDocks, LEFT_MIN, RAIL_PX, resultsOpenByDefault, stageWidth, type DockWish } from "./panel-budget.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq(name: string, actual: number, expected: number): void {
  check(name, actual === expected, `got ${actual}, expected ${expected}`);
}

function fit(width: number, extra: Partial<DockWish> = {}) {
  const out = fitDocks({ width, leftOpen: true, rightOpen: false, leftDesired: null, rightDesired: null, last: "left", ...extra });
  if (!out) throw new Error(`${width} is not a desktop width`);
  return out;
}

for (const width of [1280, 1366, 1440, 1600, 1920, 2560, 3440]) {
  for (const [leftOpen, rightOpen] of [[true, false], [false, true], [true, true]] as const) {
    for (const last of ["left", "right"] as const) {
      const f = fit(width, { leftOpen, rightOpen, last });
      const stage = stageWidth(width, f);
      check(`${width} ${leftOpen}/${rightOpen} ${last}: stage is at least 70%`, stage / width >= 0.7, `stage ${stage}`);
      if (f.left) check(`${width}: settings stay usable`, f.left >= LEFT_MIN, `left ${f.left}`);
    }
  }
}

eq("1366 opens settings at 288", fit(1366).left, 288);
eq("1440 opens settings at 288", fit(1440).left, 288);
eq("1920 opens settings at 320", fit(1920).left, 320);
eq("results stay closed by default", fit(1440).right, 0);

const laptop = fit(1440, { rightOpen: true, last: "right" });
eq("1440: results opened last keep 300", laptop.right, 300);
eq("1440: settings fold when both cannot fit", laptop.left, 0);
const laptopLeft = fit(1440, { rightOpen: true, last: "left" });
eq("1440: settings opened last stay", laptopLeft.left, 288);
eq("1440: results fold when settings were opened last", laptopLeft.right, 0);

const wide = fit(1920, { rightOpen: true, last: "right" });
eq("1920: results keep 280", wide.right, 280);
eq("1920: settings yield to the leftover", wide.left, (dockBudget(1920) ?? 0) - 280);
check("1920: both docks fit", wide.left >= LEFT_MIN);

eq("a lone dragged dock is capped at the budget", fit(1280, { leftDesired: 480 }).left, dockBudget(1280) ?? 0);
eq("the budget leaves the rail its column", (dockBudget(1440) ?? 0) + RAIL_PX, Math.floor(1440 * 0.3));
check("1200 is not a desktop budget", fitDocks({ width: 1200, leftOpen: true, rightOpen: true, leftDesired: null, rightDesired: null, last: "left" }) === null);
eq("1600 picks the wider settings default", dockDefaults(1600).left, 320);
check("results never open by themselves below 2400", !resultsOpenByDefault(1920) && !resultsOpenByDefault(2399));
check("from 2400 both docks open", resultsOpenByDefault(2400) && resultsOpenByDefault(3440));

const big = fit(2560, { rightOpen: true });
eq("2560: settings 360", big.left, 360);
eq("2560: results 340", big.right, 340);
const ultra = fit(3440, { rightOpen: true });
eq("3440: settings take 600 for two columns", ultra.left, 600);
eq("3440: results 340", ultra.right, 340);
const from = fit(3000, { rightOpen: true });
eq("3000: settings keep 600 for two columns", from.left, 600);
check("3000: results give way, above their floor", from.right === (dockBudget(3000) ?? 0) - 600 && from.right >= 240, JSON.stringify(from));
const edge = fit(2400, { rightOpen: true });
check("2400 keeps both docks, settings yielding a little", edge.right === 340 && edge.left === (dockBudget(2400) ?? 0) - 340, JSON.stringify(edge));

check("961 to 1200 are drawers", dockMode(961) === "drawer" && dockMode(1200) === "drawer");
check("960 and under stack", dockMode(960) === "narrow");
check("1201 docks", dockMode(1201) === "dock");
eq("a drawer is 320 wide", DRAWER_PX, 320);

eq("a settings drag stops where results begin", dragMax("left", 1920, 280), (dockBudget(1920) ?? 0) - 280);
eq("a results drag leaves settings their floor", dragMax("right", 1920, 248), (dockBudget(1920) ?? 0) - LEFT_MIN);
eq("a lone drag may take the budget", dragMax("left", 1440, 0), dockBudget(1440) ?? 0);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("panel budget: 70% stage on 1280–3440, last-opened dock wins");
