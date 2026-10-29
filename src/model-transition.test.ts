/**
 * --- Print transitions (docs/plan-belt-transitions.md, step 3): the stale-pose check, the card's round trip through the
 * op a step stores, the kernel's rows read for the card and the MCP, and the wedge the card draws.
 */
import { eulerOrient } from "./mesh-place.ts";
import { editRefusal } from "./model-edit.ts";
import { newTree, opLabel, withChild, type TransitionOp } from "./model-tree.ts";
import {
  TRANSITION_SIZE_MM,
  cardAimed,
  caseName,
  curvedNote,
  findingSummary,
  fixOp,
  fixText,
  fixableEdges,
  readFinding,
  transitionFindRequest,
  transitionFix,
  cardFromTransition,
  keptKey,
  newTransitionCard,
  readTransitionRows,
  reaimedTransition,
  sameTransitionCard,
  staleNote,
  transitionAngleLimit,
  transitionBuild,
  transitionCardRefusal,
  transitionFromCard,
  transitionSkinWarns,
  transitionSource,
  transitionStaleBy,
  wedgeSoup,
  type TransitionPose,
} from "./model-transition.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}
const close = (a: readonly number[], b: readonly number[], tol = 1e-6) => a.length === b.length && a.every((value, i) => Math.abs(value - b[i]!) <= tol);

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const s = Math.SQRT1_2;
const ir3: TransitionPose = { orient: IDENTITY, belt: { angleDeg: 45 }, printer: "ideaformer-ir3-v2" };
const flat: TransitionPose = { orient: IDENTITY, belt: null, printer: "lime-220" };

// --- Defaults, one source with the MCP.
check("the default angle is the support limit", transitionAngleLimit(45) === 45 && transitionAngleLimit(60) === 30);
check("the default size is 2 mm", TRANSITION_SIZE_MM === 2);
check("on the IR3 V2 the build is (0, −sin 45°, cos 45°)", close(transitionBuild(ir3), [0, -s, s], 1e-9));
check("a flat bed builds along +Z", close(transitionBuild(flat), [0, 0, 1]));
check("Skin on shallow slopes warns past 3 mm only", !transitionSkinWarns(true, 3) && transitionSkinWarns(true, 3.5) && !transitionSkinWarns(false, 10));
check("the source line names the printer and the belt", transitionSource("IR3 V2", 45) === "From this pose on the IR3 V2, belt 45°.");
check("on a flat printer it names the bed", transitionSource("Lime 220", null) === "From this pose on the Lime 220, its bed.");

// --- A new card is aimed from the pose, and its op is what the MCP would store.
const card = newTransitionCard([7, 3], 45, ir3);
const op = transitionFromCard(card);
check("a new card's op has the defaults and the pose", op.angleDeg === 45 && op.size === 2 && op.beltDeg === 45 && op.printer === "ideaformer-ir3-v2" && close(op.build, [0, -s, s], 1e-9) && JSON.stringify(op.edges) === "[7,3]", JSON.stringify(op));
check("a flat card stores no belt angle", !("beltDeg" in transitionFromCard(newTransitionCard([1], 45, flat))));
check("a card with no edge says to pick one", transitionCardRefusal(newTransitionCard([], 45, ir3), 45) === "Pick an edge in a concave corner. Shift-click adds edges.");
check("an angle under the limit is refused with the limit", /at least 45°/.test(transitionCardRefusal({ ...card, angleDeg: 30 }, 45) ?? ""));
check("an angle past 85° is refused", /at most 85°/.test(transitionCardRefusal({ ...card, angleDeg: 86 }, 45) ?? ""));
check("a card that works has no refusal", transitionCardRefusal(card, 45) === null && transitionCardRefusal({ ...card, size: "face" }, 45) === null);

// --- The round trip: a stored step reopens the card with the same numbers, and the card gives the same op back.
const stored: TransitionOp = {
  kind: "transition",
  edges: [{ index: 7, mid: [10, 5, 10], lengthMm: 20 }],
  build: [0, -s, s],
  angleDeg: 55,
  size: "face",
  maxMm: 40,
  beltDeg: 45,
  orient: eulerOrient(0, 0, 90),
  printer: "ideaformer-ir3-v2",
};
const reopened = cardFromTransition(stored, [7], 45);
const back = transitionFromCard(reopened);
check("the card keeps every number of the step", JSON.stringify({ ...back, edges: stored.edges }) === JSON.stringify(stored), JSON.stringify(back));
check("To the end of the face keeps the millimetres for when it is turned off", reopened.mm === 2 && reopened.size === "face");
check("an untouched card is the same card", sameTransitionCard(reopened, cardFromTransition(stored, [7], 45)));
check("a changed angle is not", !sameTransitionCard(reopened, { ...reopened, angleDeg: 60 }));
const bare = cardFromTransition({ kind: "transition", edges: [2], build: [0, 0, 1] }, [2], 45);
check("a step with no stored numbers reopens on the defaults", bare.angleDeg === 45 && bare.size === 2 && bare.printer === "");

// --- Stale: more than 1° between the stored build and this pose's.
check("the pose a step was made for is not stale", transitionStaleBy(op, ir3) === null);
const quarter: TransitionPose = { ...ir3, orient: eulerOrient(0, 0, 90) };
const off = transitionStaleBy(op, quarter);
check("on the belt a turn about the plate's Z makes it stale", off != null && Math.abs(off - 60) < 1e-6, String(off));
check("half a degree is not stale", transitionStaleBy(op, { ...ir3, orient: eulerOrient(0, 0, 0.5) }) === null);
check("a flat bed after the belt is stale by 45°", Math.abs((transitionStaleBy(op, flat) ?? 0) - 45) < 1e-6);
check("on a flat bed a turn about Z keeps the step", transitionStaleBy(transitionFromCard(newTransitionCard([1], 45, flat)), { ...flat, orient: eulerOrient(0, 0, 90) }) === null);
check("another belt printer at the same angle keeps the step", transitionStaleBy(op, { orient: ir3.orient, belt: { angleDeg: 45 } }) === null);
const aimed = reaimedTransition(stored, flat);
check("Re-aim takes this pose and keeps every other number", close(aimed.build, [0, 0, 1]) && !("beltDeg" in aimed) && aimed.printer === "lime-220" && aimed.angleDeg === 55 && aimed.size === "face" && aimed.maxMm === 40 && aimed.edges === stored.edges, JSON.stringify(aimed));
check("a re-aimed step is no longer stale", transitionStaleBy(aimed, flat) === null);
check("Aim from this pose in the card does the same", transitionStaleBy(cardAimed(reopened, quarter), quarter) === null && cardAimed(reopened, quarter).angleDeg === 55);
check("Keep is for one pose: a later turn warns again", keptKey("t", 3, ir3) !== keptKey("t", 3, quarter) && keptKey("t", 3, ir3) === keptKey("t", 3, { ...ir3 }));
check("the note counts the steps and says the belt's turn", staleNote(2, true) === "2 print transitions were made for another pose. On the belt, even a turn about the plate's Z changes the layers. Re-aim, or keep them as they are.");
check("one step on a flat bed", staleNote(1, false) === "1 print transition was made for another pose. Re-aim it, or keep it as it is.");

// --- The kernel's rows, and the angle to the plate.
const rows = readTransitionRows([{ edge: 7, case: "corner", path: "chamfer", farFace: 2, nearFace: 5, farDeg: 25, nearDeg: 90, normal: [0, -1, 0], angleToLayersDeg: 45, reachMm: 2, nearReachMm: 2.83, farEndMm: 30, volumeMm3: 17.5 }, null], IDENTITY);
check("one row is read, and the bad one dropped", rows?.length === 1);
check("a face looking along −Y stands at 90° to the belt", rows?.[0]?.angleToPlateDeg === 90 && rows[0]!.volumeMm3 === 17.5 && rows[0]!.farFace === 2, JSON.stringify(rows));
check("no rows reads as none", readTransitionRows([], IDENTITY) === null && readTransitionRows(undefined, IDENTITY) === null);

// --- The wedge: an L corner along X, far face the floor (normal +Z), near face the wall (normal +Y).
const soup = wedgeSoup([0, 10, 10], [20, 10, 10], [0, 0, 1], [0, 1, 0], 2, 3);
check("the wedge is 8 triangles", soup.length === 8 * 9, String(soup.length));
const ys = soup.filter((_, i) => i % 3 === 1);
const zs = soup.filter((_, i) => i % 3 === 2);
check("it runs 2 mm along the floor, away from the wall", Math.min(...ys) === 10 && Math.max(...ys) === 12, `${Math.min(...ys)} ${Math.max(...ys)}`);
check("and 3 mm up the wall", Math.min(...zs) === 10 && Math.max(...zs) === 13);
check("a zero reach draws nothing", wedgeSoup([0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], 0, 1).length === 0);

// --- History: one row, plural right, and the pencil is no longer refused.
check("the row says one edge", opLabel(op).startsWith("Print transition (2 edges), 45°, 2 mm"), opLabel(op));
check("and one edge", opLabel({ ...op, edges: [1] }) === "Print transition (1 edge), 45°, 2 mm");
check("to the face's end", opLabel(stored) === "Print transition (1 edge), 55°, to the face's end");
const tree = withChild(newTree("t", { kind: "primitive", solid: { primitive: "box", origin: [0, 0, 0], size: [20, 20, 20], turn: [0, 0, 0] } as never }, "Box", null), 0, { id: 1, op, label: opLabel(op), fingerprint: null });
check("a print transition step can be edited", editRefusal(tree, 1) === null, String(editRefusal(tree, 1)));

// --- Step 5: auto-find. The request, the kernel's rows read longest first, Fix all's edges, and the sentences.
const fix = transitionFix(card);
check("the fix is the card's angle and size, mode auto", JSON.stringify(fix) === JSON.stringify({ mode: "auto", angleDeg: 45, size: 2 }));
const findBody = transitionFindRequest("k", 4, card.build, eulerOrient(90, 0, 0), 45, fix);
const s2 = Math.SQRT1_2;
check(
  "the request names the step, the build, the plate's up in the solid's frame and the limit",
  findBody.call === "transitionFind" && findBody.key === "k" && findBody.node === 4 && findBody.limitDeg === 45
    && (findBody.up as number[]).every((value, i) => Math.abs(value - [0, 1, 0][i]!) < 1e-9) && Math.abs((findBody.build as number[])[1]! + s2) < 1e-8,
  JSON.stringify(findBody),
);
const wedgeRow = { edge: 3, case: "corner", path: "chamfer", farFace: 4, nearFace: 1, farDeg: 25, nearDeg: 90, normal: [0, -s2, s2], angleToLayersDeg: 45, reachMm: 2, nearReachMm: 2, volumeMm3: 39.96 };
const kernelRows = {
  id: 4,
  curvedSkipped: 1,
  rows: [
    { edge: 9, case: "corner", lengthMm: 12.5, mid: [0, 1, 2], farDeg: 46, nearDeg: 90, probe: { ok: false, error: "already grows" } },
    { edge: 7, case: "lip", lengthMm: 20, mid: [1, 2, 3], farDeg: 0, nearDeg: 90, probe: { ok: false, error: "convex" } },
    { edge: 3, case: "corner", lengthMm: 20, mid: [4, 5, 6], farDeg: 25, nearDeg: 90, probe: { ok: true, transition: [wedgeRow] } },
    { edge: 1, case: "point", lengthMm: 30, mid: [0, 0, 0], probe: { ok: true } },
  ],
};
const finding = readFinding(kernelRows, [1, 0, 0, 0, 1, 0, 0, 0, 1], fix, (text) => `Plain: ${text}`);
check("a refusal reads as the engine's sentence", readFinding({ error: "That step is not held." }, [], fix) === "That step is not held.");
if (typeof finding === "string") check("the rows read", false, finding);
else {
  check("rows of an unknown case are dropped, the rest longest first and by edge", finding.rows.map((row) => row.edge).join() === "3,7,9", JSON.stringify(finding.rows));
  check("a fix that builds keeps its wedge", finding.rows[0]!.wedge?.volumeMm3 === 39.96 && finding.rows[0]!.refused === null);
  check("a fix that refuses keeps its sentence, worded", finding.rows[1]!.refused === "Plain: convex" && finding.rows[1]!.wedge === null);
  check("Fix all takes the rows that build", JSON.stringify(fixableEdges(finding)) === "[3]");
  const all = fixOp({ ...card, angleDeg: 50, size: 5 }, finding, [3, 9]);
  check("a fix op is the finding's numbers on the card's pose", all.angleDeg === 45 && all.size === 2 && JSON.stringify(all.edges) === "[3,9]" && JSON.stringify(all.build) === JSON.stringify(card.build) && all.printer === card.printer, JSON.stringify(all));
  check("the fix in words", fixText(finding.rows[0]!, fix) === "Wedge, 2 mm at 45°, +40 mm³" && fixText(finding.rows[1]!, fix) === "Gusset, 2 mm at 45°" && fixText(finding.rows[0]!, { ...fix, size: "face" }).startsWith("Wedge, to the face's end at 45°"), fixText(finding.rows[0]!, fix));
  check(
    "the summary counts cases, refusals and curved edges",
    findingSummary(finding) === "3 edges start in the air: 2 corners and 1 lip, longest first. 1 fix builds; 2 refuse, each saying why. 1 curved edge skipped until a later version.",
    findingSummary(finding),
  );
  check("one edge whose fix builds", findingSummary({ ...finding, rows: finding.rows.slice(0, 1), curvedSkipped: 0 }) === "1 edge starts in the air: 1 corner, longest first. Its fix builds.");
  check("none found", findingSummary({ ...finding, rows: [], curvedSkipped: 0 }) === "No straight edge starts in the air in this pose." && curvedNote(0) === null && curvedNote(3) === "3 curved edges skipped until a later version.");
  check("case names", caseName("lip") === "Lip" && caseName("corner") === "Corner");
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("model-transition: stale pose, card round trip, rows, wedge ok");
