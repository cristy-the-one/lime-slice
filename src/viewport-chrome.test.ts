import { bedForBox, fitSentence, formatOuter, liveBox, outerMm, printToScene, sceneToPrint } from "./viewport-chrome.ts";

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
eq("no solid keeps the edit base at the origin", bedForBox(bed, null), { x0: 0, y0: 0, x1: 220, y1: 220, z0: 0 });
eq("a corner box is centred on the edit base", bedForBox(bed, box), { x0: -100, y0: -100, x1: 120, y1: 120, z0: 0 });
eq("an origin-centred plate sits on its own base", bedForBox(bed, { min: [-110, -110, -2.55], max: [110, 110, 2.55] }), {
  x0: -110,
  y0: -110,
  x1: 110,
  y1: 110,
  z0: -2.55,
});

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("viewport-chrome: frames and fit sentence ok");
