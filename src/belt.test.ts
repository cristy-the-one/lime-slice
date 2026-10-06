import { beltAdvanceMm, beltStripLength, coerceBelt, defaultBelt, tiltPose } from "./belt.ts";
import { mockBeltSlice } from "./beltAdapter.mock.ts";

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

const cube = mockBeltSlice({
  bounds: { min: [0, 0, 0], max: [20, 20, 20] },
  layerHeight: 0.2,
  belt: defaultBelt(200),
  triangles: 12,
});
check("the mock emits no g-code", cube.gcode === "" && !JSON.stringify(cube).includes("G0") && !JSON.stringify(cube).includes("G1"));
check("the mock is marked", cube.beltMock === true && cube.blend === "Mock belt preview");
check("the mock has several layers", cube.layers.length >= 3 && cube.layers.length <= 28);
const mid = cube.layers[Math.floor(cube.layers.length / 2)];
const z = mid.paths.z.filter((value): value is number => typeof value === "number");
check("a mock layer is slanted", z.length >= 3 && Math.max(...z) - Math.min(...z) > 1);
check("the layer says it is a mock", cube.layers.every((layer) => layer.note.includes("Mock")));

const copies = mockBeltSlice({
  bounds: { min: [0, 0, 0], max: [20, 20, 20] },
  layerHeight: 0.2,
  belt: { ...defaultBelt(180), copies: 3, gapMm: 8, direction: -1 },
  triangles: 12,
});
check("copies are outlines, still with no g-code", copies.gcode === "" && copies.layers[0].paths.kind.length === 3);
check("copies extend the preview bounds", copies.mesh.min[1] < 0);

const messy = coerceBelt({ angleDeg: 0, axis: "nope", direction: -1, widthMm: -4, maxLengthMm: null, copies: 100, gapMm: -2 }, 220);
check(
  "a bad belt block is clamped",
  messy.angleDeg === 10 && messy.axis === "z" && messy.direction === -1 && messy.widthMm === 220 && messy.maxLengthMm === null && messy.copies === 24 && messy.gapMm === 5,
);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("belt: advance, strip, and mock preview ok");
