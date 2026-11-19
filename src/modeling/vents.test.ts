/**
 * Pocket finder (src/modeling/vents.ts) against tools/fixtures/vent-graphs.json, the same file the
 * Rust test reads. A pocket cups when the ribs' side points along the build axis. The crossed pair
 * in a rising border is four cells, and a notch is the middle of a rib that can drain.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildDirection } from "../belt.ts";
import { IDENTITY_POSE } from "../model-space.ts";
import { FOLDED_NOTE, GIVEN_AXIS, NO_RESIN_PRINTER, notchRibs, PART_CUPS, plateToWall, RESIN_VENT_MM, TOO_SHORT, ventBodyOf, ventPockets, ventSizeMm, type EndKind, type V3, type VentBorder, type VentRib } from "./vents.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

type ExpectPocket = { rib: number; at: number[]; sizeMm: number };
type ExpectOpen = { at: number[]; message: string };
type Build = { axis: number[]; cups: boolean; closed: number; pockets: ExpectPocket[]; unvented: ExpectOpen[]; unventedSame?: boolean; note?: boolean };
type Case = { name: string; ribs: VentRib[]; borders?: VentBorder[]; widthMm?: number; minLengthMm?: number; builds: Build[] };
type Fixture = { widthMm: number; minLengthMm: number; opening: V3; cases: Case[] };

const fixture = JSON.parse(readFileSync(new URL("../../tools/fixtures/vent-graphs.json", import.meta.url), "utf8")) as Fixture;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const sameAt = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => near(v, b[i]!));

for (const row of fixture.cases) {
  const width = row.widthMm ?? fixture.widthMm;
  const minLengthMm = row.minLengthMm ?? fixture.minLengthMm;
  const ribs: VentRib[] = row.ribs.map((rib) => ({ ...rib, widthMm: rib.widthMm ?? width, ...(rib.ends ? { ends: rib.ends as [EndKind, EndKind] } : {}) }));
  const partCups = row.builds.find((build) => build.unvented.length > 0 && build.unvented.every((item) => item.message === PART_CUPS));
  for (const build of row.builds) {
    const axis = build.axis;
    const got = ventPockets({ ribs, borders: row.borders, opening: fixture.opening, buildAxis: [axis[0]!, axis[1]!, axis[2]!], minLengthMm });
    const expectUnvented = build.unventedSame ? (partCups?.unvented ?? []) : build.unvented;
    const name = `${row.name} ${JSON.stringify(build.axis)}`;
    check(`${name} cups`, got.cups === build.cups, `got ${got.cups}`);
    check(`${name} closed`, got.closed === build.closed, `got ${got.closed}`);
    check(`${name} pockets`, got.pockets.length === build.pockets.length && got.pockets.every((pocket, i) => pocket.rib === build.pockets[i]!.rib && pocket.sizeMm === build.pockets[i]!.sizeMm && sameAt(pocket.at, build.pockets[i]!.at)), JSON.stringify(got.pockets));
    const unvented = [...got.unvented].sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.at[2] - b.at[2]);
    const want = [...expectUnvented].sort((a, b) => a.at[0]! - b.at[0]! || a.at[1]! - b.at[1]! || a.at[2]! - b.at[2]!);
    check(`${name} unvented`, unvented.length === want.length && unvented.every((item, i) => item.message === want[i]!.message && sameAt(item.at, want[i]!.at)), JSON.stringify(unvented));
    check(`${name} note`, build.note === true ? got.note === FOLDED_NOTE : got.note === undefined, got.note ?? "");
  }
}

const square = fixture.cases[0]!;
const width = fixture.widthMm;
const ribs: VentRib[] = square.ribs.map((rib) => ({ ...rib, widthMm: width }));
const cup = ventPockets({ ribs, opening: fixture.opening, buildAxis: [0, 0, 1], minLengthMm: fixture.minLengthMm });
const notched = notchRibs(ribs, cup.pockets, fixture.minLengthMm);
const again = ventPockets({ ribs: notched, opening: fixture.opening, buildAxis: [0, 0, 1], minLengthMm: fixture.minLengthMm });
const gapEnds = notched.filter((rib) => rib.ends?.[0] === "gap" || rib.ends?.[1] === "gap").length;
check("the notch is a gap, and the square then drains", gapEnds === 2 && notched.length === 5 && again.closed === 0 && again.pockets.length === 0 && again.unvented.length === 0, `pieces ${notched.length} gapEnds ${gapEnds} again ${JSON.stringify(again)}`);
const piece = notched.map((rib) => {
  let length = 0;
  for (let i = 1; i < rib.points.length; i += 1) {
    const a = rib.points[i - 1]!;
    const b = rib.points[i]!;
    length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return length;
});
check("neither piece is shorter than the minimum rib", piece.every((length) => length + 1e-6 >= fixture.minLengthMm), JSON.stringify(piece));
const gap = (() => {
  const ends = notched.flatMap((rib) => {
    const found: V3[] = [];
    if (rib.ends?.[0] === "gap") found.push(rib.points[0]!);
    if (rib.ends?.[1] === "gap") found.push(rib.points[rib.points.length - 1]!);
    return found;
  });
  if (ends.length < 2) return -1;
  return Math.hypot(ends[0]![0] - ends[1]![0], ends[0]![1] - ends[1]![1], ends[0]![2] - ends[1]![2]);
})();
check("the gap is 0.75 mm", near(gap, RESIN_VENT_MM), String(gap));

check("no pixel leaves 0.75", ventSizeMm() === 0.75 && ventSizeMm(0.05) === 0.75);
check("a coarser pixel rounds up", Math.abs(ventSizeMm(0.4) - 0.8) < 1e-9);
check("the two sentences are the ones the plan reports", PART_CUPS.startsWith("the part itself cups") && TOO_SHORT.length > 0);

const orient = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const loops = [{ hole: false, spans: [{ class: "joined" as const, from: [0, 0, 0] as V3, to: [10, 0, 0] as V3 }, { class: "free" as const, from: [10, 0, 0] as V3, to: [10, 10, 0] as V3 }] }, { hole: true, spans: [{ class: "free" as const, from: [2, 2, 0] as V3, to: [4, 2, 0] as V3 }, { class: "free" as const, from: [4, 2, 0] as V3, to: [2, 2, 0] as V3 }] }];
const panel = ventBodyOf("resin", { orient, pose: IDENTITY_POSE }, loops, null);
const mcp = ventBodyOf("resin", { orient, pose: IDENTITY_POSE }, loops, [0, 0, 1]);
check("the panel and ribs_plan build the same resin request", JSON.stringify(panel) === JSON.stringify(mcp), JSON.stringify({ panel, mcp }));
check("filament and moulded add no vent fields", JSON.stringify(ventBodyOf("filament", { orient, pose: IDENTITY_POSE }, loops, [0, 0, 1])) === "{}" && JSON.stringify(ventBodyOf("moulded", { orient, pose: IDENTITY_POSE }, loops, null)) === "{}");
const belt = buildDirection(orient, { angleDeg: 45 });
const axis = panel && "buildAxis" in panel ? panel.buildAxis : [0, 0, 0];
check("the default is plate +Z, not the belt direction", near(axis[0], 0) && near(axis[1], 0) && near(axis[2], 1) && Math.abs(belt[1] + Math.sin(Math.PI / 4)) < 1e-9, JSON.stringify({ axis, belt }));
const turned = plateToWall([0, 1, 0, -1, 0, 0, 0, 0, 1], IDENTITY_POSE, [0.3, 0.2, 0.93]);
const turnedAgain = plateToWall([0, 1, 0, -1, 0, 0, 0, 0, 1], IDENTITY_POSE, [0.3, 0.2, 0.93]);
check("a given axis is turned the same way for both callers", JSON.stringify(turned) === JSON.stringify(turnedAgain) && Math.abs(turned[0] + 0.200511959) < 1e-6 && Math.abs(turned[1] - 0.300767939) < 1e-6 && Math.abs(turned[2] - 0.93238061) < 1e-6, JSON.stringify(turned));
const borders = panel && "borders" in panel ? panel.borders : [];
check("one open span stays open and a hole loop is a hole", borders.length === 3 && borders[0]?.kind === "rises" && borders[1]?.kind === "open" && borders[2]?.kind === "hole", JSON.stringify(borders));
const closed = ventBodyOf("resin", { orient, pose: IDENTITY_POSE }, [{
  hole: false,
  spans: [{ class: "joined", from: [0, 0, 0], to: [0, 0, 0], points: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 0]] }],
}], null);
const closedBorders = closed && "borders" in closed ? closed.borders : [];
check("a closed joined loop keeps its corners", closedBorders.length === 1 && closedBorders[0]?.kind === "rises" && closedBorders[0].points.length === 5, JSON.stringify(closedBorders));
const walled = ventPockets({
  ribs: [
    { points: [[0, 5, 0], [10, 5, 0]], widthMm: 1 },
    { points: [[5, 0, 0], [5, 10, 0]], widthMm: 1 },
  ],
  borders: closedBorders,
  opening: [0, 0, 1],
  buildAxis: [0, 0, 1],
  minLengthMm: 2,
});
check("a loop joined all round cannot be vented", walled.pockets.length === 0 && walled.unvented.length === 4 && walled.unvented.every((item) => item.message === PART_CUPS), JSON.stringify(walled));
check("the notes name the plate frame", NO_RESIN_PRINTER.includes("no resin printer") && NO_RESIN_PRINTER.includes("+Z") && GIVEN_AXIS.includes("plate frame"));
const root = fileURLToPath(new URL("../..", import.meta.url));
const cardSrc = readFileSync(`${root}/src/ui/auto-ribs-card.ts`, "utf8");
const mcpSrc = readFileSync(`${root}/mcp/session/ribs.ts`, "utf8");
check("the panel and ribs_plan both call ventBodyOf", cardSrc.includes("ventBodyOf(") && mcpSrc.includes("ventBodyOf("));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("vents: ok");
