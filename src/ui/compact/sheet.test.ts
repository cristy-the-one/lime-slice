import { sheetHeight, snapDetent } from "./sheet.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const height = 844;
check("exact peek snaps to peek", snapDetent(sheetHeight("peek", height), height) === "peek");
check("exact half snaps to half", snapDetent(sheetHeight("half", height), height) === "half");
check("exact full snaps to full", snapDetent(sheetHeight("full", height), height) === "full");
check("a drag just above the peek stays a peek", snapDetent(sheetHeight("peek", height) + 20, height) === "peek");
check("midway closer to half snaps to half", snapDetent((sheetHeight("peek", height) + sheetHeight("half", height)) / 2 + 1, height) === "half");
check("full is taller than half", sheetHeight("full", height) > sheetHeight("half", height));
check("half is taller than peek", sheetHeight("half", height) > sheetHeight("peek", height));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("sheet: detent snapping ok");
