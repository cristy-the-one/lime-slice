import { readSeamPaint, seamRequestFields, type SeamDisk } from "./seam-paint.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const frame = { centre: [0, 0, 0] as [number, number, number], scale: 1 };
const dab: SeamDisk = { p: [1, 2, 3], n: [0, 0, 1], r: 3 };
check("an empty seam list is omitted", !("seamPaint" in seamRequestFields([], frame)));
const sent = seamRequestFields([dab], frame);
check("a dab is sent in the mesh frame", sent.seamPaint?.length === 1 && sent.seamPaint[0]?.r === 3 && sent.seamPaint[0]?.p[0] === 1);
check("a missing project list is empty", Array.isArray(readSeamPaint(undefined)) && (readSeamPaint(undefined) as SeamDisk[]).length === 0);
check("a damaged project list is refused", readSeamPaint([{ p: [0, 0, 0] }]) === "The seam paint in this project is damaged.");
check("a project list round-trips", JSON.stringify(readSeamPaint([dab])) === JSON.stringify([dab]));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("seam paint: request field and project read ok");
