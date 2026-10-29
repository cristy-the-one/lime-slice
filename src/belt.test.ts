import { beltAdvanceMm, beltArrowRun, beltRunTooLong, beltSliceField, beltStripLength, buildDirection, coerceBelt, defaultBelt, tiltPose } from "./belt.ts";
import { eulerOrient } from "./mesh-place.ts";
import { recipeKey } from "./slice-action.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function near(name: string, value: number, want: number, tol = 1e-6): void {
  check(name, Math.abs(value - want) < tol, `${value} vs ${want}`);
}

near("45° advance is layer height times √2", beltAdvanceMm(0.2, 45), 0.2 * Math.SQRT2);
near("30° advance is layer height over sin 30°", beltAdvanceMm(0.2, 30), 0.4);
near("a 35° step is not the cosine form", beltAdvanceMm(0.2, 35), 0.2 / Math.sin((35 * Math.PI) / 180));
check("35° sine and cosine disagree", Math.abs(Math.sin((35 * Math.PI) / 180) - Math.cos((35 * Math.PI) / 180)) > 0.05);

// Print Y runs along the belt and the belt carries the part toward +Y, so the plane's foot is at the front (Y = 0) and it leans toward the back.
const pose = tiltPose(200, 250, 45);
near("the tilted plane reaches the printable height", pose.y * 2, 250, 1e-6);
near("the plane's slope is height over sin 45°", pose.slopeMm, 250 * Math.SQRT2, 1e-6);
near("the plane's tilt is 45° short of upright, leaning away from the camera side", pose.rotationX, -Math.PI / 4, 1e-9);
near("the plane is centered across the belt", pose.x, 100, 1e-9);
near("the plane's middle is half the height up", pose.y, 125, 1e-9);
near("the plane's middle is half the run behind its foot at the front", pose.z, -125, 1e-9);
// Scene z is print −Y. A unit plane's local y turns to (cos, sin) in (scene y, scene z); the top edge is the middle plus half the slope along it.
const topY = pose.y + (pose.slopeMm / 2) * Math.cos(pose.rotationX);
const topZ = pose.z + (pose.slopeMm / 2) * Math.sin(pose.rotationX);
near("the top edge is at the printable height", topY, 250, 1e-9);
near("the top edge is 250 mm toward +Y, over the part the belt carries out", -topZ, 250, 1e-9);
check("a flatter plane leans further toward the back", tiltPose(200, 250, 30).z < pose.z);

const arrow = beltArrowRun(100, 124);
near("the belt arrow's tail is just before the part's front end", arrow.tailY, 90);
near("the belt arrow's head is past the part's back end, where it leaves", arrow.headY, 138);
near("the barbs sit behind the head by a quarter of the arrow", arrow.barbY, 126);
check("the head is at higher print Y than the tail", arrow.headY > arrow.tailY && arrow.headY > arrow.barbY);
near("a long part caps the barbs at 18 mm", beltArrowRun(0, 400).headY - beltArrowRun(0, 400).barbY, 18);

const open = beltStripLength(defaultBelt(200), 20);
check("an unlimited belt is a finite strip", open.unlimited && open.lengthMm >= 200 * 3);
const capped = beltStripLength({ ...defaultBelt(200), maxLengthMm: 300, copies: 2, gapMm: 10 }, 40);
check("a cap still fits the copies", capped.unlimited === false && capped.lengthMm >= 40 + 10 + 40);

const cartesian = { layerHeight: 0.2, printer: { nozzleDiameter: 0.4 } };
const plain = recipeKey(cartesian, "mesh");
check("a cartesian request gains no belt key", recipeKey({ ...cartesian, ...beltSliceField(null, false) }, "mesh") === plain);
const sent = beltSliceField(defaultBelt(200), false);
check("an unlimited belt omits maxLengthMm, the raft, and floor supports", !!sent.belt && !("maxLengthMm" in sent.belt) && !("raftLayers" in sent.belt) && !("floorSupports" in sent.belt) && sent.belt.angleDeg === 45 && sent.belt.axis === "z" && sent.belt.copies === 1);
check("no seam flag is ever sent: a blend seam is the belt edge", !("seamOnEdge" in (beltSliceField(defaultBelt(200), false).belt ?? {})));
const rafted = beltSliceField({ ...defaultBelt(200), raftLayers: 3 }, false);
check("raft layers are sent only when the pad is on", rafted.belt?.raftLayers === 3 && !("raftLayers" in (beltSliceField(defaultBelt(200), false).belt ?? {})));
const floored = beltSliceField(defaultBelt(200), true);
check("floor supports are sent only when supports are on", floored.belt?.floorSupports === true && !("floorSupports" in (beltSliceField(defaultBelt(200), false).belt ?? {})));
const stored = beltSliceField(coerceBelt({ floorSupports: true, seamOnEdge: true }, 200), false);
check("an old save's floor supports and seam flags are not read", !("floorSupports" in (stored.belt ?? {})) && !("seamOnEdge" in (stored.belt ?? {})));
const raftedSupports = beltSliceField({ ...defaultBelt(200), raftLayers: 3 }, true);
check("a raft and supports are never sent together", !("floorSupports" in (raftedSupports.belt ?? {})) && raftedSupports.belt?.raftLayers === 3);
check("a belt changes the recipe", recipeKey({ ...cartesian, ...sent }, "mesh") !== plain);
const sentCap = beltSliceField({ ...defaultBelt(180), maxLengthMm: 300, copies: 2, gapMm: 8, direction: -1, axis: "y" }, false);
check(
  "a capped belt is sent beside the printer",
  sentCap.belt?.maxLengthMm === 300 && sentCap.belt.copies === 2 && sentCap.belt.axis === "y" && sentCap.belt.direction === -1 && sentCap.belt.widthMm === 180,
);

const messy = coerceBelt({ angleDeg: 0, axis: "nope", direction: -1, widthMm: -4, maxLengthMm: null, copies: 100, gapMm: -2 }, 220);
check(
  "a bad belt block is clamped",
  messy.angleDeg === 10 && messy.axis === "z" && messy.direction === -1 && messy.widthMm === 220 && messy.maxLengthMm === null && messy.copies === 24 && messy.gapMm === 5 && messy.raftLayers === 0,
);
const rafty = coerceBelt({ raftLayers: 9.2 }, 220);
check("raft layers clamp to 1 through 8", rafty.raftLayers === 8 && coerceBelt({ raftLayers: 0 }, 220).raftLayers === 0 && coerceBelt({}, 220).raftLayers === 0);

check("the run an engine fit error reports is read", beltRunTooLong("belt.maxLengthMm 30 is shorter than the belt run of 56.57 mm") === 56.57);
check("the same run is read from the sentence the banner shows", beltRunTooLong("The belt's max length is 30 mm, shorter than this run of 56.57 mm") === 56.57);
check("an error about the width is not a length fix", beltRunTooLong("belt.widthMm 10 is narrower than the part, which is 20.00 mm across the belt") === null);
check("another message is not a length fix", beltRunTooLong("walls 0 is outside 1 to 12") === null);

// --- Print transitions. The build direction is locked to the engine's `mirror_rotate_x` (belt.rs), copied here as it is:
// a plate point (x, y, z) goes to (x, −y cos α − z sin α, −y sin α + z cos α), and its new z is its layer height.
function layerHeight(q: readonly number[], angleDeg: number): number {
  const a = (angleDeg * Math.PI) / 180;
  return -q[1]! * Math.sin(a) + q[2]! * Math.cos(a);
}
const placed = (m: readonly number[], p: readonly number[]) => [0, 1, 2].map((r) => m[3 * r]! * p[0]! + m[3 * r + 1]! * p[1]! + m[3 * r + 2]! * p[2]!);
const dot3 = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
check("on the IR3 V2 as built, layers stack toward −Y and up", JSON.stringify(buildDirection([1, 0, 0, 0, 1, 0, 0, 0, 1], { angleDeg: 45 }).map((v) => Math.round(v * 1e6) / 1e6)) === JSON.stringify([0, -0.707107, 0.707107]));
check("a flat bed builds along the plate's up", JSON.stringify(buildDirection(eulerOrient(90, 0, 0), null).map((v) => Math.round(v * 1e6) / 1e6 + 0)) === JSON.stringify([0, 1, 0]));
let lockedRows = 0;
for (const [rx, ry, rz] of [[0, 0, 0], [90, 0, 0], [0, 0, 90], [30, -45, 120], [180, 20, -60]] as const) {
  for (const angleDeg of [30, 45, 60]) {
    const orient = eulerOrient(rx, ry, rz);
    const b = buildDirection(orient, { angleDeg });
    const [p, q] = [[3, -7, 11], [-5, 2, 4]];
    const engine = layerHeight(placed(orient, q), angleDeg) - layerHeight(placed(orient, p), angleDeg);
    if (Math.abs(engine - dot3(b, [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!])) < 1e-9) lockedRows += 1;
  }
}
check("the build direction is the engine's layer height in the part's frame, for every turn and belt angle", lockedRows === 15, String(lockedRows));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("belt: advance, strip, and slice field ok");
