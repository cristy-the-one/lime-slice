import { fitSentence, formatOuter, liveBox, outerMm, printToScene, sceneToPrint } from "./viewport-chrome.ts";

let failed = 0;

function eq(name: string, actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${left}`);
}

const box = { min: [0, 0, 0] as [number, number, number], max: [20, 20, 10] as [number, number, number] };
const bed = { x: 220, y: 220, z: 250 };

eq("Y-up print Z is scene Y", printToScene("y-up", 10, 20, 30), [10, 30, -20]);
eq("Z-up print stays put", printToScene("z-up", 10, 20, 30), [10, 20, 30]);
eq("Y-up scene returns to print", sceneToPrint("y-up", 10, 30, -20), [10, 20, 30]);
eq("Z-up scene returns to print", sceneToPrint("z-up", 10, 20, 30), [10, 20, 30]);
eq("the bed plane is Z = 0", printToScene("z-up", 10, 20, 0)[2], 0);
eq("a scale of 2 grows about the centre", liveBox(box, 2), { min: [-10, -10, -5], max: [30, 30, 15] });
eq("a scale of 1 leaves the box", liveBox(box, 1), box);
eq("outer size is width, depth, height", outerMm(box), { w: 20, d: 20, h: 10 });
eq("a fitting solid names only its size", fitSentence(outerMm(box), bed), { text: "20.0 × 20.0 × 10.0 mm", over: false });
eq("a tall solid names the build volume", fitSentence({ w: 20, d: 20, h: 260 }, bed), {
  text: "20.0 × 20.0 × 260.0 mm. Past the 220 × 220 × 250 mm build volume in height.",
  over: true,
});
eq("two oversize axes are both named", fitSentence({ w: 300, d: 20, h: 260 }, bed).text, "300.0 × 20.0 × 260.0 mm. Past the 220 × 220 × 250 mm build volume in width and height.");
eq("the callout format keeps one decimal", formatOuter({ w: 20, d: 20.04, h: 10 }), "20.0 × 20.0 × 10.0 mm");

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("viewport-chrome: frames and fit sentence ok");
