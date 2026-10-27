/**
 * A rotate gesture on the Prepare gizmo: the pose the user holds, the rest pose it settles to when Settle is on,
 * and the contact patch drawn on the bed meanwhile. The part always sits on the bed, held or settled.
 */
import { contactAt, downInSource, hullOf, restPose } from "../bed-rest";
import { settleOn } from "../bed-rest-pref";
import { applyRigidPose, type Mat3 } from "../mesh-place";
import { fx } from "./fx";
import { state } from "./state";

/** What the user holds, and the pose it settled to. While `shown` is still the part's pose, `free` is the held one. */
let held: { free: Mat3; shown: Mat3 } | null = null;
let contactText = "";
const warmed = new WeakSet<Float32Array>();

const same = (a: Mat3, b: Mat3) => a.every((v, i) => v === b[i]);

/** The pose the user holds. A settled part is held where it was turned to, so a one degree nudge can leave its rest pose. */
export function heldOrient(): Mat3 {
  return held && same(held.shown, state.orient) ? held.free : state.orient;
}

/** The text for the readout that sits over the bed during a rotate gesture, or an empty string. */
export function contactReadout(): string {
  return contactText;
}

/** Build the hull of a freshly loaded mesh when the app is idle, so the first turn does not wait for it. */
export function warmHull(source: Float32Array | null) {
  if (!source || warmed.has(source)) return;
  warmed.add(source);
  window.setTimeout(() => hullOf(source), 400);
}

/** Turn the part to `free` and, with Settle on, to the rest pose nearest it. Returns the pose the part now has. */
export function turnTo(free: Mat3): Mat3 {
  const source = state.sourcePos;
  const hull = source ? hullOf(source) : null;
  const rest = hull && settleOn() ? restPose(hull, free, state.partScale) : null;
  state.orient = rest ? rest.orient : free;
  held = rest?.snapped ? { free, shown: rest.orient } : null;
  fx.applyPlace(false);
  paintContact();
  return state.orient;
}

/** The contact the part makes with the bed now, as a patch on the bed and the readout's text. */
function paintContact() {
  const source = state.sourcePos;
  const hull = source ? hullOf(source) : null;
  const placed = state.placed;
  if (!hull || !placed) {
    contactText = "";
    fx.prepare.setContact(null);
    return;
  }
  const scale = state.partScale;
  const found = contactAt(hull, downInSource(state.orient), scale, true);
  contactText = `Contact ${Math.round(found.areaMm2)} mm²`;
  const patch = found.patch ?? [];
  const [cx, cy, cz] = hull.centre;
  const canonical = new Float32Array(patch.length);
  for (let i = 0; i < patch.length; i += 3) {
    canonical[i] = cx + (patch[i]! - cx) * scale;
    canonical[i + 1] = cy + (patch[i + 1]! - cy) * scale;
    canonical[i + 2] = cz + (patch[i + 2]! - cz) * scale;
  }
  const onBed = applyRigidPose(canonical, placed.pose);
  const lift = placed.bounds.min[2] + 0.05;
  for (let i = 2; i < onBed.length; i += 3) onBed[i] = lift;
  fx.prepare.setContact(onBed.length ? onBed : null);
}

/** The gesture is over: the patch and the readout go, and the part keeps the pose it has. */
export function endTurn() {
  contactText = "";
  fx.prepare.setContact(null);
}
