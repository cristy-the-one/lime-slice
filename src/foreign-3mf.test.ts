import { encode3mf } from "./mesh-place.ts";
import { extractForeign3mfRecipe, foreign3mfMessage, foreignRecipeOffer, foreignSlicer3mf, zipEntryNames } from "./foreign-3mf.ts";

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

function storedZip(name: string, body: string, method = 0, data = new TextEncoder().encode(body)): Uint8Array {
  const named = new TextEncoder().encode(name);
  const local = new Uint8Array(30 + named.length + data.length);
  const view = new DataView(local.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(8, method, true);
  view.setUint32(18, data.length, true);
  view.setUint32(22, method === 0 ? data.length : body.length, true);
  view.setUint16(26, named.length, true);
  local.set(named, 30);
  local.set(data, 30 + named.length);
  return local;
}

const prusa = [
  "layer_height = 0.28",
  "perimeters = 4",
  "top_solid_layers = 6",
  "bottom_solid_layers = 5",
  "fill_density = 25%",
  "support_material = 1",
  "nozzle_temperature = 210",
  "bed_temperature = 60",
  "perimeter_speed = 45",
  "fill_pattern = gyroid",
].join("\n");

const prusaRecipe = await extractForeign3mfRecipe(storedZip("Metadata/Slic3r_PE.config", prusa));
check("a Prusa project keeps layer height, walls, infill, and supports", prusaRecipe?.layerHeightMm === 0.28 && prusaRecipe.walls === 4 && prusaRecipe.infill === 0.25 && prusaRecipe.supports === true);
check("shell counts are recognized", prusaRecipe?.topLayers === 6 && prusaRecipe.bottomLayers === 5);
check("the offer names only what Apply copies", foreignRecipeOffer(prusaRecipe!) === "Found PrusaSlicer print settings (0.28 mm layers, 4 walls, 25% infill, supports on).");
check("temperatures and speeds are not in the offer", !foreignRecipeOffer(prusaRecipe!)!.includes("210") && !foreignRecipeOffer(prusaRecipe!)!.includes("45"));

const orca = JSON.stringify({
  layer_height: "0.16",
  wall_loops: "3",
  sparse_infill_density: "15%",
  top_shell_layers: "4",
  bottom_shell_layers: "3",
  enable_support: "0",
  nozzle_temperature: "240",
  outer_wall_speed: "80",
  support_type: "tree(auto)",
});
const orcaRecipe = await extractForeign3mfRecipe(storedZip("Metadata/project_settings.config", orca));
check("an Orca project reads string values", orcaRecipe?.layerHeightMm === 0.16 && orcaRecipe.walls === 3 && orcaRecipe.infill === 0.15 && orcaRecipe.supports === false);
check(
  "Orca shell counts are recognized and not offered",
  orcaRecipe?.topLayers === 4 && orcaRecipe.bottomLayers === 3 && foreignRecipeOffer(orcaRecipe) === "Found Slicer print settings (0.16 mm layers, 3 walls, 15% infill, supports off).",
  foreignRecipeOffer(orcaRecipe!) ?? "",
);

const heatOnly = "nozzle_temperature = 210\nbed_temperature = 60\nperimeter_speed = 40\n";
const heatRecipe = await extractForeign3mfRecipe(storedZip("Metadata/Slic3r_PE.config", heatOnly));
check("temperatures and speeds alone are not a recipe", heatRecipe !== null && foreignRecipeOffer(heatRecipe) === null);

const wild = "layer_height = 0.8\nperimeters = 4\n";
const wildRecipe = await extractForeign3mfRecipe(storedZip("Metadata/Slic3r_PE.config", wild));
check("a layer height outside the field is left out", wildRecipe?.layerHeightMm === undefined && wildRecipe?.walls === 4);

const cura = JSON.stringify({ settings: { layer_height: { default_value: 0.2 }, wall_line_count: { default_value: 2 }, infill_sparse_density: { default_value: 20 }, support_enable: { default_value: false } } });
const curaRecipe = await extractForeign3mfRecipe(storedZip("Cura/printer.def.json", cura));
check("a Cura definition maps the same geometry", curaRecipe?.vendor === "Cura" && curaRecipe.walls === 2 && curaRecipe.infill === 0.2 && curaRecipe.supports === false);

const raw = new TextEncoder().encode("layer_height = 0.2\nperimeters = 2\nfill_density = 10%\n");
const compressed = new CompressionStream("deflate-raw");
const writer = compressed.writable.getWriter();
await writer.write(raw);
await writer.close();
const reader = compressed.readable.getReader();
const chunks: Uint8Array[] = [];
for (;;) {
  const step = await reader.read();
  if (step.done) break;
  chunks.push(step.value);
}
const packed = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
let at = 0;
for (const chunk of chunks) {
  packed.set(chunk, at);
  at += chunk.length;
}
const deflated = await extractForeign3mfRecipe(storedZip("Metadata/Slic3r_PE.config", "layer_height = 0.2\nperimeters = 2\nfill_density = 10%\n", 8, packed));
check("a deflated Prusa config still reads", deflated?.layerHeightMm === 0.2 && deflated.walls === 2 && deflated.infill === 0.1);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("foreign-3mf: vendor notes ok");
