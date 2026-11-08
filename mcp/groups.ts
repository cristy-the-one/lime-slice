/**
 * Tool groups, on by default; LIME_MCP_TOOL_GROUPS=0 lists every tool. tools/list sends the core tools (what the slice
 * guide and a first look need) and tools_enable; tools_enable {groups} adds a group and the server sends
 * notifications/tools/list_changed. A call to a tool of a closed group opens the group and runs, so a client that does
 * not re-read the list can still reach it (directly, or through plan_run).
 *
 * model_place (assemblies, joints, pose and reach) and model_export_step (one STEP, posed assemblies included) are core:
 * posing and saving the pose need no Model edit, and a client that never re-reads the list could not call them by name.
 */

export const TOOL_GROUPS: Record<string, { holds: string; tools: string[] }> = {
  model: {
    holds: "solids and Model edits: solid_new, faces and edges, workplane, probe, apply, batch, build, recipes, history, commit, measure",
    tools: [
      "solid_new", "model_describe", "faces_find", "edges_find", "workplane_set", "workplane_print_up", "assembly_merge", "model_probe",
      "surface_at", "section", "model_check", "model_apply", "model_apply_batch", "model_build", "recipe_run", "nugget", "model_define", "model_anchors", "model_params",
      "model_history", "model_goto", "model_undo", "model_redo", "model_edit", "model_rename", "model_drop", "model_commit",
      "measure",
    ],
  },
  paint: { holds: "support, seam, and reinforcement paint", tools: ["paint_supports", "paint_seam", "reinforce_add", "paint_list", "paint_clear"] },
  supports: { holds: "the sliced support trees: read, prune, and grow", tools: ["support_trees", "support_edit"] },
  plate: {
    holds: "more plate work: duplicate, arrange, split shells, print order, height ranges, modifiers, overrides",
    tools: ["object_duplicate", "plate_arrange", "object_split_shells", "plate_print_order", "range_add", "modifier_add", "overrides_list", "override_remove"],
  },
  layers: {
    holds: "the sliced layers and G-code in detail, and layer actions",
    tools: ["layer_summary", "layer_detail", "layer_paths", "layer_image", "gcode_read", "layer_action_set", "layer_actions_list", "layer_action_remove"],
  },
  calibration: { holds: "calibration towers and blends", tools: ["calibration_tower", "calibration_apply", "blend_compare", "blend_apply"] },
  machines: { holds: "printer and filament records: load, read, set, save, profiles", tools: ["machine_load", "machine_get", "machine_set", "machine_save", "profile_save"] },
  stress: { holds: "stress studies: set up, solve, read a field, sweep variants", tools: ["sim_setup", "sim_run", "sim_field", "sim_sweep", "sim_cancel"] },
};

export const GROUP_NAMES = Object.keys(TOOL_GROUPS);

/** Characters of schemas tools_enable returns in one reply; a whole group is several times this. */
export const SCHEMAS_REPLY_CAP = 12_000;

const GROUP_OF = new Map<string, string>(Object.entries(TOOL_GROUPS).flatMap(([group, row]) => row.tools.map((tool) => [tool, group] as const)));

/** The group a tool is in, or null for a core tool. */
export function groupOf(tool: string): string | null {
  return GROUP_OF.get(tool) ?? null;
}

/** Whether this server starts with only the core tools listed: always, unless LIME_MCP_TOOL_GROUPS=0. */
export function groupsOptedIn(): boolean {
  return process.env.LIME_MCP_TOOL_GROUPS !== "0";
}

/** Short names of what each group holds, so the opener's description says which group a tool is in. */
const GROUP_TOOLS_SHORT: Record<string, string> = {
  model: "solid_new, model_apply/probe/build/commit, faces_find, edges_find, section, measure, recipe_run, nugget, model history",
  paint: "paint_supports, paint_seam, reinforce_add, paint_list, paint_clear",
  supports: "support_trees, support_edit",
  plate: "object_duplicate, plate_arrange, object_split_shells, plate_print_order, range_add, modifier_add, overrides",
  layers: "layer_summary/detail/paths/image, gcode_read, layer actions",
  calibration: "calibration_tower/apply, blend_compare/apply",
  machines: "machine_load/get/set/save, profile_save",
  stress: "sim_setup/run/field/sweep/cancel",
};

export const TOOLS_ENABLE_HELP = `Open tool groups; the tool list then changes. Calling a tool of a closed group opens it too. Groups: ${Object.keys(TOOL_GROUPS).map((group) => `${group} (${GROUP_TOOLS_SHORT[group]})`).join("; ")}. schemas:true returns the opened tools' schemas; tools narrows them.`;
