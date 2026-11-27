/**
 * Smooth shading for a plate object that has a solid but no normals yet: a project just opened (the normals are not
 * saved), a STEP import, a part a commit made before this kernel. One stateless kernel call (`meshStep` on the solid
 * the object already stores, asked as the view asks) brings the exact normals of that solid's plate mesh, and
 * src/plate-shading.ts carries them onto the object's own plate mesh by place.
 *
 * The answer reaches nothing but the shading table, keyed by the plate mesh array the call was made for. The plate,
 * its mesh, fingerprint, undo history and slice state are never touched, so a late answer cannot race an edit or a
 * selection: an edit makes a new array, which this answer does not name. One call runs at a time, and each array is
 * asked once.
 */
import { bytesToBase64Async } from "../base64";
import { DISPLAY_MESH_FIELD } from "../model-mesh-quality";
import { decodeSolid } from "../model-reply";
import type { PlateObject } from "../plate";
import { giveShading, hasShadeSource, reachFor } from "../plate-shading";
import { treeCall } from "./step-solids";

const asked = new WeakSet<Float32Array>();
const queue: { positions: Float32Array; brep: ArrayBuffer; chordMm: number }[] = [];
let running = false;
let done = 0;

/** Ask once for the normals of each object here that has a solid and is not shaded yet. */
export function warmShading(objects: readonly PlateObject[]): void {
  for (const obj of objects) {
    const positions = obj.sourcePos;
    if (!obj.brep || obj.brep.byteLength === 0 || positions.length < 9 || asked.has(positions) || hasShadeSource(positions)) continue;
    asked.add(positions);
    queue.push({ positions, brep: obj.brep, chordMm: obj.stepTolerance });
  }
  if (!running && queue.length > 0) void drain();
}

async function drain() {
  running = true;
  try {
    for (let job = queue.shift(); job; job = queue.shift()) {
      if (hasShadeSource(job.positions)) continue;
      await shadeOne(job).catch(() => undefined);
      done += 1;
      // For a test to wait on: how many solids were asked for their normals.
      document.body?.setAttribute("data-plate-shading-asked", String(done));
    }
  } finally {
    running = false;
  }
}

async function shadeOne(job: { positions: Float32Array; brep: ArrayBuffer; chordMm: number }) {
  // The kernel meshes STEP from 0.01 to 2 mm.
  const chordMm = Math.min(2, Math.max(0.01, Number.isFinite(job.chordMm) ? job.chordMm : 0.1));
  const dataB64 = await bytesToBase64Async(new Uint8Array(job.brep));
  const reply = await treeCall({ call: "meshStep", dataB64, chordMm, [DISPLAY_MESH_FIELD[0]]: DISPLAY_MESH_FIELD[1] });
  if (typeof reply.error === "string") return;
  const solid = decodeSolid(reply);
  if (typeof solid === "string" || !solid.plateNormals) return;
  giveShading(job.positions, { positions: solid.positions, normals: solid.plateNormals, reachMm: reachFor(chordMm) });
}
