import { readFileSync } from "node:fs";

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

const main = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
const quiet = readFileSync(new URL("../src-tauri/src/quiet_process.rs", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src-tauri/src/bridge.rs", import.meta.url), "utf8");
const engine = readFileSync(new URL("../crates/lime-mcp-engine/src/lib.rs", import.meta.url), "utf8");
const kernel = readFileSync(new URL("../crates/lime-model-occt/cpp/kernel.cpp", import.meta.url), "utf8");
const shell = readFileSync(new URL("../crates/lime-shell/src/win.rs", import.meta.url), "utf8");
const hooks = readFileSync(new URL("../src-tauri/windows/shell-hooks.nsh", import.meta.url), "utf8");

check("the release desktop binary does not open a console", main.includes('windows_subsystem = "windows"') && main.includes("not(debug_assertions)"));
check("a helper process is started with CREATE_NO_WINDOW", quiet.includes("CREATE_NO_WINDOW") && quiet.includes("0x0800_0000"));
check("the live bridge does not spawn a process or a console", !bridge.includes("std::process") && !bridge.includes("CREATE_NEW_CONSOLE") && bridge.includes("Ipv4Addr::LOCALHOST") && !bridge.includes("0.0.0.0"));
check("the in-process engine does not spawn a console", !engine.includes("std::process") && !engine.includes("CREATE_NEW_CONSOLE"));
check("Open CASCADE's console printer is replaced by a log file", kernel.includes("RemovePrinters") && kernel.includes("Message_PrinterOStream") && kernel.includes("lime-slice/occt.log"));
check("the shell handler does not open a console", !shell.includes("AllocConsole") && !shell.includes("println!") && !shell.includes("CREATE_NEW_CONSOLE"));
check(
  "the installer hook does not launch the self-test or regsvr32",
  hooks.includes("NSIS_HOOK_POSTINSTALL") &&
    hooks.includes("NSIS_HOOK_POSTUNINSTALL") &&
    hooks.includes("SHCTX") &&
    hooks.includes("{A344EC17-8764-5F01-9C73-FFE2DA751916}") &&
    hooks.includes("$INSTDIR\\lime_shell.dll") &&
    !hooks.includes("regsvr32") &&
    !hooks.includes("self-test") &&
    !/^\s*Exec/m.test(hooks) &&
    !hooks.includes("nsExec"),
);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("windows-quiet: no console, no sidecar window, OCCT log ok");
