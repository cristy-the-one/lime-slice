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

GUIDES.push(
  {
    uri: "lime://guide/ops",
    name: "Model ops",
    tools: ["solid_new", "faces_find", "model_apply", "model_history", "model_commit"],
    text: [
      "Every Model edit, by kind. Numbers are mm and degrees, in the part frame unless workplane_set set a frame.",
      "solid_new {primitive:\"box\", dx:60, dy:40, dz:35} stands the solid centred on X and Y on Z = 0 and returns its bounds.",
      "boolean: {kind:\"boolean\", op:\"cut\"|\"fuse\"|\"common\", primitive, ...sizes, origin | centre, turn}.",
      "  box: dx, dy, dz; origin is its min corner before turning. cylinder, cone, tube: radius, height along local Z; origin is the base centre.",
      "  centre is the point it turns about (a box's middle, halfway up an axis), so a turned shape is easiest placed by centre.",
      "  turn is degrees about X, then Y, then Z. A cylinder lying along Y: turn [90, 0, 0]. A 45 degree roof prism along X: box turn [45, 0, 0].",
      "  Example roof: {kind:\"boolean\", op:\"fuse\", primitive:\"box\", centre:[0, 0, 35], dx:60, dy:33.94, dz:33.94, turn:[45, 0, 0]}.",
      "extrude: {kind:\"extrude\", op:\"fuse\"|\"cut\"|\"common\", profile:[[u, v], ...], depth, symmetric} on the workplane, or on face/faceIndex with from:\"corner\" for U, V = 0 at its min corner.",
      "  A gable roof with eaves is one extrude: {kind:\"extrude\", op:\"fuse\", face:{normal:[1, 0, 0]}, from:\"corner\", profile:[[-4, 31], [44, 31], [20, 55]], depth:-60}.",
      "revolve: {kind:\"revolve\", op, profile, axisOrigin:[u, v], axisDir:[u, v], angleDeg} about an in-plane axis (default V through 0, 0).",
      "shell: {kind:\"shell\", thickness, openFaces:[index | {normal, nearPoint}]} hollows the solid; no open face is a closed void.",
      "hole: {kind:\"hole\", diameterMm, through:true | depth, at:{u, v}} on the workplane, or screw:\"M3\".",
      "fillet, chamfer: {edges:[index] | {select:{direction, onFace, convex}} | {fromNode:\"roof\", filter:\"convex\"}, size}. fromNode takes the edges a step made, found again after edits.",
      "split: {origin, normal, keep}. scale: {factor}.",
      "pocket: {kind:\"pocket\", faceIndex, shape:\"rect\"|\"circle\"|\"arch\", at:{u, v}, width, height | diameter, depth, bars:{vertical, horizontal, width}}.",
      "  On a wall or a roof slope U is level and V runs up the face. A window: {kind:\"pocket\", faceIndex:2, at:{u:18, v:2.5}, width:10, height:10, depth:1.5, bars:{vertical:1, horizontal:1}}.",
      "  face:{normal, nearPoint} picks the flat face instead of faceIndex: the nearest match, else the largest. Use it in model_build, where indexes are not known yet.",
      "boss: like pocket, raised by depth. A sill: {kind:\"boss\", faceIndex:2, at:{u:18, v:-3.25}, width:12, height:1.5, depth:2}.",
      "texture: {kind:\"texture\", faceIndex, pattern:\"lines\"|\"grid\"|\"brick\"|\"shingle\", pitch:[7.5, 5.7], grooveWidth:0.8, depth:0.6}. Roof tiles are one texture per slope.",
      "pattern: {kind:\"pattern\", op:{...}, linear:{step:[x, y, z], count, step2, count2} | polar:{count, axis, centre, angleDeg}}. count includes the original.",
      "mirror: {kind:\"mirror\", op:{...}, plane:\"x\"|\"y\"|\"z\", origin}. It keeps the original unless keepOriginal is false.",
      "Any op takes label. model_goto, model_edit, model_drop, and model_rename take a label in place of node_N.",
      "Composite ops (pocket, boss, texture, pattern, mirror) are checked step by step by model_apply, rolled back on a refusal, and undone as one step.",
      "A plain op needs model_probe first, or model_apply {op, probe:true}. Then model_history to read the steps, and model_commit to put the solid on the plate.",
    ].join("\n"),
  },
  {
    uri: "lime://guide/compose",
    name: "Compose",
    tools: ["model_params", "model_build", "model_apply_batch", "model_undo", "render_view", "project_save"],
    text: [
      "A whole part in a few calls.",
      "1. model_params {set:{wallW:60, wallD:40, wallH:35}}. A value may be text using earlier names: {roof:\"wallD / sqrt(2) + 4\"}.",
      "2. model_build {base:{primitive:\"box\", dx:\"wallW\", dy:\"wallD\", dz:\"wallH\"}, ops:[...], name}. Every op is checked, then applied, in order.",
      "   A refusal names the op by index and puts the solid back. onError:\"stop\" keeps what applied instead. It commits unless commit is false.",
      "3. model_apply_batch {object, ops:[...], label} adds more. The batch is one undo step: model_undo takes it all back.",
      "4. render_view to look, then project_save {name, ifExists:\"refuse\"} so an existing file is not replaced.",
      "Numbers may be text wherever an op takes a number, e.g. origin:[0, 0, \"wallH\"]. model_params values stay for the session only.",
    ].join("\n"),
  },
);

export function guideByUri(uri: string): Guide | undefined {
  return GUIDES.find((guide) => guide.uri === uri);
}
