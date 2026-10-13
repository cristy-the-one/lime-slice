import { allocatePanels, panelBudget, stageWidth, LEFT_DEFAULT, LEFT_MIN, RIGHT_DEFAULT, RIGHT_FLOOR } from "./panel-budget.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq(name: string, actual: number, expected: number): void {
  check(name, actual === expected, `got ${actual}, expected ${expected}`);
}

function desktop(width: number, extra: Partial<Parameters<typeof allocatePanels>[0]> = {}) {
  return allocatePanels({
    budget: panelBudget(width),
    leftCollapsed: false,
    rightCollapsed: false,
    leftDesired: LEFT_DEFAULT,
    rightDesired: RIGHT_DEFAULT,
    ...extra,
  });
}

for (const width of [1280, 1440, 1600, 1920]) {
  const fit = desktop(width);
  const stage = stageWidth(width, fit);
  check(`${width}: both panels dock`, fit.hud === false, JSON.stringify(fit));
  check(`${width}: stage is at least 70%`, stage / width >= 0.7, `stage ${stage}`);
  check(`${width}: settings stay usable`, fit.left >= LEFT_MIN, `left ${fit.left}`);
  check(`${width}: results stay above the floor`, fit.right >= RIGHT_FLOOR, `right ${fit.right}`);
}

const wide = desktop(1920);
eq("1920 keeps the 240px results rail", wide.right, RIGHT_DEFAULT);
check("1920 only trims settings", wide.left < LEFT_DEFAULT && wide.left >= LEFT_MIN, `left ${wide.left}`);

const laptop = desktop(1440);
eq("1440 keeps settings at the floor", laptop.left, LEFT_MIN);
check("1440 slims the results rail to the leftover", laptop.right < RIGHT_DEFAULT && laptop.right > RIGHT_FLOOR, `right ${laptop.right}`);

const folded = desktop(1440, { rightCollapsed: true });
eq("a folded results panel leaves settings at 300", folded.left, LEFT_DEFAULT);
eq("a folded results panel is the collapsed column", folded.right, 28);
check("folded results do not float", folded.hud === false);

const narrow = allocatePanels({
  budget: panelBudget(1100),
  leftCollapsed: false,
  rightCollapsed: false,
  leftDesired: 480,
  rightDesired: 560,
});
eq("a narrow window does not budget the panels", narrow.left, 480);
eq("a narrow window keeps a wide results panel", narrow.right, 560);
check("1100 is not a desktop budget", panelBudget(1100) === null);

const hud = allocatePanels({
  budget: 200,
  leftCollapsed: false,
  rightCollapsed: false,
  leftDesired: LEFT_DEFAULT,
  rightDesired: RIGHT_DEFAULT,
});
check("floors that overflow float the results panel", hud.hud === true, JSON.stringify(hud));
eq("a floating results panel takes no column", hud.right, 0);
check("the settings panel still fits the budget", hud.left <= 200, `left ${hud.left}`);

const opened = desktop(1600);
eq("1600 keeps a 240px results rail", opened.right, 240);
eq("1600 slims settings to the leftover", opened.left, 200);

const dragged = desktop(1440, { keep: "left", leftDesired: 400 });
eq("dragging settings wider slims the results rail to the floor", dragged.right, RIGHT_FLOOR);
check("dragging settings wider keeps the leftover", dragged.left + dragged.right <= (panelBudget(1440) ?? 0), JSON.stringify(dragged));
check("a settings drag is not folded back to the floor", dragged.left > LEFT_MIN, `left ${dragged.left}`);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("panel budget: 70% stage on 1280–1920");
