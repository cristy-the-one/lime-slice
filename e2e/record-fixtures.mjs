import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "e2e/fixtures");
const api = process.env.LIME_API ?? "http://127.0.0.1:43118";

const printer = {
  name: "Generic Marlin 0.4 mm PLA",
  nozzleDiameter: 0.4,
  filamentDiameter: 1.75,
  nozzleTemp: 200,
  bedTemp: 60,
  bedX: 220,
  bedY: 220,
  maxVolumetricMm3S: 12,
  filamentDensityGCm3: 1.24,
  pressureAdvance: 0,
  linearAdvance: 0,
};

function payload(name, blend) {
  const bytes = fs.readFileSync(path.join(root, "samples", name));
  return {
    filename: name,
    dataB64: bytes.toString("base64"),
    layerHeight: 0.2,
    lineWidth: 0.45,
    blend,
    adaptive: false,
    supports: false,
    infillCombine: true,
    combing: true,
    featureSpeeds: true,
    printer,
    variableWidth: true,
    arcFit: true,
    travelOpt: true,
    overhangControl: true,
    scarfSeam: "blend",
    scarfLength: 10,
    scarfSteps: 8,
    scarfStartHeight: 0.15,
    scarfStartFlow: 0.55,
    gyroid3d: "blend",
    zHop: "blend",
    zHopHeight: 0.4,
    zHopMinTravel: 2,
    baseline: false,
    compare: true,
  };
}

async function slice(name, blend) {
  const res = await fetch(`${api}/api/slice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload(name, blend)),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `${name} failed`);
  body.gcode = `; fixture keeps estimates and preview; gcode body omitted (${body.gcode?.length ?? 0} chars)\n`;
  return body;
}

fs.mkdirSync(outDir, { recursive: true });
const cube = await slice("calibration_cube_20mm.stl", { mode: "single", strategy: "speed" });
fs.writeFileSync(path.join(outDir, "cube-speed.json"), JSON.stringify(cube));
const hull = await slice("lime_hull.stl", { mode: "single", strategy: "speed" });
fs.writeFileSync(path.join(outDir, "hull-speed.json"), JSON.stringify(hull));
console.log("cube", cube.estimate.seconds, cube.estimate.filamentG, "layers", cube.layers.length);
console.log("hull", hull.estimate.seconds, hull.estimate.filamentG, "layers", hull.layers.length);
console.log("compare", cube.compare.map((row) => `${row.label}:${row.seconds.toFixed(1)}s/${row.filamentG.toFixed(2)}g`).join(" "));
