/**
 * Organic surfaces S4: a part a plugin made whose kernel reply is an open sheet goes on the plate marked, as one made
 * in Model is. This is the path `addMadeObjects` (src/app/model/plugin-panel.ts) takes for each made part: the reply
 * decoded, the mesh carrying `meshSheet`'s verdict, the part added with `addedSolid`, then `markSheet` with that verdict.
 * The window's own modules need a Worker and localStorage; both are stubbed, nothing is sent.
 */
import { register } from "node:module";

register(new URL("../../model-view/resolve-ts.mjs", import.meta.url).href, import.meta.url);
(globalThis as { Worker?: unknown }).Worker = class {
  postMessage() {}
  addEventListener() {}
  terminate() {}
};
const stored = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
  removeItem: (key: string) => void stored.delete(key),
};

const { state } = await import("../state.ts");
const { markSheet, meshSheet } = await import("./sheet-gate.ts");
const { addedSolid } = await import("../../plate.ts");
const { decodeSolid, encodeSolid } = await import("../../model-reply.ts");
const { sheetPartNote } = await import("../../model-sheet.ts");

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

/** A plugin's made part as the kernel answers it: an open sheet (no closed solid, three open borders), or a closed one. */
function reply(sheet: boolean): Record<string, unknown> {
  return encodeSolid({
    volumeMm3: sheet ? 0 : 1000,
    solid: !sheet,
    positions: [0, 0, 0, 10, 0, 0, 0, 10, 0],
    triangles: [0],
    faces: [{ areaMm2: 50, normal: [0, 0, 1] }],
    edges: [
      { lengthMm: 10, points: [0, 0, 0, 10, 0, 0] },
      { lengthMm: 14.14, points: [10, 0, 0, 0, 10, 0] },
      { lengthMm: 10, points: [0, 10, 0, 0, 0, 0] },
    ],
    ...(sheet ? { nakedEdges: [0, 1, 2] } : {}),
  } as never) as unknown as Record<string, unknown>;
}

const identity = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] } as never;
for (const [id, sheet] of [["made-lid", true], ["made-box", false]] as const) {
  const solid = decodeSolid(reply(sheet));
  if (typeof solid === "string") {
    check(`${id}: the reply decodes`, false, solid);
    continue;
  }
  const positions = new Float32Array(solid.positions);
  const mesh = { name: `${id}.stl`, bytes: new ArrayBuffer(84), sourcePos: positions, token: id, ...meshSheet(solid) };
  state.plate = addedSolid(state.plate, { name: id, fileName: `${id}.stl`, bytes: mesh.bytes, sourcePos: positions, stepTolerance: 0.01 } as never, id, `${id}#tree`, identity, 220, 220);
  markSheet(id, mesh.sheet);
}

const lid = state.plate.objects.find((obj) => obj.id === "made-lid");
const box = state.plate.objects.find((obj) => obj.id === "made-box");
check("a plugin part whose kernel reply is an open sheet is marked on the plate", lid?.sheet === true, JSON.stringify(lid?.sheet));
check("a plugin part whose reply is a closed solid is not", box !== undefined && box.sheet === undefined, JSON.stringify(box?.sheet));
check("and Slice and Export stop on the marked one", sheetPartNote(state.plate.objects) === "made-lid is an open sheet, not a solid. Thicken or Cap & Sew it in Model before slicing or exporting.", String(sheetPartNote(state.plate.objects)));

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("plugin-made sheet: marked on the plate");
