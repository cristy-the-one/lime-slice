/**
 * Organic surfaces S6: schema, bake, and .lime round-trip for nurbsSurface.
 * An older tree that has no NURBS surface still loads.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSavedTree } from "../src/model-tree-file.ts";
import { IDENTITY_POSE } from "../src/model-space.ts";
import { bakeOp } from "../src/modeling/bake.ts";
import { bicubicGrid } from "../src/modeling/nurbs-eval.ts";
import { GLOBAL_WORKPLANE } from "../src/workplane.ts";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { validateTool } from "./schema.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-s6-"));

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const poles = bicubicGrid(4, 4);
const op = { kind: "nurbsSurface", poles, degreeU: 3, degreeV: 3, weights: poles.map((row, iu) => row.map((_, iv) => (iu === 1 && iv === 1 ? 2 : 1))) };
const err = validateTool("model_apply", { op });
check("schema validates nurbsSurface", err === null, String(err));
const refused = validateTool("model_apply", { op: { kind: "nurbsSurface", poles, degreeU: 3, weights: poles.map((row) => row.map(() => 0)) } });
check("schema refuses a weight of 0", refused !== null, String(refused));

const baked = bakeOp(op, { pose: IDENTITY_POSE, solid: null, plane: GLOBAL_WORKPLANE, expand: () => ({ faces: [], faceBy: () => ({ reason: "none" }) }) as never, nodeOf: () => null, hasNode: () => false });
check("bake keeps the weighted grid", !("reason" in baked) && baked.op.kind === "nurbsSurface" && baked.op.weights?.[1]?.[1] === 2, JSON.stringify(baked));
const bad = bakeOp(
  { kind: "nurbsSurface", poles: bicubicGrid(3, 4), degreeU: 3, degreeV: 3 },
  { pose: IDENTITY_POSE, solid: null, plane: GLOBAL_WORKPLANE, expand: () => ({ faces: [], faceBy: () => ({ reason: "none" }) }) as never, nodeOf: () => null, hasNode: () => false },
);
check("bake refuses too few poles", "reason" in bad && bad.reason === "This surface needs at least 4 poles in U for degree 3.", JSON.stringify(bad));

const older = readSavedTree({
  rootFeature: { kind: "extrude", op: "fuse", origin: [0, 0, 0], profile: [[0, 0], [10, 0], [10, 10]], depth: 4 },
  nodes: [{ id: 0, parent: null, op: null, fingerprint: { volumeMm3: 200, faces: 5, edges: 9 } }],
  current: 0,
  committed: 0,
  nextId: 1,
});
check("an older file with no NURBS surface still loads", older !== null && older.nodes.length === 1, JSON.stringify(older));

const saved = readSavedTree({
  rootFeature: op,
  nodes: [{ id: 0, parent: null, op: null, fingerprint: { volumeMm3: 0, faces: 1, edges: 4 } }],
  current: 0,
  committed: 0,
  nextId: 1,
});
check(
  "saved-tree codec round-trips nurbsSurface",
  saved !== null && saved.rootFeature?.kind === "nurbsSurface" && saved.rootFeature.weights?.[1]?.[1] === 2,
  JSON.stringify(saved),
);

// --- A session: solid_new {feature} starts a part from a surface, the kernel gets the baked grid, and model_edit on the
// root replaces it with the later steps replayed. The fake engine answers a surface root as an open sheet.
{
  const plain = fakeEngine();
  const opens: Record<string, unknown>[] = [];
  const engine = {
    ...plain,
    async modelTree(request: string): Promise<string> {
      const parsed = JSON.parse(request) as Record<string, unknown>;
      const feature = parsed.feature as { kind?: string } | undefined;
      if ((!parsed.call || parsed.call === "open") && feature) {
        opens.push(parsed);
        const box = JSON.parse(await plain.modelTree(JSON.stringify({ call: "open", key: parsed.key, primitive: { primitive: "box", origin: [0, 0, 0], size: [10, 10, 1], radius: 0, height: 0, turn: [0, 0, 0] }, chordMm: 0.05 }))) as Record<string, unknown>;
        // As the kernel does: the step the open is shown at decides the solid. At the root it is the bare sheet; at a
        // later step (a thicken) a solid. A pole at z = 99 is a grid the thicken cannot follow.
        const at = typeof parsed.current === "number" ? parsed.current : 0;
        const poles = (feature as { poles?: number[][][] }).poles ?? [];
        if (at > 0 && poles.some((row) => row.some((pole) => pole[2] === 99))) return JSON.stringify({ error: "Open CASCADE could not offset this surface by 2 mm: it bends tighter than that somewhere." });
        return JSON.stringify(at > 0 ? box : { ...box, solid: false, volumeMm3: 0, nakedEdges: [0, 1, 2, 3] });
      }
      return plain.modelTree(request);
    },
  };
  const s = new Session(engine);
  const grid = bicubicGrid(8, 8);
  const made = await s.call("solid_new", { feature: { kind: "nurbsSurface", poles: grid } });
  const sent = opens.at(-1)?.feature as { kind?: string; poles?: unknown[][] } | undefined;
  check(
    "solid_new {feature: nurbsSurface} opens a part whose root is the surface, an open sheet",
    made.ok === true && made.root === "nurbsSurface" && made.openEdges === 4 && sent?.kind === "nurbsSurface" && sent.poles?.length === 8 && sent.poles[0]?.length === 8,
    JSON.stringify({ made, sent: sent?.kind }),
  );
  const refined = await s.call("solid_new", { feature: { kind: "nurbsSurface", poles: grid, insertU: [[0.5, 1]], elevateV: 4 } });
  const baked2 = opens.at(-1)?.feature as Record<string, unknown> | undefined;
  check(
    "the kernel gets the baked grid: an inserted U knot adds a row, elevation 3 to 4 adds one V pole per span (8 + 5), and neither field is sent",
    refined.ok === true && (baked2?.poles as unknown[] | undefined)?.length === 9 && baked2?.degreeV === 4 && ((baked2?.poles as unknown[][])[0]?.length ?? 0) === 13
      && !("insertU" in (baked2 ?? {})) && !("elevateV" in (baked2 ?? {})),
    JSON.stringify({ ok: refined.ok, rows: (baked2?.poles as unknown[] | undefined)?.length, cols: (baked2?.poles as unknown[][] | undefined)?.[0]?.length, degreeV: baked2?.degreeV, keys: Object.keys(baked2 ?? {}) }),
  );
  const refusal = async (feature: Record<string, unknown>) => String((await s.call("solid_new", { feature })).reason ?? "");
  const periodic = await refusal({ kind: "nurbsSurface", poles: grid, periodicU: true, insertV: [[0.5, 1]] });
  check("a closed surface that asks for insertion is refused", periodic === "feature.insertV: knot insertion is for a clamped NURBS surface, not a closed one.", periodic);
  const periodicElevate = await refusal({ kind: "nurbsSurface", poles: grid, periodicV: true, elevateU: 4 });
  check("a closed surface that asks for elevation is refused", periodicElevate === "feature.elevateU: degree elevation is for a clamped NURBS surface, not a closed one.", periodicElevate);
  const times = await refusal({ kind: "nurbsSurface", poles: grid, insertU: [[0.5, 4]] });
  check("times past the degree is refused", times === "feature.insertU[0] inserts 4 times; times is a whole number from 1 to the U degree, 3.", times);
  const fraction = await refusal({ kind: "nurbsSurface", poles: grid, insertU: [[0.5, 1.5]] });
  check("a fractional times is refused", fraction.startsWith("feature.insertU[0] inserts 1.5 times;"), fraction);
  const end = await refusal({ kind: "nurbsSurface", poles: grid, insertV: [[1, 1]] });
  check("an insert at the range's end is refused", end === "feature.insertV[0] is at 1, outside this surface's V range; insert inside 0 to 1, not at an end.", end);
  const full = await refusal({ kind: "nurbsSurface", poles: grid, insertU: [[0.4, 2], [0.4, 2]] });
  check("an insert past full multiplicity is refused", full === "feature.insertU[1] would raise the U knot at 0.4 to multiplicity 5; a degree 3 surface takes at most 3 there (a full crease), so insert it at most 0 more times.", full);
  const both = await s.call("solid_new", { primitive: "box", dx: 1, dy: 1, dz: 1, feature: { kind: "nurbsSurface", poles: grid } });
  check("a feature and a primitive together are refused", both.ok === false && both.code === "conflicting-arguments", JSON.stringify(both));
  const hole = await s.call("solid_new", { feature: { kind: "hole", origin: [0, 0, 0], axis: [0, 0, -1], diameterMm: 4, depth: 2 } });
  check("a feature that cannot start a part is refused", hole.ok === false && hole.reason === "solid_new's feature is an extrude, a revolve, a loft, a sweep, a nurbsSurface or a sheet.", JSON.stringify(hole));
  const sheet = await s.call("solid_new", { feature: { kind: "sheet", mode: "planar", curves: [{ kind: "polyline", points: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], closed: true }] } });
  check("solid_new {feature: sheet} starts a part from a sheet", sheet.ok === true && sheet.root === "sheet" && (opens.at(-1)?.feature as { kind?: string })?.kind === "sheet", JSON.stringify(sheet));
  // model_edit on the root: a new grid, a thicken above it replayed.
  const object = made.object as string;
  const thick = await s.call("model_apply", { object, op: { kind: "thicken", thickness: 2 }, probe: true });
  const raised = grid.map((row, iu) => row.map((pole, iv) => (iu === 3 && iv === 3 ? [pole[0], pole[1], 9] : pole)));
  const edited = await s.call("model_edit", { object, node: "node_0", op: { kind: "nurbsSurface", poles: raised } });
  const replay = opens.at(-1) as { current?: number; feature?: { poles?: number[][][] }; nodes?: { op?: { kind?: string } | null }[] } | undefined;
  const shownTree = () => (s as unknown as { find(id: string): { tree?: { current: number }; solid?: { editable: boolean; volumeMm3: number } } | undefined }).find(object);
  check(
    "model_edit on a surface root reopens it with the new grid and replays the thicken above it",
    thick.ok === true && edited.ok === true && replay?.feature?.poles?.[3]?.[3]?.[2] === 9 && (replay.nodes ?? []).some((row) => row.op?.kind === "thicken"),
    JSON.stringify({ thick: thick.ok, edited, pole: replay?.feature?.poles?.[3]?.[3], nodes: replay?.nodes?.map((row) => row.op?.kind ?? null) }).slice(0, 600),
  );
  // The real kernel run showed the edit left the part on its root, the bare sheet (volume 0), not on the thicken.
  check(
    "after a root edit the part is on the step it was on, rebuilt on the new root, and the reply says which and its volume",
    replay?.current === 1 && edited.current === "node_1" && shownTree()?.tree?.current === 1 && shownTree()?.solid?.editable === true
      && typeof edited.volumeMm3 === "number" && edited.volumeMm3 > 0 && edited.replayRefused === undefined,
    JSON.stringify({ sentAt: replay?.current, current: edited.current, volume: edited.volumeMm3, tree: shownTree()?.tree?.current }),
  );
  const folded = grid.map((row, iu) => row.map((pole, iv) => (iu === 3 && iv === 3 ? [pole[0], pole[1], 99] : pole)));
  const kept = await s.call("model_edit", { object, node: "node_0", op: { kind: "nurbsSurface", poles: folded } });
  check(
    "a root edit the later steps cannot follow is kept, shown at the root, with the reason",
    kept.ok === true && kept.current === "node_0" && shownTree()?.tree?.current === 0 && String(kept.replayRefused).includes("could not offset this surface") && String(kept.note).startsWith("The new first step is shown"),
    JSON.stringify(kept),
  );
  const notSurface = await s.call("model_edit", { object, node: "node_0", op: { kind: "fillet", edges: [0], size: 1 } });
  check("a root that is not a feature kind is refused in a sentence", notSurface.ok === false && String(notSurface.reason).startsWith("This part started from a sketch or a surface."), JSON.stringify(notSurface));
}

if (failed) {
  console.error(`nurbs-surface: ${failed} failed`);
  process.exit(1);
}
console.log("nurbs-surface: ok");
