import { steppedRadius } from "./brush-radius.ts";

let failed = 0;

function eq(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}`);
}

eq("one step up", steppedRadius(3, 0.5, 0.5, 20, 0.5), 3.5);
eq("one step down", steppedRadius(3, -0.5, 0.5, 20, 0.5), 2.5);
eq("the max holds", steppedRadius(20, 0.5, 0.5, 20, 0.5), 20);
eq("the min holds", steppedRadius(0.5, -0.5, 0.5, 20, 0.5), 0.5);

if (failed) throw new Error(`${failed} brush-radius check(s) failed`);
console.log("brush-radius: ok");
