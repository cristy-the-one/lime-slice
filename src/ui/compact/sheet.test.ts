import { moveDetent, sheetHeight, snapDetent } from "./sheet.ts";

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
check("arrow up grows peek to half", moveDetent("peek", "ArrowUp") === "half");
check("arrow up from half opens full", moveDetent("half", "ArrowUp") === "full");
check("arrow up from full stays full", moveDetent("full", "ArrowUp") === "full");
check("arrow down shrinks half to peek", moveDetent("half", "ArrowDown") === "peek");
check("arrow down from peek stays peek", moveDetent("peek", "ArrowDown") === "peek");
check("home opens the sheet", moveDetent("peek", "Home") === "full");
check("end peeks the sheet", moveDetent("full", "End") === "peek");
check("other keys are ignored", moveDetent("half", "Enter") == null);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("sheet: detent snapping ok");
