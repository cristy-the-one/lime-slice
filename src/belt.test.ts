import { beltAdvanceMm, beltSliceField, beltStripLength, coerceBelt, defaultBelt, tiltPose } from "./belt.ts";
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

const pose = tiltPose(200, 250, 45);
near("the tilted plane reaches the printable height", pose.y * 2, 250, 1e-6);
check("the plane leans off horizontal", pose.rotationX > -Math.PI / 2 && pose.rotationX < 0);

const open = beltStripLength(defaultBelt(200), 20);
check("an unlimited belt is a finite strip", open.unlimited && open.lengthMm >= 200 * 3);
const capped = beltStripLength({ ...defaultBelt(200), maxLengthMm: 300, copies: 2, gapMm: 10 }, 40);
check("a cap still fits the copies", capped.unlimited === false && capped.lengthMm >= 40 + 10 + 40);

const cartesian = { layerHeight: 0.2, printer: { nozzleDiameter: 0.4 } };
const plain = recipeKey(cartesian, "mesh");
check("a cartesian request gains no belt key", recipeKey({ ...cartesian, ...beltSliceField(null) }, "mesh") === plain);
const sent = beltSliceField(defaultBelt(200));
check("an unlimited belt omits maxLengthMm", !!sent.belt && !("maxLengthMm" in sent.belt) && sent.belt.angleDeg === 45 && sent.belt.axis === "z" && sent.belt.copies === 1);
check("a belt changes the recipe", recipeKey({ ...cartesian, ...sent }, "mesh") !== plain);
const sentCap = beltSliceField({ ...defaultBelt(180), maxLengthMm: 300, copies: 2, gapMm: 8, direction: -1, axis: "y" });
check(
  "a capped belt is sent beside the printer",
  sentCap.belt?.maxLengthMm === 300 && sentCap.belt.copies === 2 && sentCap.belt.axis === "y" && sentCap.belt.direction === -1 && sentCap.belt.widthMm === 180,
);

const messy = coerceBelt({ angleDeg: 0, axis: "nope", direction: -1, widthMm: -4, maxLengthMm: null, copies: 100, gapMm: -2 }, 220);
check(
  "a bad belt block is clamped",
  messy.angleDeg === 10 && messy.axis === "z" && messy.direction === -1 && messy.widthMm === 220 && messy.maxLengthMm === null && messy.copies === 24 && messy.gapMm === 5,
);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("belt: advance, strip, and slice field ok");
