/**
 * Pocket finder (src/modeling/vents.ts). Hand-built graphs: a square, a square with a gap, two squares
 * sharing a rib, a cell bordered by a hole, a loose end, an open edge. The opening faces the platform
 * when it points against the build axis.
 */
import { notchRibs, RESIN_VENT_MM, ventPockets, ventSizeMm, type VentBorder, type VentRib } from "./vents.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

type V3 = [number, number, number];
const edge = (a: V3, b: V3, ends?: VentRib["ends"]): VentRib => ({ points: [a, b], ...(ends ? { ends } : {}) });
const square = (x0: number, x1: number, y0: number, y1: number): VentRib[] => [
  edge([x0, y0, 0], [x1, y0, 0]),
  edge([x1, y0, 0], [x1, y1, 0]),
  edge([x1, y1, 0], [x0, y1, 0]),
  edge([x0, y1, 0], [x0, y0, 0]),
];
/** Opening toward the platform (against +Z). */
const cup = { opening: [0, 0, -1] as V3, buildAxis: [0, 0, 1] as V3 };

const one = ventPockets({ ribs: square(0, 10, 0, 10), ...cup });
check("a square is one pocket", one.cups && one.pockets.length === 1, JSON.stringify(one.pockets));
check("the vent is Formlabs' 0.75 mm", one.sizeMm === RESIN_VENT_MM && one.pockets[0]?.sizeMm === 0.75);
const at = one.pockets[0]!.at;
const onSide = (Math.abs(at[0]) < 1e-6 || Math.abs(at[0] - 10) < 1e-6 || Math.abs(at[1]) < 1e-6 || Math.abs(at[1] - 10) < 1e-6) && at[0] >= -1e-6 && at[0] <= 10 + 1e-6 && at[1] >= -1e-6 && at[1] <= 10 + 1e-6;
const offCorner = [[0, 0], [10, 0], [10, 10], [0, 10]].every(([x, y]) => Math.hypot(x! - at[0], y! - at[1]) > 2);
check("the vent sits on a side, not a corner", onSide && offCorner && Math.abs(at[2]) < 1e-6, JSON.stringify(at));

const gapped = ventPockets({ ribs: square(0, 10, 0, 10).slice(0, 3), ...cup });
check("a square with a gap is not a pocket", gapped.cups && gapped.pockets.length === 0, JSON.stringify(gapped.pockets));

const shared: VentRib[] = [
  ...square(0, 10, 0, 10),
  edge([10, 0, 0], [20, 0, 0]),
  edge([20, 0, 0], [20, 10, 0]),
  edge([20, 10, 0], [10, 10, 0]),
];
const two = ventPockets({ ribs: shared, ...cup });
check("two squares sharing a rib are two pockets", two.pockets.length === 2, JSON.stringify(two.pockets));
check("the two vents are on different ribs", two.pockets[0]?.rib !== two.pockets[1]?.rib);

const holed: VentBorder[] = [{ points: [[0, 0, 0], [10, 0, 0]], kind: "hole" }];
const hole = ventPockets({ ribs: square(0, 10, 0, 10).slice(1), borders: holed, ...cup });
check("a cell bordered by a hole is not a pocket", hole.pockets.length === 0, JSON.stringify(hole.pockets));

const openBorder: VentBorder[] = [{ points: [[0, 0, 0], [10, 0, 0]], kind: "open" }];
const open = ventPockets({ ribs: square(0, 10, 0, 10).slice(1), borders: openBorder, ...cup });
check("a cell open to the part's edge is not a pocket", open.pockets.length === 0);

const rises: VentBorder[] = [{ points: [[0, 0, 0], [10, 0, 0]], kind: "rises" }];
const walled = ventPockets({ ribs: square(0, 10, 0, 10).slice(1), borders: rises, ...cup });
check("a rising side wall closes the cell", walled.pockets.length === 1, JSON.stringify(walled.pockets));

const loose = square(0, 10, 0, 10);
loose[0] = edge([0, 0, 0], [10, 0, 0], ["free", "closed"]);
check("a cell with a loose rib end is not a pocket", ventPockets({ ribs: loose, ...cup }).pockets.length === 0);

const turned = ventPockets({ ribs: square(0, 10, 0, 10), opening: [0, 0, 1], buildAxis: [0, 0, 1] });
check("the same square turned to face the tank cups nothing", turned.cups === false && turned.pockets.length === 0);

const flipped = ventPockets({ ribs: square(0, 10, 0, 10), opening: [0, 0, -1], buildAxis: [0, 0, -1] });
check("flipping the build axis with the opening flips the answer", flipped.pockets.length === 0);

const grid: VentRib[] = [
  edge([0, 10, 0], [30, 10, 0], ["free", "free"]),
  edge([0, 20, 0], [30, 20, 0], ["free", "free"]),
  edge([10, 0, 0], [10, 30, 0], ["free", "free"]),
  edge([20, 0, 0], [20, 30, 0], ["free", "free"]),
];
const cell = ventPockets({ ribs: grid, ...cup });
check("a crossed grid closes one cell, and the loose tips are outside it", cell.pockets.length === 1, JSON.stringify(cell.pockets));

const notched = notchRibs(square(0, 10, 0, 10), one.pockets);
const again = ventPockets({ ribs: notched, ...cup });
check("after the notch the square drains", notched.length === 5 && again.pockets.length === 0, `pieces ${notched.length} pockets ${again.pockets.length}`);

const both = notchRibs(shared, two.pockets);
check("both squares drain once each has its notch", ventPockets({ ribs: both, ...cup }).pockets.length === 0);

const sloped = ventPockets({
  ribs: [
    edge([0, 0, 0], [10, 0, 4]),
    edge([10, 0, 4], [10, 10, 4]),
    edge([10, 10, 4], [0, 10, 0]),
    edge([0, 10, 0], [0, 0, 0]),
  ],
  ...cup,
});
check("the notch is at the low end of the drain", sloped.pockets.length === 1 && (sloped.pockets[0]?.at[2] ?? 9) < 0.5, JSON.stringify(sloped.pockets[0]?.at));

check("no pixel leaves 0.75", ventSizeMm() === 0.75 && ventSizeMm(0.05) === 0.75);
check("a coarser pixel rounds up", Math.abs(ventSizeMm(0.4) - 0.8) < 1e-9);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("vents: ok");
