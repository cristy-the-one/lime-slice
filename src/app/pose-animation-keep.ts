/**
 * Keep in library… (docs/plan-animation-plugins.md A5): an animation played in Pose, kept as a `kind: animation`
 * plugin in the person's library, so it plays on any assembly. Its parameters come from a describe run in the app's
 * runner; the text parameters the run used as member names become its member parameters, as the MCP's keep records
 * them. The id and version follow the MCP's rule (`savePlan`). Loaded only when the dialog opens.
 */
import { membersOfRun } from "../anim-members.ts";
import { pluginFileText, type PluginFileInfo, type PluginParamInfo } from "../plugin-file.ts";
import { RECIPE_API } from "../plugin-step.ts";
import { DESCRIPTION_MAX, LIBRARY_NEEDS_APP, TITLE_MAX, libraryIo, oneLine, savePlan } from "../plugins/library.ts";
import { DEFAULT_LIMITS } from "../recipe/host.ts";
import { inlineIngredients } from "../recipe/ingredients.ts";
import { splitPluginData } from "../recipe/plugin-data.ts";
import { markProjectDirty } from "../project-dirty.ts";
import type { PoseAnimationState } from "./pose.ts";
import { session, state } from "./state.ts";

interface KeepContext {
  current: PoseAnimationState;
  /** The file it was played from, for its title, description and declared parameters. */
  file: PluginFileInfo | undefined;
  /** Called once it is kept: the new plugin's id and the sentence the panel shows. */
  done(id: string, said: string): void;
}

/** The parameters the script declares, from a describe run; null when it could not be described here. */
async function describedParams(name: string, body: string): Promise<PluginParamInfo[] | null> {
  const { recipeRuntime } = await import("../recipe/runtime.ts");
  const recipes = await recipeRuntime();
  if (!recipes) return null;
  const split = splitPluginData(body);
  if (split.problem) return null;
  const resolved = inlineIngredients(split.code, (ref) => ({ reason: `The animation needs ingredient ${ref.module}.` }));
  if ("reason" in resolved) return null;
  const built = await recipes.build(name, split.code, false, resolved.suffix);
  if (!built.ok || !built.exe) return null;
  const context = { units: "mm", bedMm: [state.profile.bedX, state.profile.bedY, state.profile.bedZ], nozzleMm: state.profile.nozzleDiameter ?? 0.4 };
  const out = await recipes.run(built.exe, { describe: true, params: {}, context }, async () => ({ ok: false, error: "Describe mode makes no calls." }), { ...DEFAULT_LIMITS, timeoutS: 15 });
  if (!out.ok || !out.described) return null;
  return out.described.params.map((row) => {
    const { line: _line, ...param } = row as Record<string, unknown> & { line?: number };
    return param as unknown as PluginParamInfo;
  });
}

/** Writes the animation into the library. The sentence for the panel, or a reason it was not kept. */
async function keep(context: KeepContext, title: string, description: string): Promise<{ id: string; said: string } | { reason: string }> {
  const { current, file } = context;
  const io = await libraryIo();
  if (!io) return { reason: LIBRARY_NEEDS_APP.replace("Here the panel lists the plugins this project carries.", "Keep animations there.") };
  const body = current.plugin.source.replace(/\r\n?/g, "\n").replace(/^\n+/, "");
  const params = (await describedParams("pose_animation_keep", body)) ?? file?.params ?? [];
  const members = membersOfRun(params, current.plugin.params, current.used ?? []);
  const { loadLibrary, pluginAuthor } = await import("../ui/plugins-panel.ts");
  const library = await loadLibrary();
  const plan = savePlan(library, title, current.plugin.sha, current.plugin.name);
  const text = pluginFileText({
    plugin: plan.id,
    kind: "animation",
    title,
    version: plan.version,
    description: oneLine(description, DESCRIPTION_MAX),
    author: pluginAuthor() || "unknown",
    api: RECIPE_API.join("."),
    sha256: current.plugin.sha,
    created: new Date().toISOString().slice(0, 10),
    target: "object",
    params,
    ...(members.memberParams.length ? { memberParams: members.memberParams } : {}),
    ...(members.memberNames.length ? { memberNames: members.memberNames } : {}),
  }, body);
  try {
    await io.save(plan.id, text);
  } catch (err) {
    return { reason: `The animation could not be written: ${err instanceof Error ? err.message : String(err)}` };
  }
  // The project carries the file too, as it does every plugin it plays.
  session.plugins = { ...(session.plugins ?? {}), [current.plugin.sha]: text };
  markProjectDirty();
  await loadLibrary();
  const names = members.memberParams.length ? ` Its member ${members.memberParams.length === 1 ? "parameter" : "parameters"} ${members.memberParams.join(", ")} ${members.memberParams.length === 1 ? "lists" : "list"} the members of whichever assembly is selected.` : "";
  const fixed = members.memberNames.length ? ` It names ${members.memberNames.join(", ")} as written, so an assembly needs ${members.memberNames.length === 1 ? "a member of that name" : "members of those names"}.` : "";
  return { id: plan.id, said: `Kept “${title}” as animation ${plan.id} v${plan.version}${plan.same ? " (your library already had this code)" : ""} in your plugin library.${names}${fixed}` };
}

export function showAnimationKeep(context: KeepContext): void {
  const { current, file } = context;
  current.clock.pause(performance.now());
  const dialog = document.createElement("dialog"); dialog.className = "pose-animation-save pose-animation-keep"; dialog.setAttribute("aria-label", "Keep animation in library");
  const heading = document.createElement("h2"); heading.textContent = "Keep in library"; dialog.append(heading);
  const sub = document.createElement("p"); sub.textContent = "Keeps this animation in your plugin library, so Pose offers it on any assembly and agents find it with nugget."; dialog.append(sub);
  const field = (label: string, control: HTMLElement) => { const wrap = document.createElement("label"); wrap.textContent = label; wrap.append(control); dialog.append(wrap); };
  const title = document.createElement("input"); title.type = "text"; title.maxLength = TITLE_MAX; title.spellcheck = false; title.autocomplete = "off"; title.setAttribute("aria-label", "Animation title");
  title.value = (file?.title ?? current.plugin.name).replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase()).slice(0, TITLE_MAX);
  field("Title", title);
  const description = document.createElement("textarea"); description.maxLength = DESCRIPTION_MAX; description.rows = 3; description.setAttribute("aria-label", "Animation description");
  description.value = file && file.description !== "Saved with this project." ? file.description : "";
  field("Description", description);
  const status = document.createElement("p"); status.setAttribute("role", "status"); dialog.append(status);
  const actions = document.createElement("div"); actions.className = "pose-buttons"; dialog.append(actions);
  const save = document.createElement("button"); save.type = "button"; save.className = "btn primary"; save.textContent = "Keep"; actions.append(save);
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn"; cancel.textContent = "Cancel"; actions.append(cancel);
  cancel.addEventListener("click", () => { if (!save.disabled) dialog.close(); });
  dialog.addEventListener("cancel", (event) => { if (save.disabled) event.preventDefault(); });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  save.addEventListener("click", () => {
    void (async () => {
      const name = oneLine(title.value, TITLE_MAX);
      if (!name) { status.textContent = "An animation needs a title. Type one line, at most 60 characters."; title.focus(); return; }
      save.disabled = true; status.textContent = "Reading the animation's parameters…";
      try {
        const done = await keep(context, name, description.value);
        if ("reason" in done) { status.textContent = done.reason; return; }
        dialog.close();
        context.done(done.id, done.said);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        save.disabled = false;
      }
    })();
  });
  document.body.append(dialog); dialog.showModal(); title.focus(); title.select();
}
