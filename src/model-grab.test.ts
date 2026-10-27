import { applyPose, IDENTITY_POSE, poseScale } from "./model-space.ts";
import { axisTurn, rayAtHeight, turnPoseAbout } from "./model-grab.ts";

let failed = 0;

function near(name: string, actual: readonly number[], expected: readonly number[], tol = 1e-9): void {
  const same = actual.length === expected.length && actual.every((v, i) => Math.abs(v - expected[i]!) <= tol);
  if (same) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

near("a ray looking straight down meets the plane under the eye", rayAtHeight([10, 20, 100], [0, 0, -1], 5)!, [10, 20, 5]);
near("a slanted ray carries along its slope", rayAtHeight([0, 0, 100], [1, 0, -1], 0)!, [100, 0, 0]);
eq("a level ray meets nothing a part could follow", rayAtHeight([0, 0, 10], [1, 0, 0], 0), null);
eq("a ray climbing away from the plane meets nothing", rayAtHeight([0, 0, 10], [0, 0, 1], 0), null);
eq("a nearly level ray is refused", rayAtHeight([0, 0, 10], [1, 0, -0.02], 0), null);

near("a quarter turn about Z takes X to Y", [axisTurn("z", 90)[0]!, axisTurn("z", 90)[3]!], [0, 1]);
near("a quarter turn about X takes Y to Z", [axisTurn("x", 90)[4]!, axisTurn("x", 90)[7]!], [0, 1]);
near("a quarter turn about Y takes Z to X", [axisTurn("y", 90)[8]!, axisTurn("y", 90)[2]!], [0, 1]);

const turned = turnPoseAbout(IDENTITY_POSE, [5, 0, 0], "z", 90);
near("a point at the centre stays put", applyPose(turned, [5, 0, 0]), [5, 0, 0]);
near("a point beside the centre swings about it", applyPose(turned, [8, 0, 0]), [5, 3, 0]);

const moved = { m: IDENTITY_POSE.m, t: [10, 0, 0] as [number, number, number] };
const again = turnPoseAbout(turnPoseAbout(moved, [12, 5, 3], "x", 30), [12, 5, 3], "x", -30);
near("turning back undoes the turn", [...again.m, ...again.t], [...moved.m, ...moved.t]);

const scaled = { m: [2, 0, 0, 0, 2, 0, 0, 0, 2] as const, t: [0, 0, 0] as [number, number, number] };
const scaledTurn = turnPoseAbout({ m: [...scaled.m] as never, t: scaled.t }, [0, 0, 0], "y", 40);
near("a turn keeps the scale folded into the pose", [poseScale(scaledTurn)], [2], 1e-9);

if (failed > 0) process.exit(1);
console.log("model-grab ok");
