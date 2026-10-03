import { encode3mf } from "./mesh-place.ts";
import { foreign3mfMessage, foreignSlicer3mf, zipEntryNames } from "./foreign-3mf.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function zipNamed(name: string): Uint8Array {
  const named = new TextEncoder().encode(name);
  const local = new Uint8Array(30 + named.length);
  const view = new DataView(local.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(26, named.length, true);
  local.set(named, 30);
  return local;
}

const mesh = encode3mf(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
check("our own 3MF is mesh only", foreignSlicer3mf(mesh) === null);
check("our own 3MF still has the model part", zipEntryNames(mesh).includes("3D/3dmodel.model"));

check("Prusa settings are named", foreignSlicer3mf(zipNamed("Metadata/Slic3r_PE_model.config")) === "PrusaSlicer");
check("Orca settings are named", foreignSlicer3mf(zipNamed("Metadata/OrcaSlicer_model.config")) === "OrcaSlicer");
check("a settings config without a vendor name stays generic", foreignSlicer3mf(zipNamed("Metadata/project_settings.config")) === "slicer");
check("a Bambu entry is Bambu Studio", foreignSlicer3mf(zipNamed("Metadata/BambuStudio.config")) === "Bambu Studio");
check("a Cura folder is Cura", foreignSlicer3mf(zipNamed("Cura/printer.def.json")) === "Cura");
check("a plain model name is not a slicer", foreignSlicer3mf(zipNamed("3D/3dmodel.model")) === null);
check(
  "the toast says settings were not imported",
  foreign3mfMessage("PrusaSlicer") === "Opened the mesh only. PrusaSlicer settings in this 3MF were not imported.",
);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("foreign-3mf: vendor notes ok");
