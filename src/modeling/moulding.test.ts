/**
 * Moulding checks (src/modeling/moulding.ts). Hand-built sections with known answers, and the moulded default
 * table: the numbers are computed, and the test does not require the default to pass.
 */
import { baseWidth, builtRootRadius, defaultDraftedSection, junctionDiameter, MOULD_HEIGHT_WALLS, MOULD_JUNCTION_RATIO, MOULD_MIN_DRAFT_DEG, MOULD_ROOT_RADIUS_MAX, MOULD_ROOT_RADIUS_MIN, MOULD_ROOT_RATIO, MOULD_SPACING_WALLS, mouldedDefaultRow, mouldedOnly, mouldingLines, mouldingReport, rootWidth, type MouldRib, type MouldSection } from "./moulding.ts";

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
  check("its foot is its width", near(rootWidth(straight(1.2), 6) ?? 0, 1.2));
  check("its base, with no fillet, is its width", near(baseWidth(straight(1.2), 6) ?? 0, 1.2));
  check("a straight rib's root radius is 0", near(builtRootRadius(straight(1.2), 6) ?? -1, 0));
}

// Rule 1. The base, fillet left out. Equal to 0.6 passes; above it flags.
{
  const pass = mouldingReport([rib([[0, 0, 0], [10, 0, 0]], straight(1.2), 4, 2)]);
  const base = pass.rules.find((row) => row.rule === "base")!;
  check("1.2 mm on a 2 mm wall is base ratio 0.6 and passes", near(base.worst ?? 0, 0.6) && base.pass && !pass.flags.some((f) => f.rule === "base"), JSON.stringify(base));
  const flag = mouldingReport([rib([[0, 0, 0], [10, 0, 0]], straight(1.4), 4, 2)]);
  const bad = flag.flags.find((f) => f.rule === "base");
  check("1.4 mm on a 2 mm wall flags base 0.7 over 0.6", bad !== undefined && near(bad.value, 0.7) && bad.threshold === MOULD_ROOT_RATIO && bad.rib === 0 && bad.at.stretch === 0, JSON.stringify(flag.flags));
}

// Root radius over the wall. Outside 0.25–0.5 flags; the ends of the band pass.
{
  const none = mouldingReport([rib([[0, 0, 0], [10, 0, 0]], straight(1.2), 4, 2)]);
  const small = none.flags.find((f) => f.rule === "radius");
  check("no fillet flags root radius 0 under 0.25", small !== undefined && near(small.value, 0) && small.threshold === MOULD_ROOT_RADIUS_MIN, JSON.stringify(small));
  const low = mouldingReport([rib([[0, 0, 0], [10, 0, 0]], { profile: "drafted", width: 2, draftDeg: 1, rootRadius: 0.5 }, 4, 2)]);
  const high = mouldingReport([rib([[0, 0, 0], [10, 0, 0]], { profile: "drafted", width: 2, draftDeg: 1, rootRadius: 1 }, 4, 2)]);
  check("a root of 0.25 × the wall passes", low.rules.find((row) => row.rule === "radius")!.pass && !low.flags.some((f) => f.rule === "radius"), JSON.stringify(low.rules));
  check("a root of 0.5 × the wall passes", high.rules.find((row) => row.rule === "radius")!.pass && !high.flags.some((f) => f.rule === "radius"));
  const big = mouldingReport([rib([[0, 0, 0], [10, 0, 0]], { profile: "drafted", width: 3, draftDeg: 1, rootRadius: 1.2 }, 4, 2)]);
  const over = big.flags.find((f) => f.rule === "radius");
  check("a root of 0.6 × the wall flags over 0.5", over !== undefined && near(over.value, 0.6) && over.threshold === MOULD_ROOT_RADIUS_MAX, JSON.stringify(over));
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

// A folded wall: a floor rib and a level rib along a side wall (the side wall faces +X). Without a pull each is read along its own
// wall and both pass draft, so the report says that one mould pull was not checked. With pull +Z the side rib's flank
// faces against it, an undercut, and there is nothing to say.
{
  const section = defaultDraftedSection(1.2, 4);
  const box = [rib([[0, 0, 0], [10, 0, 0]], section, 4, 2), rib([[20, 0, 5], [20, 10, 5]], section, 4, 2, [1, 0, 0])];
  const unfolded = mouldingReport(box);
  check("an unfolded wall's report has no notes, as before", unfolded.notes === undefined && !("notes" in unfolded), JSON.stringify(unfolded.notes));
  const folded = mouldingReport(box, null, { folded: true });
  check("a folded wall with no pull passes draft rib by rib", folded.rules.find((row) => row.rule === "draft")!.pass, JSON.stringify(folded.rules));
  check("and says in one note that one mould pull was not checked", folded.notes?.length === 1 && folded.notes[0]!.includes("no pull was given") && folded.notes[0]!.includes("undercuts"), JSON.stringify(folded.notes));
  const lines = mouldingLines(folded);
  check("the panel's list leads with that note, then the flags as before", lines[0] === folded.notes![0] && JSON.stringify(lines.slice(1)) === JSON.stringify(mouldingLines(unfolded)), JSON.stringify(lines));
  const pulled = mouldingReport(box, [0, 0, 1], { folded: true });
  check("with a pull the side rib is an undercut and no note is needed", pulled.notes === undefined && pulled.flags.some((f) => f.rule === "undercut" && f.rib === 1), JSON.stringify(pulled.flags));
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
  check("no ribs: one pass line naming six rules", mouldingLines(report).join(" ") === "Moulding checks pass (6 rules)");
}

// The question to answer first. Printed, and only asserted to be computed.
{
  console.log("moulded default table: base is the flanks at the wall, fillet left out; radius is the root; junction is the circle");
  console.log("wall  height  width  base  base/wall  over 0.6  radius  radius/wall  junction/wall  over 1.2");
  const rows = [2, 3].flatMap((wall) => [1, 2, 3].map((n) => mouldedDefaultRow(wall, n)));
  for (const row of rows) {
    const overBase = row.baseRatio === null ? "" : (row.baseRatio - MOULD_ROOT_RATIO).toFixed(4);
    const overJoint = row.junctionRatio === null ? "" : (row.junctionRatio - MOULD_JUNCTION_RATIO).toFixed(4);
    console.log([row.wall, row.height, row.width.toFixed(4), row.base === null ? "refused" : row.base.toFixed(4), row.baseRatio === null ? "refused" : row.baseRatio.toFixed(4), overBase, row.radius === null ? "refused" : row.radius.toFixed(4), row.radiusRatio === null ? "refused" : row.radiusRatio.toFixed(4), row.junctionRatio === null ? "refused" : row.junctionRatio.toFixed(4), overJoint].join("  "));
  }
  // The measured ratios, to four decimals. This locks the measurement; it does not ask the default to pass.
  const measured: [number, number, number, number, number][] = [
    [2, 2, 0.6175, 0.2913, 1.2332],
    [2, 4, 0.6349, 0.2825, 1.2358],
    [2, 6, 0.6524, 0.2738, 1.2381],
    [3, 3, 0.6175, 0.2913, 1.2244],
    [3, 6, 0.6349, 0.2825, 1.2272],
    [3, 9, 0.6524, 0.2738, 1.2341],
  ];
  check(
    "the six default rows match the measured base, radius and junction ratios",
    rows.length === 6 && rows.every((row, i) => {
      const want = measured[i]!;
      return row.wall === want[0] && row.height === want[1] && row.baseRatio !== null && near(row.baseRatio, want[2], 5e-5) && row.radiusRatio !== null && near(row.radiusRatio, want[3], 5e-5) && row.junctionRatio !== null && near(row.junctionRatio, want[4], 5e-5);
    }),
    JSON.stringify(rows),
  );
  console.log("same default, fillet sized once at 3 × wall (what the planner stores) and measured at the shorter height");
  console.log("wall  height  filletAt  base/wall  radius/wall  junction/wall");
  const planned = [2, 3].flatMap((wall) => [1, 2, 3].map((n) => mouldedDefaultRow(wall, n, 3)));
  for (const row of planned) {
    console.log([row.wall, row.height, row.filletAt, row.baseRatio === null ? "refused" : row.baseRatio.toFixed(4), row.radiusRatio === null ? "refused" : row.radiusRatio.toFixed(4), row.junctionRatio === null ? "refused" : row.junctionRatio.toFixed(4)].join("  "));
  }
  check("the planner-fillet rows are computed", planned.length === 6 && planned.every((row) => row.baseRatio !== null && Number.isFinite(row.baseRatio) && row.radiusRatio !== null && Number.isFinite(row.radiusRatio) && row.junctionRatio !== null && Number.isFinite(row.junctionRatio)));
}

// A drafted rib on a 2 mm wall, 6 mm tall. The product root (half the top) cannot pass: base ≤ 0.6 and
// radius ≥ 0.25 ask for widths that do not overlap. A chosen root at the 0.25 floor can.
{
  const tall = 6;
  const measured = (report: ReturnType<typeof mouldingReport>) => report.rules.find((row) => row.rule === "base")!.worst !== null;
  const passes = (report: ReturnType<typeof mouldingReport>) => measured(report) && report.flags.length === 0 && report.rules.every((row) => row.pass);
  const one = (section: MouldSection) => mouldingReport([rib([[0, 0, 0], [40, 0, 0]], section, tall, 2)]);
  const scene = (section: MouldSection) => {
    const mk = (points: V3[]): MouldRib => ({ points, heights: [tall], sections: [section], normals: points.map(() => up), wallMm: points.map(() => 2) });
    return mouldingReport([mk([[-40, 0, 0], [40, 0, 0]]), mk([[0, -30, 0], [0, 30, 0]]), mk([[-40, 12.7, 0], [40, 12.7, 0]])]);
  };
  const product = (width: number) => defaultDraftedSection(width, tall);
  const chosen = (width: number, rootRadius: number): MouldSection => ({ profile: "drafted", width, draftDeg: 1, rootRadius });
  let productOne = 0;
  let productCross = 0;
  for (let i = 20; i <= 200; i += 1) {
    const width = i / 100;
    if (passes(one(product(width)))) productOne += 1;
    if (passes(scene(product(width)))) productCross += 1;
  }
  console.log(`product root at 6 mm on a 2 mm wall: ${productOne} single-rib widths pass, ${productCross} widths pass with a 90° crossing`);
  const thin = one(product(0.55));
  const thinRadius = thin.rules.find((row) => row.rule === "radius")!;
  check("0.55 mm with the product root does not pass: its root is under 0.25 × the wall", thinRadius.pass === false && thinRadius.worst !== null && thinRadius.worst < MOULD_ROOT_RADIUS_MIN && near(thinRadius.worst, 0.1113, 5e-4), JSON.stringify(thin.rules));
  check("no product-root width at 6 mm passes, alone or crossing another rib", productOne === 0 && productCross === 0);
  check("1.062 mm drafted at 1°, root 0.5 mm, passes every rule on its own", passes(one(chosen(1.062, 0.5))));
  const thicker = one(chosen(1.063, 0.5));
  check("1.063 mm is the next thousandth and flags the junction over 1.2", thicker.flags.some((flag) => flag.rule === "junction" && flag.value > MOULD_JUNCTION_RATIO), JSON.stringify(thicker.flags));
  check("0.623 mm drafted at 1°, root 0.5 mm, still passes with a 90° crossing and a neighbour", passes(scene(chosen(0.623, 0.5))));
  const crowded = scene(chosen(0.624, 0.5));
  check("0.624 mm with that crossing flags the junction over 1.2", crowded.flags.some((flag) => flag.rule === "junction" && flag.value > MOULD_JUNCTION_RATIO), JSON.stringify(crowded.flags));
}

if (failed) {
  console.error(`moulding: ${failed} failed`);
  process.exit(1);
}
console.log("moulding: ok");
