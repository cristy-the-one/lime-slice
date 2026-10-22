/**
 * Tool groups, opt-in with LIME_MCP_TOOL_GROUPS=1. tools/list then sends the core tools (what the slice guide and a
 * first look need) and tools_enable; tools_enable {groups} adds a group and the server sends
 * notifications/tools/list_changed. Without the variable every tool is listed, as before.
 */

export const TOOL_GROUPS: Record<string, { holds: string; tools: string[] }> = {
  model: {
    holds: "solids and Model edits: solid_new, faces and edges, workplane, probe, apply, batch, build, history, commit, STEP export, measure",
    tools: [
      "solid_new", "model_describe", "faces_find", "edges_find", "workplane_set", "workplane_print_up", "model_place", "model_probe",
      "surface_at", "model_check", "model_apply", "model_apply_batch", "model_build", "model_define", "model_anchors", "model_params",
      "model_history", "model_goto", "model_undo", "model_redo", "model_edit", "model_rename", "model_drop", "model_commit",
      "model_export_step", "measure",
    ],
  },
  paint: { holds: "support, seam, and reinforcement paint", tools: ["paint_supports", "paint_seam", "reinforce_add", "paint_list", "paint_clear"] },
  supports: { holds: "the sliced support trees: read and prune", tools: ["support_trees", "support_edit"] },
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

const GROUP_OF = new Map<string, string>(Object.entries(TOOL_GROUPS).flatMap(([group, row]) => row.tools.map((tool) => [tool, group] as const)));

/** The group a tool is in, or null for a core tool. */
export function groupOf(tool: string): string | null {
  return GROUP_OF.get(tool) ?? null;
}

/** Whether this server starts with only the core tools listed. */
export function groupsOptedIn(): boolean {
  return process.env.LIME_MCP_TOOL_GROUPS === "1";
}

export const TOOLS_ENABLE_HELP = `Add tool groups to the tool list; the server then sends tools/list_changed. Groups: ${Object.entries(TOOL_GROUPS).map(([group, row]) => `${group} (${row.holds})`).join("; ")}.`;
