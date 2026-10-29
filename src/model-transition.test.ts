/**
 * --- Print transitions (docs/plan-belt-transitions.md, step 3): the stale-pose check, the card's round trip through the
 * op a step stores, the kernel's rows read for the card and the MCP, and the wedge the card draws.
 */
import { eulerOrient } from "./mesh-place.ts";
import { editRefusal } from "./model-edit.ts";
import { newTree, opLabel, withChild, type TransitionOp } from "./model-tree.ts";
import {
  CUT_LIP_ONLY,
  PICK_EDGE,
  TRANSITION_SIZE_MM,
  cardAimed,
  caseName,
  cardCase,
  chainClick,
  curvedNote,
  edgeChainRequest,
  edgesLine,
  readEdgeChain,
  findingSummary,
  fixOp,
  fixText,
  fixableEdges,
  foundWords,
  readFinding,
  transitionFindRequest,
  transitionFix,
  transitionFloorMm,
  transitionSentence,
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
check("a card with no edge says to pick one", transitionCardRefusal(newTransitionCard([], 45, ir3), 45) === PICK_EDGE && /a lip's lowest edge/.test(PICK_EDGE));
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

// --- Step 4, lips: the case found or chosen, Add or Cut, the wall floor, the kernel's lip rows and the history row.
check("the wall floor is twice the nozzle", transitionFloorMm(0.4) === 0.8 && transitionFloorMm(0.6) === 1.2 && transitionFloorMm(null) === 0.8);
const fresh = newTransitionCard([4], 45, ir3, 1.2);
check("a new card adds, with each edge's case as found", fresh.case === null && fresh.mode === "add" && fresh.floorMm === 1.2);
check("its op leaves out the case, the mode and the floor", !("case" in transitionFromCard(fresh)) && !("mode" in transitionFromCard(fresh)) && !("floorMm" in transitionFromCard(fresh)));
const cutCard = { ...fresh, case: "lip" as const, mode: "cut" as const };
const cutOp = transitionFromCard(cutCard);
check("a cut lip carries its case, its mode and its floor", cutOp.case === "lip" && cutOp.mode === "cut" && cutOp.floorMm === 1.2, JSON.stringify(cutOp));
check("a cut reopens as a cut, with its own floor", (() => { const again = cardFromTransition(cutOp, [4], 45, 0.8); return again.mode === "cut" && again.case === "lip" && again.floorMm === 1.2 && sameTransitionCard(again, cutCard); })());
check("cut on a corner is refused on the card", transitionCardRefusal({ ...fresh, case: "corner", mode: "cut" }, 45) === CUT_LIP_ONLY);
check("the case shown is the one chosen, else the one every edge was found", cardCase({ case: "corner" }, ["lip"]) === "corner" && cardCase({ case: null }, ["lip", "lip"]) === "lip" && cardCase({ case: null }, ["lip", "corner"]) === null && cardCase({ case: null }, null) === null);
check("what was found, in words", foundWords(["lip"]) === "a lip" && foundWords(["corner", "corner"]) === "2 corners" && foundWords(["lip", "corner", "corner"]) === "1 lip and 2 corners");
const lipRows = readTransitionRows([{ edge: 4, case: "lip", path: "gusset", material: "add", firstEdge: 4, farFace: 3, nearFace: 6, farDeg: 0, nearDeg: 90, normal: [0, 0, -1], angleToLayersDeg: 45, depthMm: 6, reachMm: 6, nearReachMm: 0, heightMm: 3, landingMm: 4.243, volumeMm3: 180, soup: [0, 0, 0, 1, 0, 0, 0, 1, 0] }], IDENTITY);
const lipRow = lipRows?.[0];
check("a lip row is read with its gusset's numbers and triangles", lipRow?.case === "lip" && lipRow.material === "add" && lipRow.heightMm === 3 && lipRow.landingMm === 4.243 && lipRow.leftMm === null && lipRow.soup?.length === 9, JSON.stringify(lipRow));
check("a corner row has no triangles and reads as a corner", rows?.[0]?.case === "corner" && rows[0]!.soup === null && rows[0]!.material === "add");
check("the gusset in words", transitionSentence(lipRow!, true) === "Edge 4: a lip 6 mm deep, its underside at 0° to the layers. The gusset runs back into the part at 45° to the layers and 0° to the belt, 3 mm down the build, landing 4.24 mm from the edge and adding 180 mm³.", transitionSentence(lipRow!, true));
const rampRow = { ...lipRow!, path: "ramp", material: "cut" as const, landingMm: null, leftMm: 6 };
check("the ramp in words", transitionSentence(rampRow, true) === "Edge 4: a lip 6 mm deep, its underside at 0° to the layers. The ramp runs from its root to its first edge, at 45° to the layers and 0° to the belt, leaving 6 mm there and removing 180 mm³.", transitionSentence(rampRow, true));
check("a step of lips names lips and no size", opLabel({ ...op, edges: [1], case: "lip" }) === "Print transition (1 lip), 45°" && opLabel({ ...op, case: "lip" }) === "Print transition (2 lips), 45°");
check("a cut says so", opLabel({ ...op, edges: [1], mode: "cut", case: "lip" }) === "Print transition (1 lip), cut, 45°");

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
    { edge: 3, case: "corner", lengthMm: 20, mid: [4, 5, 6], farDeg: 25, nearDeg: 90, curved: true, probe: { ok: true, transition: [wedgeRow] } },
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
  check("the fix in words", fixText(finding.rows[0]!, fix) === "Wedge, 2 mm at 45°, +40 mm³" && fixText(finding.rows[1]!, fix) === "Gusset at 45°" && fixText(finding.rows[0]!, { ...fix, size: "face" }).startsWith("Wedge, to the face's end at 45°"), fixText(finding.rows[0]!, fix));
  check(
    "the summary counts cases, refusals and curved edges",
    findingSummary(finding) === "3 edges start in the air: 2 corners and 1 lip, longest first. 1 fix builds; 2 refuse, each saying why. 1 curved edge could not be followed, so it is not listed.",
    findingSummary(finding),
  );
  check("one edge whose fix builds", findingSummary({ ...finding, rows: finding.rows.slice(0, 1), curvedSkipped: 0 }) === "1 edge starts in the air: 1 corner, longest first. Its fix builds.");
  check("none found", findingSummary({ ...finding, rows: [], curvedSkipped: 0 }) === "No edge starts in the air in this pose." && curvedNote(0) === null && curvedNote(3) === "3 curved edges could not be followed, so they are not listed.");
  check("case names", caseName("lip") === "Lip" && caseName("corner") === "Corner");
  check("a row the kernel marks curved reads curved, the others not", finding.rows[0]!.curved === true && finding.rows[1]!.curved === false && finding.rows[2]!.curved === false);
}

// --- Step 6: a swept corner's soup, the sweep in words, and chains.
const swept = readTransitionRows([{ ...wedgeRow, path: "sweep", soup: [0, 0, 0, 1, 0, 0, 0, 1, 0] }], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
check("a swept corner keeps the kernel's triangles for the ghost", swept?.[0]?.path === "sweep" && swept[0]!.soup?.length === 9, JSON.stringify(swept));
check("a swept corner in words follows the curve", !!swept && transitionSentence(swept[0]!, true).includes("2 mm along the flatter face, following the curve"), swept ? transitionSentence(swept[0]!, true) : "");
const chainBody = edgeChainRequest("k", 4, 7);
check("the chain request names the step and the edge", chainBody.call === "edgeChain" && chainBody.key === "k" && chainBody.node === 4 && chainBody.edge === 7);
check("a chain reads with the clicked edge in it", JSON.stringify(readEdgeChain({ id: 4, edge: 7, edges: [6, 7, 8, 7], closed: false }, 7)) === "[6,7,8]");
check("a chain without the clicked edge, a refusal or no edges reads as none", readEdgeChain({ edges: [1, 2] }, 7) === null && readEdgeChain({ error: "That edge is not on this solid" }, 7) === null && readEdgeChain({}, 7) === null);
check("a first click asks for the chain", chainClick([], null, 7) === "chain" && chainClick([7], null, 7) === "chain");
check("a click on an edge of the chain picked takes it alone", chainClick([6, 7, 8], [6, 7, 8], 8) === "single" && chainClick([8, 6, 7], [6, 7, 8], 6) === "single");
check("a click off the chain, or once the pick changed, asks again", chainClick([6, 7, 8], [6, 7, 8], 9) === "chain" && chainClick([6, 7], [6, 7, 8], 7) === "chain" && chainClick([7], [7], 7) === "chain");
check("the edge line names a chain and how to take one alone", edgesLine(3, true) === "A chain of 3 edges that run on with no corner. Click one of them again to take it alone; Shift-click adds or removes one." && edgesLine(1, true) === "1 edge. Shift-click adds edges." && edgesLine(3, false) === "3 edges. Shift-click adds or removes one." && edgesLine(0, true) === PICK_EDGE);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("model-transition: stale pose, card round trip, rows, wedge ok");
