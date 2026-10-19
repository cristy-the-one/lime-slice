import { featureRows, featureTableMarkup, legendMarkup } from "./legend.ts";

let failed = 0;

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${a}, expected ${e}`);
}

const rows = featureRows({
  kinds: ["outer", "thin-wall", "gap-fill", "travel"],
  estimate: {
    seconds: 40,
    byFeature: [
      { kind: "outer", seconds: 10, filamentMm: 400 },
      { kind: "thin-wall", seconds: 15, filamentMm: 100 },
      { kind: "gap-fill", seconds: 8, filamentMm: 50 },
      { kind: "skirt", seconds: 3, filamentMm: 20 },
      { kind: "travel", seconds: 4, filamentMm: 0 },
    ],
  },
  hidden: new Set(["gap-fill"]),
  showTravel: false,
});

eq("every drawn or timed kind, in label order", rows.map((row) => row.label), ["Gap fill", "Outer wall", "Skirt", "Thin wall", "Travel"]);
eq("thin wall and gap fill keep their own time", rows.filter((row) => row.kind === "thin-wall" || row.kind === "gap-fill").map((row) => row.seconds), [8, 15]);
eq("share of the whole print", rows.find((row) => row.kind === "outer")?.sharePct, 25);
eq("a hidden kind and travel read unchecked", rows.filter((row) => !row.shown).map((row) => row.kind), ["gap-fill", "travel"]);

const legend = legendMarkup(rows, false);
eq("the flyout has a checkbox per drawn kind", (legend.match(/type="checkbox"/g) ?? []).length, 4);
eq("an undrawn kind is not in the flyout", legend.includes("Skirt"), false);
const table = featureTableMarkup(rows, (mm) => mm / 100);
eq("the results table has the same checkboxes", (table.match(/data-kind="/g) ?? []).length, 4);
eq("and times the undrawn kind too", table.includes("Skirt"), true);
eq("the results show the filament per kind", table.includes("4.00 g"), true);

const untimed = featureRows({ kinds: ["support"], hidden: new Set(), showTravel: true });
eq("a kind without an estimate still gets a flyout toggle", untimed.map((row) => [row.kind, row.seconds]), [["support", null]]);
eq("and stays out of the results table", featureTableMarkup(untimed, () => 0), "");

if (failed) throw new Error(`${failed} legend checks failed`);
console.log("legend: one feature list for the flyout and the results");
