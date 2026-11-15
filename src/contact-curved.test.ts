/**
 * Contact on curved faces (docs/plan-contact-poses.md section 6). A kernel mesh of a round face is a set of facets with
 * their corners on the true face, so on a convex face every facet lies inside it, by up to the chord tolerance. Here a
 * faceted cylinder, meshed to a known chord, meets a flat arm and another faceted cylinder, where the true contact angle
 * is known in closed form for every pose:
 *
 * - the mesh pass's answer is late: the true solids overlap there, by up to the chord (the bound), never more;
 * - the answer with the chord margin is never inside the true surface, and short of it by at most the chords and the
 *   tolerance;
 * - the kernel's answer (`kernelContact`, with an exact measure standing in for the kernel) agrees to the tolerance;
 * - flat faces keep the mesh pass's answer, and a box is never taken for a curved face.
 */
import { chordOffsets, curvedTriangles, firstContact, kernelContact, KERNEL_CALLS, meshGap, type ContactAnswer, type ContactPart, type KernelVerdict } from "./contact.ts";
import { type Assembly, type Member } from "./assembly.ts";
import { IDENTITY_POSE } from "./model-space.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail === "" ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Float32Array {
  const c = (x: number, y: number, z: number) => [x ? x1 : x0, y ? y1 : y0, z ? z1 : z0];
  const quads = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  const out: number[] = [];
  for (const q of quads) for (const i of [0, 1, 2, 0, 2, 3]) out.push(...q[i]!);
  return new Float32Array(out);
}

/** A closed cylinder about z through (cx, cy), corners on the true circle, `segments` facets from angle `phase`. */
function cylinder(cx: number, cy: number, r: number, z0: number, z1: number, segments: number, phase: number): Float32Array {
  const rim = (j: number): [number, number] => [cx + r * Math.cos(phase + (2 * Math.PI * j) / segments), cy + r * Math.sin(phase + (2 * Math.PI * j) / segments)];
  const out: number[] = [];
  for (let j = 0; j < segments; j += 1) {
    const [ax, ay] = rim(j), [bx, by] = rim(j + 1);
    out.push(ax, ay, z0, bx, by, z0, bx, by, z1, ax, ay, z0, bx, by, z1, ax, ay, z1);
    out.push(cx, cy, z1, ax, ay, z1, bx, by, z1);
    out.push(cx, cy, z0, bx, by, z0, ax, ay, z0);
  }
  return new Float32Array(out);
}

/** The facets the kernel would make for a chord of `chord` mm: the fewest whose sagitta is within it. */
const segmentsFor = (r: number, chord: number) => Math.ceil(Math.PI / Math.acos(1 - chord / r));
const sagitta = (r: number, segments: number) => r * (1 - Math.cos(Math.PI / segments));
const rad = Math.PI / 180;
const hinge = (): Member["joint"] => ({ kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1], angle: 0 });
const poseOf = (id: string) => (id === "frame" ? IDENTITY_POSE : undefined);
const frame = box(-40, -40, -10, 40, 40, -5);
const CHORD = 0.05;
const TOL = 0.01;

// --- Which triangles are on curved faces.
{
  check("a box has no curved facet", curvedTriangles(box(0, 0, 0, 3, 4, 5)).every((flag) => flag === 0));
  check("a box at a chord keeps no margin", chordOffsets({ object: "b", positions: box(0, 0, 0, 3, 4, 5), chordMm: CHORD }) === null);
  const pin = cylinder(0, 0, 3, 0, 5, 18, 0);
  check("every facet of a cylinder is on its round face or shares a corner with it", curvedTriangles(pin).every((flag) => flag === 1));
  check("a mesh that is the part keeps no margin", chordOffsets({ object: "p", positions: pin }) === null);
  // A box beside a cylinder in one mesh: the box stays flat.
  const both = new Float32Array([...box(10, 0, 0, 13, 4, 5), ...pin]);
  const flags = curvedTriangles(both);
  check("a box beside a cylinder in one mesh stays flat", flags.slice(0, 12).every((flag) => flag === 0) && flags.slice(12).every((flag) => flag === 1));
  // meshGap: the margin is the distance less the chord on curved facets.
  const g = meshGap({ positions: box(0, -1, 0, 20, 1, 5), pose: IDENTITY_POSE }, { positions: cylinder(10, 6, 3, 0, 5, 18, Math.PI / 2), pose: IDENTITY_POSE }, null, chordOffsets({ object: "p", positions: cylinder(10, 6, 3, 0, 5, 18, Math.PI / 2), chordMm: CHORD }));
  check("meshGap: a vertex of the pin 2 mm over the arm's face", Math.abs(g.mm - 2) < 1e-6 && g.boundMm === CHORD && Math.abs(g.marginMm - (2 - CHORD)) < 1e-6, g);
}

// --- A flat arm turned onto a round pin. The arm [0, 20] x [-1, 1] turns about z; its face y = 1 meets a pin of radius
// R at C when C, in the arm's frame, stands 1 + R above the axis: |C| cos(theta + atan2(cx, cy)) = 1 + R.
{
  const R = 3, C: [number, number] = [12, 6];
  const truth = Math.acos((1 + R) / Math.hypot(C[0], C[1])) - Math.atan2(C[0], C[1]);
  /** The true gap between the arm's face and the round pin at theta, mm (negative: they overlap). */
  const gap = (theta: number) => C[1] * Math.cos(theta) - C[0] * Math.sin(theta) - 1 - R;
  const segments = segmentsFor(R, CHORD), sag = sagitta(R, segments);
  let worstLate = 0, worstShort = 0, worstNew = Infinity, kernelWorst = 0, kernelCalls = 0;
  const arm = box(0, -1, 0, 20, 1, 5);
  for (let k = 0; k < 8; k += 1) {
    const phase = (k / 8) * ((2 * Math.PI) / segments);
    const pin = cylinder(0, 0, R, 0, 5, segments, phase);
    const rig: Assembly = { id: "asm_c", name: "Pin", members: [
      { object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
      { object: "arm", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: hinge() },
      { object: "pin", parent: "frame", offset: [C[0], C[1], 0], turn: [0, 0, 0] },
    ] };
    const parts: ContactPart[] = [{ object: "arm", positions: arm, chordMm: CHORD }, { object: "pin", positions: pin, chordMm: CHORD }, { object: "frame", positions: frame, chordMm: CHORD }];
    const found = firstContact(rig, poseOf, parts, { object: "arm", dir: 1, against: "pin", toleranceMm: TOL });
    if ("reason" in found || !found.contact) { check(`phase ${k}: contact`, false, found); continue; }
    const meshAt = (found.mesh?.value ?? found.value) * rad, at = found.value * rad;
    // The mesh pass alone: never more than the facets' sagitta inside the pin, and the tolerance short of the facets.
    worstLate = Math.max(worstLate, -gap(meshAt));
    check(`phase ${k}: the mesh pass is inside the true pin by at most its sagitta`, -gap(meshAt) <= sag + 1e-6, { gap: gap(meshAt), sag });
    // The answer: never inside the true pin, and short by at most the chord and the tolerance (with the speed margin).
    worstNew = Math.min(worstNew, gap(at));
    worstShort = Math.max(worstShort, gap(at));
    check(`phase ${k}: the answer is never inside the true pin`, gap(at) >= -1e-9, { gap: gap(at), value: found.value, truth: truth / rad });
    check(`phase ${k}: and short of it by at most the chord and the tolerance`, gap(at) <= CHORD + TOL * 1.1 + 1e-6, { gap: gap(at) });
    check(`phase ${k}: the bound is the pin's chord`, Math.abs(found.boundMm! - CHORD) < 1e-12, found.boundMm);
    check(`phase ${k}: the same question gives the same answer, to the bit`, (firstContact(rig, poseOf, parts, { object: "arm", dir: 1, against: "pin", toleranceMm: TOL }) as ContactAnswer).value === found.value);
    // The kernel's answer, with the true gap standing in for its common volume.
    const measure = async (value: number): Promise<KernelVerdict> => {
      const g = gap(value * rad);
      return g > 0 ? { verdict: "clear", volumeMm3: 0 } : g > -1e-4 ? { verdict: "touch", volumeMm3: 0.001 } : { verdict: "crossing", volumeMm3: -g * 10 };
    };
    const exact = await kernelContact(found, measure);
    if ("reason" in exact) { check(`phase ${k}: the kernel answers`, false, exact); continue; }
    kernelCalls = Math.max(kernelCalls, exact.calls);
    kernelWorst = Math.max(kernelWorst, gap(exact.value * rad));
    check(`phase ${k}: the kernel's answer is clear or a touch`, exact.reached && gap(exact.value * rad) >= -1e-4 && exact.at.verdict !== "crossing", exact);
    check(`phase ${k}: within the tolerance of the true contact`, gap(exact.value * rad) <= TOL * 1.1 + 1e-6, { gap: gap(exact.value * rad) });
    check(`phase ${k}: never past the mesh pass's answer`, exact.value <= exact.meshValue && Math.abs(exact.backedOff - (exact.meshValue - exact.value)) < 1e-12, exact);
    check(`phase ${k}: within the budget`, exact.calls <= KERNEL_CALLS, exact.calls);
  }
  check("the mesh pass alone is late by close to the sagitta at the worst phase", worstLate >= 0.8 * sag, { worstLate, sag });
  console.log(`contact-curved: arm on a pin r ${R}, ${segments} facets (sagitta ${sag.toFixed(4)} mm, chord ${CHORD}): mesh pass up to ${worstLate.toFixed(4)} mm inside; with the margin ${worstNew.toFixed(4)} to ${worstShort.toFixed(4)} mm clear; kernel ${kernelWorst.toFixed(4)} mm, ${kernelCalls} checks at most`);
}

// --- A round pin on a wheel turned onto a fixed round pin: both faceted. The moving centre is at L (cos t, sin t), the
// fixed one at C; they touch when the centres are r1 + r2 apart.
{
  const L = 10, r1 = 2, r2 = 2, alpha = 30 * rad, C: [number, number] = [10 * Math.cos(alpha), 10 * Math.sin(alpha)];
  const gap = (theta: number) => Math.hypot(L * Math.cos(theta) - C[0], L * Math.sin(theta) - C[1]) - r1 - r2;
  const n1 = segmentsFor(r1, CHORD), n2 = segmentsFor(r2, CHORD);
  const bound = sagitta(r1, n1) + sagitta(r2, n2);
  let worstLate = 0;
  for (let k = 0; k < 6; k += 1) {
    const rig: Assembly = { id: "asm_d", name: "Pins", members: [
      { object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
      { object: "wheel", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: hinge() },
      { object: "post", parent: "frame", offset: [C[0], C[1], 0], turn: [0, 0, 0] },
    ] };
    const parts: ContactPart[] = [
      { object: "wheel", positions: cylinder(L, 0, r1, 0, 5, n1, (k / 6) * ((2 * Math.PI) / n1)), chordMm: CHORD },
      { object: "post", positions: cylinder(0, 0, r2, 0, 5, n2, (k / 6) * 0.7 * ((2 * Math.PI) / n2)), chordMm: CHORD },
      { object: "frame", positions: frame, chordMm: CHORD },
    ];
    const found = firstContact(rig, poseOf, parts, { object: "wheel", dir: 1, against: "post", toleranceMm: TOL });
    if ("reason" in found || !found.contact) { check(`pins ${k}: contact`, false, found); continue; }
    const meshAt = (found.mesh?.value ?? found.value) * rad;
    worstLate = Math.max(worstLate, -gap(meshAt));
    check(`pins ${k}: the mesh pass is inside by at most both sagittas`, -gap(meshAt) <= bound + 1e-6, { gap: gap(meshAt), bound });
    check(`pins ${k}: the answer is never inside the true pins`, gap(found.value * rad) >= -1e-9, { gap: gap(found.value * rad) });
    check(`pins ${k}: and short by at most both chords and the tolerance`, gap(found.value * rad) <= 2 * CHORD + TOL * 1.1 + 1e-6, { gap: gap(found.value * rad) });
    check(`pins ${k}: the bound is both chords`, Math.abs(found.boundMm! - 2 * CHORD) < 1e-12, found.boundMm);
  }
  console.log(`contact-curved: pin on pin r ${r1} and ${r2}: mesh pass up to ${worstLate.toFixed(4)} mm inside (both sagittas ${bound.toFixed(4)} mm)`);
}

// --- Flat faces: the answer is the mesh pass's, with nothing to back off, and the kernel takes one check.
{
  const rig: Assembly = { id: "asm_f", name: "Flat", members: [
    { object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
    { object: "arm", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: hinge() },
    { object: "stop", parent: "frame", offset: [12, 5, 0], turn: [0, 0, 0] },
  ] };
  const parts: ContactPart[] = [{ object: "arm", positions: box(0, -1, 0, 20, 1, 5), chordMm: CHORD }, { object: "stop", positions: box(0, 0, 0, 2, 2, 5), chordMm: CHORD }, { object: "frame", positions: frame, chordMm: CHORD }];
  const found = firstContact(rig, poseOf, parts, { object: "arm", dir: 1, against: "stop" }) as ContactAnswer;
  check("flat: no margin, no second answer", found.contact && found.boundMm === 0 && found.mesh === undefined, found);
  check("flat: the same angle as before the margin existed", found.value === 15.785264957581548, found.value);
  const exact = await kernelContact(found, async () => ({ verdict: "clear", volumeMm3: 0 }));
  check("flat: the kernel agrees in one check and nothing moves", !("reason" in exact) && exact.value === found.value && exact.calls === 1 && exact.backedOff === 0, exact);
  const never = await kernelContact(found, async () => ({ verdict: "crossing", volumeMm3: 1 }), 4);
  check("a kernel that never agrees: the budget ends it, and says so", !("reason" in never) && !never.reached && never.calls === 4 && never.value === found.value, never);
}

if (failed) {
  console.error(`contact-curved: ${failed} failed`);
  process.exit(1);
}
console.log("contact-curved: ok");
