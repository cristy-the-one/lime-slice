import { readFileSync } from "node:fs";

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

const main = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
const quiet = readFileSync(new URL("../src-tauri/src/quiet_process.rs", import.meta.url), "utf8");
const kernel = readFileSync(new URL("../crates/lime-model-occt/cpp/kernel.cpp", import.meta.url), "utf8");

check("the release desktop binary does not open a console", main.includes('windows_subsystem = "windows"') && main.includes("not(debug_assertions)"));
check("a helper process is started with CREATE_NO_WINDOW", quiet.includes("CREATE_NO_WINDOW") && quiet.includes("0x0800_0000"));
check("Open CASCADE's console printer is replaced by a log file", kernel.includes("RemovePrinters") && kernel.includes("Message_PrinterOStream") && kernel.includes("lime-slice/occt.log"));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("windows-quiet: no console, no sidecar window, OCCT log ok");
