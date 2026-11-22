import { hexToThree } from "./theme.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const hex = (n: number) => `0x${n.toString(16).padStart(6, "0")}`;

// Vite 8's CSS minifier (Lightning CSS) writes --gizmo-hot: #ffffff as #fff. Read as 0x0fff, the white section
// arrow turned blue, so the short form has to read as the long one.
check("#fff is white, not 0x000fff", hexToThree("#fff") === 0xffffff, hex(hexToThree("#fff")));
check("#ffffff is white", hexToThree("#ffffff") === 0xffffff, hex(hexToThree("#ffffff")));
check("#f80 is 0xff8800", hexToThree("#f80") === 0xff8800, hex(hexToThree("#f80")));
check("a color read from CSS with a space is the same", hexToThree(" #2a9d8f") === 0x2a9d8f, hex(hexToThree(" #2a9d8f")));
check("#2a9d8f80 drops its alpha", hexToThree("#2a9d8f80") === 0x2a9d8f, hex(hexToThree("#2a9d8f80")));
check("not a color is black", hexToThree("") === 0 && hexToThree("teal") === 0, `${hexToThree("")} ${hexToThree("teal")}`);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("theme.test.ts ok");
