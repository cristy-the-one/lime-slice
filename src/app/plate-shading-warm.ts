/**
 * Smooth shading for a plate object that has a solid but no normals yet: a project just opened (the normals are not
 * saved), a STEP file added, a part a commit made before this kernel. One stateless kernel call (`meshStep` on the solid
 * the object already stores, asked as the view asks) brings the exact normals of that solid's plate mesh, and
 * src/plate-shading.ts carries them onto the object's own plate mesh by place.
 *
 * The answer reaches nothing but the shading table, keyed by the plate mesh array the call was made for. The plate,
 * its mesh, fingerprint, undo history and slice state are never touched, so a late answer cannot race an edit or a
 * selection: an edit makes a new array, which this answer does not name.
 *
 * It is a drawing nicety, so it costs the person nothing they would notice:
 * - It meshes the solid again, and the kernel serves one call at a time, with no priority: a Model call made while it
 *   runs waits for it. So a solid past the budget below is never asked (it is drawn flat, as before), and the call
 *   starts only when the app is idle, in Prepare or Pose, a while after the last input. Model draws its own mesh, and
 *   nothing is asked while it is open.
 * - Each mesh is asked once a session: by its mesh token, which every copy of it shares (a duplicate, an undo's copy),
 *   whether the answer came, failed or was skipped.
 *
 * The budget, from the release engine on one Windows machine (meshStep with the normals, then the carry-over; a Model
 * open issued just behind it waited about as long): the duck plate STEP (518 kB, 9,710 triangles) 0.19 s; plates with
 * 1 mm holes, 150 holes (234 kB, 16,212 triangles) 0.30 s, 200 holes (311 kB, 21,612) 0.92 s, 300 holes (468 kB,
 * 32,412) 1.37 s, 1,000 holes (1.6 MB, 108,012) 5.6 s. The time grows faster than the triangles, so the line is drawn
 * at 18,000 triangles, where the wait stays under about half a second, and at 1 MB of solid (it is sent whole, as
 * base64). A part past either is drawn flat, as before, and never asked.
 */
import { bytesToBase64Async } from "../base64";
import { DISPLAY_MESH_FIELD } from "../model-mesh-quality";
import { decodeSolid } from "../model-reply";
import { meshTokenOf, type PlateObject } from "../plate";
import { giveShading, hasShadeSource, reachFor } from "../plate-shading";
import { isStepName } from "./settings";
import { state } from "./state";
import { treeCall } from "./step-solids";

/** Past this many plate-mesh triangles a part is drawn flat, as before: meshing it again would hold the kernel too long. */
export const SHADE_MAX_TRIANGLES = 18_000;
/** Past this many bytes of solid likewise: they are sent to the kernel whole. */
export const SHADE_MAX_BYTES = 1_000_000;
/** How long the person must have left the app alone before a call starts. */
const QUIET_MS = 1500;

type Job = { token: string; positions: Float32Array; solid: ArrayBuffer; chordMm: number };

/** Mesh tokens asked, skipped or answered: a token is never asked twice in a session. */
const asked = new Set<string>();
const queue: Job[] = [];
let running = false;
let scheduled = false;
let lastInput = 0;
let done = 0;
let skipped = 0;

if (typeof window !== "undefined") {
  const note = () => {
    lastInput = performance.now();
  };
  for (const kind of ["pointerdown", "keydown", "wheel"]) window.addEventListener(kind, note, { capture: true, passive: true });
}

/** Ask once, when the app is idle, for the normals of each object here that has a solid within the budget. */
export function warmShading(objects: readonly PlateObject[]): void {
  for (const obj of objects) {
    const positions = obj.sourcePos;
    // The solid Model saved for it, or, for a STEP file added as it is, that file.
    const solid = obj.brep && obj.brep.byteLength > 0 ? obj.brep : isStepName(obj.fileName) ? obj.bytes : undefined;
    if (!solid || solid.byteLength === 0 || positions.length < 9) continue;
    const token = meshTokenOf(obj.bytes);
    if (asked.has(token) || hasShadeSource(positions)) continue;
    asked.add(token);
    if (positions.length / 9 > SHADE_MAX_TRIANGLES || solid.byteLength > SHADE_MAX_BYTES) {
      skipped += 1;
      publish();
      continue;
    }
    queue.push({ token, positions, solid, chordMm: obj.stepTolerance });
  }
  schedule();
}

/** One job when the app is next idle: in Prepare or Pose, no input for a while, the page in view. */
function schedule() {
  if (running || scheduled || queue.length === 0) return;
  scheduled = true;
  const later = (fn: () => void, ms: number) => {
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    window.setTimeout(() => (idle ? idle(fn, { timeout: 2000 }) : fn()), ms);
  };
  const tryNow = () => {
    const quietFor = performance.now() - lastInput;
    const shown = state.stage === "prepare" || state.stage === "pose";
    if (!shown || document.hidden || quietFor < QUIET_MS) {
      later(tryNow, Math.max(250, QUIET_MS - quietFor));
      return;
    }
    scheduled = false;
    void runOne();
  };
  later(tryNow, QUIET_MS);
}

async function runOne() {
  const job = queue.shift();
  if (!job) return;
  running = true;
  try {
    if (!hasShadeSource(job.positions)) await shadeOne(job).catch(() => undefined);
    done += 1;
    publish();
  } finally {
    running = false;
    schedule();
  }
}

/** For a test to wait on: how many solids were asked for their normals, and how many were past the budget. */
function publish() {
  document.body?.setAttribute("data-plate-shading-asked", String(done));
  document.body?.setAttribute("data-plate-shading-skipped", String(skipped));
}

async function shadeOne(job: Job) {
  // The kernel meshes STEP from 0.01 to 2 mm.
  const chordMm = Math.min(2, Math.max(0.01, Number.isFinite(job.chordMm) ? job.chordMm : 0.1));
  const dataB64 = await bytesToBase64Async(new Uint8Array(job.solid));
  const reply = await treeCall({ call: "meshStep", dataB64, chordMm, [DISPLAY_MESH_FIELD[0]]: DISPLAY_MESH_FIELD[1] });
  if (typeof reply.error === "string") return;
  const solid = decodeSolid(reply);
  if (typeof solid === "string" || !solid.plateNormals) return;
  giveShading(job.positions, { positions: solid.positions, normals: solid.plateNormals, reachMm: reachFor(chordMm) });
}
