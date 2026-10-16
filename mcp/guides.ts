/**
 * Worked sequences. The prompts quote these, and a test checks the order,
 * so a tool rename cannot leave the prompt naming a field that is gone.
 */
export interface Guide {
  uri: string;
  name: string;
  tools: string[];
  text: string;
}

export const GUIDES: Guide[] = [
  {
    uri: "lime://guide/slice",
    name: "Slice",
    tools: ["mesh_import", "machine_list", "machine_select", "settings_set", "slice_start", "slice_wait", "gcode_summary", "gcode_export"],
    text: [
      "Slice one part.",
      "1. mesh_import {path}. The handle comes back as object.",
      "2. machine_list, then machine_select {printerId, filamentId}.",
      "3. settings_schema {query} to read a key, then settings_set {values}. Layer height is millimetres, 0.08 to 0.4.",
      "4. slice_start. It slices the selected object, or the whole plate when more than one object is on it.",
      "5. slice_wait {job} until status is done. Call it again while status is running.",
      "6. gcode_summary, then gcode_export {name} to write a file in the workspace.",
      "Nothing is sent to a printer.",
    ].join("\n"),
  },
  {
    uri: "lime://guide/model",
    name: "Model",
    tools: ["solid_new", "faces_find", "edges_find", "workplane_set", "model_probe", "model_apply", "model_commit", "slice_start"],
    text: [
      "A hole on a face, then a slice.",
      "1. solid_new or mesh_import a STEP file. A mesh has no solid.",
      "2. faces_find {object, normal:[0,0,1]}. Centres are part-frame millimetres.",
      "3. edges_find {object, direction:[0,0,1]} when the next edit is a fillet.",
      "4. workplane_set {object, faceIndex} with the face you picked.",
      "5. model_probe {op:{kind:\"hole\", diameterMm, through:true, at:{u:0, v:0}}}. u and v are on the workplane.",
      "6. model_apply the same op only when the probe is ok.",
      "7. model_commit, then slice_start. A commit replaces the plate mesh.",
    ].join("\n"),
  },
  {
    uri: "lime://guide/paint",
    name: "Paint",
    tools: ["mesh_import", "slice_start"],
    text: [
      "Support paint, seam paint, and reinforcement are stored on the object and sent with the slice.",
      "Open a project that already has them, or wait for paint_supports. A slice names anything it cannot send yet.",
      "Disks are in the part frame. The bed frame is the printer's X, Y, and Z.",
    ].join("\n"),
  },
  {
    uri: "lime://guide/calibrate",
    name: "Calibrate",
    tools: ["machine_select", "settings_schema"],
    text: [
      "Calibration towers are not a tool yet.",
      "machine_select picks the filament. settings_schema {query:\"pressure\"} shows the pressure-advance key.",
      "settings_set writes that key. Nothing is sent to a printer.",
    ].join("\n"),
  },
];

export function guideByUri(uri: string): Guide | undefined {
  return GUIDES.find((guide) => guide.uri === uri);
}
