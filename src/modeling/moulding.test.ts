/**
 * Moulding checks (src/modeling/moulding.ts). Hand-built sections with known answers, and the moulded default
 * table: the numbers are computed, and the test does not require the default to pass.
 */
import { defaultDraftedSection, junctionDiameter, MOULD_HEIGHT_WALLS, MOULD_JUNCTION_RATIO, MOULD_MIN_DRAFT_DEG, MOULD_ROOT_RATIO, MOULD_SPACING_WALLS, mouldedDefaultRow, mouldedOnly, mouldingLines, mouldingReport, rootWidth, type MouldRib, type MouldSection } from "./moulding.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

type V3 = [number, number, number];
const up: V3 = [0, 0, 1];
const straight = (width: number): MouldSection => ({ profile: "straight", width, rootRadius: 0 });
const rib = (points: V3[], section: MouldSection, height: number, wall: number, normal: V3 = up): MouldRib => ({
  points,
  heights: Array.from({ length: points.length - 1 }, () => height),
  sections: Array.from({ length: points.length - 1 }, () => section),
  normals: points.map(() => normal),
  wallMm: points.map(() => wall),
});

// A straight rib on a slab: the junction circle is wall + width² / (4·wall).
{
  const dia = junctionDiameter(straight(1.2), 6, 2);
  check("a 1.2 mm straight rib on a 2 mm wall has junction diameter 2.18 mm", dia !== null && near(dia, 2 + (1.2 * 1.2) / (4 * 2), 0.002), String(dia));
  check("its root is its width", near(rootWidth(straight(1.2), 6) ?? 0, 1.2));
}

// Rule 1. Equal to 0.6 passes; above it flags.
{
  const pass = mouldingReport([rib([[0, 0, 0], [10, 0, 0]], straight(1.2), 4, 2)]);
  const root = pass.rules.find((row) => row.rule === "root")!;
  check("1.2 mm on a 2 mm wall is ratio 0.6 and passes", near(root.worst ?? 0, 0.6) && root.pass && !pass.flags.some((f) => f.rule === "root"), JSON.stringify(root));
  const flag = mouldingReport([rib([[0, 0, 0], [10, 0, 0]], straight(1.4), 4, 2)]);
  const bad = flag.flags.find((f) => f.rule === "root");
  check("1.4 mm on a 2 mm wall flags root 0.7 over 0.6", bad !== undefined && near(bad.value, 0.7) && bad.threshold === MOULD_ROOT_RATIO && bad.rib === 0 && bad.at.stretch === 0, JSON.stringify(flag.flags));
}

// Rule 2. Equal to 3 passes.
{
  const at = mouldingReport([rib([[0, 0, 0], [10, 0, 0]], straight(1), 6, 2)]);
  check("height 3 × the wall passes", at.rules.find((row) => row.rule === "height")!.pass && !at.flags.some((f) => f.rule === "height"));
  const over = mouldingReport([rib([[0, 0, 0], [10, 0, 0]], straight(1), 6.4, 2)]);
  const flag = over.flags.find((f) => f.rule === "height");
  check("height 3.2 × the wall flags", flag !== undefined && near(flag.value, 3.2) && flag.threshold === MOULD_HEIGHT_WALLS, JSON.stringify(flag));
}

// Rule 3. 0.3° flags; the product's 1° passes; a flank facing against the pull is an undercut.
{
  const shallow = mouldingReport([rib([[0, 0, 0], [10, 0, 0]], { profile: "drafted", width: 1.2, draftDeg: 0.3, rootRadius: 0 }, 4, 2)]);
  const draft = shallow.flags.find((f) => f.rule === "draft");
  check("0.3° draft flags under 0.5°", draft !== undefined && near(draft.value, 0.3, 1e-6) && draft.threshold === MOULD_MIN_DRAFT_DEG, JSON.stringify(draft));
  const product = mouldingReport([rib([[0, 0, 0], [10, 0, 0]], defaultDraftedSection(1.2, 4), 4, 2)]);
  check("1° draft passes 0.5°", product.rules.find((row) => row.rule === "draft")!.pass && !product.flags.some((f) => f.rule === "draft" || f.rule === "undercut"));
  const under = mouldingReport([rib([[0, 0, 0], [10, 0, 0]], defaultDraftedSection(1.2, 4), 4, 2)], [0, 0, -1]);
  const cut = under.flags.find((f) => f.rule === "undercut");
  check("a pull against the wall flags an undercut and fails draft", cut !== undefined && cut.value < 0 && cut.threshold === 0 && under.rules.find((row) => row.rule === "draft")!.pass === false, JSON.stringify(cut));
}

// Rule 4. A 90° crossing holds a larger circle than one rib.
{
  const alone = mouldingReport([rib([[-20, 0, 0], [20, 0, 0]], straight(1.2), 6, 2)]);
  const cross = mouldingReport([
    rib([[-20, 0, 0], [20, 0, 0]], straight(1.2), 6, 2),
    rib([[0, -20, 0], [0, 20, 0]], straight(1.2), 6, 2),
  ]);
  const one = alone.rules.find((row) => row.rule === "junction")!.worst ?? 0;
  const two = cross.rules.find((row) => row.rule === "junction")!.worst ?? 0;
  // Apparent width √2 × 1.2 on a 2 mm wall: ratio 1 + (1.2·√2 / 2)² / 4.
  const expect = 1 + ((1.2 * Math.SQRT2) / 2) ** 2 / 4;
  check("one straight rib's junction ratio is 1.09", near(one, 1.09, 0.002), String(one));
  check("a 90° crossing is the wider circle, ratio about 1.180", two > one + 0.05 && near(two, expect, 0.02), `alone ${one}, crossing ${two}, expected ${expect}`);
  check("that crossing stays under 1.2, so it is reported in the worst and not flagged", two <= MOULD_JUNCTION_RATIO && !cross.flags.some((f) => f.rule === "junction"), String(two));
}

// Rule 5. The clear gap, not the centre distance.
{
  const close = mouldingReport([
    rib([[0, 0, 0], [20, 0, 0]], straight(1.2), 4, 2),
    rib([[0, 3, 0], [20, 3, 0]], straight(1.2), 4, 2),
  ]);
  const gap = close.flags.find((f) => f.rule === "spacing");
  // Centre distance 3, roots 1.2, clear gap 1.8, over a 2 mm wall: 0.9, under 2.
  check("parallel ribs 3 mm apart on a 2 mm wall flag gap 0.9 × the wall", gap !== undefined && near(gap.value, 0.9) && gap.threshold === MOULD_SPACING_WALLS && gap.at.meets === 1, JSON.stringify(gap));
  const wide = mouldingReport([
    rib([[0, 0, 0], [20, 0, 0]], straight(1.2), 4, 2),
    rib([[0, 10, 0], [20, 10, 0]], straight(1.2), 4, 2),
  ]);
  check("a clear gap of 4.4 × the wall passes", wide.rules.find((row) => row.rule === "spacing")!.pass && !wide.flags.some((f) => f.rule === "spacing"), JSON.stringify(wide.rules));
}

// Filament and resin do not gain the key.
{
  const report = mouldingReport([]);
  const filament: Record<string, unknown> = { ribs: [] };
  const resin: Record<string, unknown> = { ribs: [] };
  const moulded: Record<string, unknown> = { ribs: [] };
  mouldedOnly("filament", filament, report);
  mouldedOnly("resin", resin, report);
  mouldedOnly("moulded", moulded, report);
  check("filament has no moulding key", !("moulding" in filament));
  check("resin has no moulding key", !("moulding" in resin));
  check("moulded gains the report", moulded.moulding === report);
  check("no ribs: one pass line naming five rules", mouldingLines(report).join(" ") === "Moulding checks pass (5 rules)");
}

// The question to answer first. Printed, and only asserted to be computed.
{
  console.log("moulded default table: width 0.6 × wall at half height, draft 1°, root half the top at this height");
  console.log("wall  height  width  root  root/wall  over 0.6  junction/wall  over 1.2");
  const rows = [2, 3].flatMap((wall) => [1, 2, 3].map((n) => mouldedDefaultRow(wall, n)));
  for (const row of rows) {
    const overRoot = row.rootRatio === null ? "" : (row.rootRatio - MOULD_ROOT_RATIO).toFixed(4);
    const overJoint = row.junctionRatio === null ? "" : (row.junctionRatio - MOULD_JUNCTION_RATIO).toFixed(4);
    console.log([row.wall, row.height, row.width.toFixed(4), row.root === null ? "refused" : row.root.toFixed(4), row.rootRatio === null ? "refused" : row.rootRatio.toFixed(4), overRoot, row.junctionRatio === null ? "refused" : row.junctionRatio.toFixed(4), overJoint].join("  "));
  }
  check("the six default rows are computed", rows.length === 6 && rows.every((row) => row.root !== null && row.root > 0 && row.rootRatio !== null && Number.isFinite(row.rootRatio) && row.junctionRatio !== null && Number.isFinite(row.junctionRatio)));
  console.log("same default, fillet sized once at 3 × wall (what the planner stores) and measured at the shorter height");
  console.log("wall  height  filletAt  root  root/wall  junction/wall");
  const planned = [2, 3].flatMap((wall) => [1, 2, 3].map((n) => mouldedDefaultRow(wall, n, 3)));
  for (const row of planned) {
    console.log([row.wall, row.height, row.filletAt, row.root === null ? "refused" : row.root.toFixed(4), row.rootRatio === null ? "refused" : row.rootRatio.toFixed(4), row.junctionRatio === null ? "refused" : row.junctionRatio.toFixed(4)].join("  "));
  }
  check("the planner-fillet rows are computed", planned.length === 6 && planned.every((row) => row.rootRatio !== null && Number.isFinite(row.rootRatio) && row.junctionRatio !== null && Number.isFinite(row.junctionRatio)));
}

// A thinner drafted rib than the default: the panel's all-pass case. Not a change to the default.
{
  const section = defaultDraftedSection(0.55, 6);
  const mk = (points: V3[]): MouldRib => ({
    points,
    heights: [6],
    sections: [section],
    normals: points.map(() => up),
    wallMm: points.map(() => 2),
  });
  const report = mouldingReport([mk([[-40, 0, 0], [40, 0, 0]]), mk([[0, -30, 0], [0, 30, 0]]), mk([[-40, 12.7, 0], [40, 12.7, 0]])]);
  check("0.55 mm drafted, 6 mm tall on a 2 mm wall, passes all five rules with a crossing and a neighbour", report.rules.every((row) => row.pass) && report.flags.length === 0, JSON.stringify(report));
  check("the pass line names the five rules", mouldingLines(report)[0] === "Moulding checks pass (5 rules)");
}

if (failed) {
  console.error(`moulding: ${failed} failed`);
  process.exit(1);
}
console.log("moulding: ok");
