/**
 * Refusals. Every tool that cannot do what it was asked answers `{ ok: false, reason, code }`: `reason` is the sentence
 * a person reads, `code` is a short stable kebab-case string from this registry that an agent can branch on, and
 * `next` (only where one obvious next call exists) names the call to try. The reason text is never the contract: a
 * client matches `code`. A code is documented here and in docs/mcp-server.md (a test keeps the two in step).
 */

export const REFUSAL_CODES = {
  "no-object": "The handle names no object on the plate.",
  "no-mesh": "The plate has no mesh or part to act on yet.",
  "plate-empty": "The plate holds no objects.",
  "no-assembly": "The part is in no assembly, or the named assembly does not exist.",
  "bad-placement": "The parts cannot be joined or placed that way (not on the plate, different assemblies, itself).",
  "nothing-to-undo": "The plate history has nothing to undo.",
  "nothing-to-redo": "The plate history has nothing to redo.",
  "single-shell": "The mesh is one shell, so there is nothing to split.",
  "arrange-needs-two": "Arrange needs at least two objects.",
  "not-sliced": "The call reads a slice and none has been made (or no tree-support slice).",
  "stale-slice": "The slice no longer matches the plate or its settings; slice again.",
  "slice-running": "A slice is already running; cancel it or wait for it.",
  "slice-failed": "The slicer ended with an error.",
  "slice-lost": "The slice job is gone (restart or unknown handle).",
  "cancelled": "The call or the wait was cancelled.",
  "job-running": "The tool is still running in the background as a job.",
  "job-failed": "The background job ended with an error.",
  "bad-clock": "The clock value is not a time.",
  "layer-missing": "The layer has no paths or is out of range.",
  "bad-view": "The view, colours, section or highlight of a render are not valid.",
  "bad-argument": "An argument has the wrong shape or value; the reason says what it takes.",
  "missing-argument": "A required argument is missing.",
  "conflicting-arguments": "Two arguments that exclude each other were both given.",
  "out-of-range": "A number is outside the range the tool takes.",
  "bad-action": "The action or kind is not one the tool knows.",
  "bad-expression": "A parameter or number expression does not evaluate.",
  "bad-name": "A name or id is not in the form the tool accepts.",
  "bad-frame": "The frame or workplane is wrong for this call.",
  "bad-region": "A region or volume is malformed or touches nothing.",
  "unknown-topic": "A guide topic or op kind is not known.",
  "model-unavailable": "The part has no editable Model solid (a mesh, or its history is not open).",
  "no-history": "The object has no Model history.",
  "solid-unreadable": "The solid or step solid could not be read back from the kernel.",
  "mesh-not-solid": "The call needs a B-rep solid and the part is a mesh.",
  "step-not-found": "The step handle is not in the history.",
  "step-kept": "The step cannot be dropped from the history.",
  "history-start": "The model history has nothing to undo or redo.",
  "commit-failed": "The part's open Model history could not be committed to the plate.",
  "step-guard": "A guard caught a step that removed too much of the solid or only touches an edge; the step was taken back.",
  "bad-op": "The op is malformed or cannot be baked into a step.",
  "bad-anchor": "An anchor label or reference does not resolve.",
  "not-probed": "The edit was not probed first; probe it, or pass probe: true.",
  "kernel-refused": "The modeling kernel refused the op; the reason is its plain-language error.",
  "does-not-fit": "The op does not fit the solid (a check failed).",
  "face-not-found": "The face is not on this solid.",
  "curved-face": "The face is curved, so it has no plane to use.",
  "needs-solid-tool": "The tool part has no solid yet.",
  "rebuild-refused": "The rebuild could not run (not built by model_build, base differs).",
  "build-failed": "A build or rebuild did not complete.",
  "export-failed": "The solid, assembly or pieces could not be exported.",
  "model-runaway": "The modeler stopped or did not answer; histories are rebuilt on next use.",
  "split-refused": "The split to print or coupon request cannot be planned or run.",
  "bad-coupon": "The calibration coupon request is not valid.",
  "wrong-kind": "The op kind is not the one this call takes.",
  "paint-limit": "The paint or reinforcement limit is reached.",
  "no-paint": "There is no paint inside the region.",
  "no-support": "No support tree is at that point.",
  "no-override": "The override is not on the plate.",
  "no-action": "There is no layer action at that height.",
  "outside-part": "The range or volume does not touch the part.",
  "bad-setting": "A setting key or value is not valid.",
  "nothing-changed": "No setting changed.",
  "no-printer": "No printer and filament are chosen.",
  "unknown-machine": "The printer or filament is not in the library.",
  "host-not-stored": "The server stores no printer host or key.",
  "bad-fits": "The measured-fit rows are not valid.",
  "bad-machine-file": "The machine file or settings text could not be read.",
  "bad-tower": "The calibration tower cannot be built that way.",
  "blend-failed": "The blend comparison did not run.",
  "no-blend": "No blend comparison has run yet.",
  "recipe-unavailable": "The lust compiler or the recipe crate is not installed here.",
  "recipe-compile": "The recipe did not build; the diagnostics say why.",
  "recipe-failed": "The recipe ran and failed, or a rebuild after it did.",
  "recipe-commit": "A recipe's result could not be committed to the plate.",
  "recipe-source": "The recipe source or data file is missing, too large or unreadable.",
  "plugin-not-found": "No plugin of that id is in the library or the project.",
  "plugin-invalid": "The plugin file does not parse, build or follow the rules.",
  "plugin-write-failed": "The plugin file could not be written, exported or read back.",
  "plugin-unsupported": "The plugin records a recipe API newer than this app's; nothing was built and its parts are kept.",
  "plugin-api-retired": "The plugin records a recipe API major this app no longer ships; nothing was built and its parts are kept.",
  "preset-not-found": "No preset of that name for the plugin.",
  "preset-invalid": "The preset is malformed or no longer fits the plugin.",
  "ingredient-not-found": "No ingredient of that name is kept.",
  "ingredient-invalid": "The ingredient is malformed or does not build alone.",
  "ingredient-write-failed": "The ingredient could not be written.",
  "lesson-not-found": "No lesson of that id.",
  "no-draft": "No run of that recipe is kept in this session.",
  "recipe-data-missing": "The recipe data file is not in the workspace.",
  "bad-path": "The path is outside the workspace or not a name the tool takes.",
  "file-not-found": "The file was not found.",
  "file-too-large": "The file or answer is over the size limit.",
  "project-unsaved": "Opening or creating would drop work that cannot be brought back.",
  "project-exists": "A project of that name is already in the workspace.",
  "project-changed": "The project changed on disk since it was opened.",
  "project-damaged": "The project file or a mesh in it is damaged.",
  "project-name": "No free project name is left in the workspace.",
  "no-study": "No study is set up; call sim_setup.",
  "bad-fixture": "A fixture (hold) is malformed.",
  "bad-load": "A load is malformed.",
  "bad-target": "A study target or constraint is malformed.",
  "bad-beam": "The beam size or build direction is not valid.",
  "no-card": "The material card is not in the library.",
  "bad-card": "The material card values are not valid.",
  "open-mesh": "The mesh is open, so it has no interior to mesh.",
  "solver-unavailable": "The stress solver is not built or not in this engine.",
  "solve-failed": "The stress solve did not finish.",
  "bad-sweep": "The sweep variants are not valid.",
  "bad-field-query": "The field query (points, box, face, stride) is not valid.",
  "no-load": "The study has no load or nothing is held.",
  "bad-representation": "The study representation or reslice option does not apply here.",
  "plan-cancelled": "The plan was cancelled before a step.",
  "plan-step-failed": "A step of the plan failed or was refused.",
  "plan-reference": "A step reference in the plan names nothing.",
  "app-refused": "The running app did not open the file.",
  "app-not-installed": "Lime Slice is not installed on this machine.",
  "app-not-started": "Lime Slice did not start.",
  "refused": "A refusal that no specific code covers; read the reason.",
} as const;

/** The next call to try, for the refusals that have one obvious. */
export const NEXT = {
  plate: "Call plate_list for the current handles.",
  mesh: "Call mesh_import to load a mesh, or solid_new to start a solid.",
  slice: "Call slice_start, then slice_wait.",
  probe: "Call model_probe with the same op, then apply it.",
  hist: "Call model_history for the step handles.",
  study: "Call sim_setup to set up a study.",
  blend: "Call blend_compare, then pass a point index.",
  printer: "Call machine_select to choose a printer and a filament.",
  guide: "Call guide for the topic list.",
  assembly: "Call model_place {to} to put the part in an assembly.",
  slicewait: "Call slice_wait with the job, or slice_cancel to stop it.",
  plugins: "Call nugget {action:\"find\", kind:\"plugin\"} to list the library.",
  ingredients: "Call nugget {action:\"find\", kind:\"ingredient\"} to list the library.",
  fix: "Fix the diagnostics and call recipe_run again.",
  faces: "Call faces_find to list the faces and their indexes.",
  empty: "Call mesh_import or solid_new first.",
} as const;

export type RefusalCode = keyof typeof REFUSAL_CODES;

/** A refusal reply: `ok: false`, the registry code, the sentence, any extra fields, and `next` when known. */
export type Refusal = { ok: false; code: RefusalCode; reason: string; next?: string } & Record<string, unknown>;

/**
 * `refuse(code, reason, extra?, next?)`. `extra` carries the call's own fields (`object`, `failedStep`, ...) beside
 * the refusal. It never overrides `ok`, `code`, `reason` or `next`.
 */
export function refuse(code: RefusalCode, reason: string, extra?: Record<string, unknown>, next?: string): Refusal {
  const { ok: _ok, code: _code, reason: _reason, next: _next, ...rest } = extra ?? {};
  return { ok: false, code, reason, ...rest, ...(next ? { next } : {}) } as Refusal;
}

/**
 * The safety net at the end of a call: a refusal that reached the reply with no code (a result passed through from the
 * engine, a recipe or a job) answers with the catch-all `refused`, so every `ok: false` reply carries a code. Nothing
 * else about the reply changes.
 */
export function withCode(value: Record<string, unknown>): Record<string, unknown> {
  if (value.ok !== false || typeof value.code === "string") return value;
  return { ...value, code: "refused" };
}
