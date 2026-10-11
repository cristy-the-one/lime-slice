import { FRAME_FACTOR, frameFactor } from "./frame-fit.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const desktop = frameFactor(20, 40, { width: 1000, height: 700 });
check("a tall prepare view keeps the existing distance", desktop === FRAME_FACTOR, String(desktop));
check("a large solid uses the same factor", frameFactor(180, 40, { width: 1000, height: 700 }) === FRAME_FACTOR);

const narrow = frameFactor(20, 40, { width: 160, height: 400 });
check("a narrow canvas backs up", narrow > FRAME_FACTOR, String(narrow));
const phone = frameFactor(40, 40, { width: 390, height: 720 });
check("a phone-width canvas backs up past the gizmo", phone > FRAME_FACTOR, String(phone));
check("the distance never gets closer than the existing flight", frameFactor(8, 40, { width: 2000, height: 1200 }) === FRAME_FACTOR);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("frame-fit: distance only grows ok");
