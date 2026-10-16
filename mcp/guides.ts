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
    tools: ["mesh_import", "paint_supports", "paint_list", "slice_start", "slice_wait"],
    text: [
      "Paint supports under an overhang, then slice.",
      "1. mesh_import {path}. The ledge sample is samples/overhang_ledge.stl.",
      "2. paint_supports {region:{overhangBelowDeg:50}, radiusMm:3, mode:\"enforce\"}. Disks match a hand brush. A box that misses the part is refused.",
      "3. paint_list to read the disks. paint_seam and reinforce_add use the same region.",
      "4. settings_set {values:{supports:true}} when the warning says supports are off.",
      "5. slice_start, then slice_wait. The slice body carries the disks.",
      "6. support_trees, then support_edit {action:\"prune\", site:{xy, zMm}, scope:\"tree\"}, then slice again.",
    ].join("\n"),
  },
  {
    uri: "lime://guide/calibrate",
    name: "Calibrate",
    tools: ["machine_select", "calibration_tower", "calibration_apply", "blend_compare", "blend_apply"],
    text: [
      "Calibrate pressure advance for the selected filament.",
      "1. machine_select {printerId, filamentId}. The tower uses that firmware.",
      "2. calibration_tower {kind:\"pa\", start:0, end:0.06, step:0.01}. More than 40 bands is refused. A tower taller than the bed is refused.",
      "3. Read the bands. calibration_apply {kind:\"pa\", value} saves it on the filament.",
      "4. blend_compare, then blend_apply {index}, then slice_start.",
      "Nothing is sent to a printer.",
    ].join("\n"),
  },
];

export function guideByUri(uri: string): Guide | undefined {
  return GUIDES.find((guide) => guide.uri === uri);
}
