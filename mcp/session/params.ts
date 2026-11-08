/**
 * Parameters, parts, and anchors: model_params, model_define, model_anchors, and the rebuild from parameters.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { plainModelError } from "../../src/app/model-error.ts";
import { builtBranch, forked, stepIds, type ForkStep } from "../../src/model-edit.ts";
import { editRequest, keepSketch } from "../../src/model-request.ts";
import { readBroken, readBuilt, nodeHandle, solidView } from "../../src/modeling/model-calls.ts";
import { anchorRow } from "../../src/modeling/anchors.ts";
import { expandOps, type PartDef } from "../../src/modeling/macro.ts";
import { renumberedSteps } from "../../src/model-tree.ts";
import { readParameters } from "../../src/project.ts";
import { workplaneOwn } from "../../src/workplane.ts";
import { keptIngredient } from "../ingredients.ts";
import { OP_WORDS } from "../schema.ts";
import { evaluateTable } from "../../src/modeling/params.ts";
import { resolveForParameters, readAssemblies } from "../../src/assembly.ts";
import { followRepeatSources } from "../../src/model-repeat.ts";
import { planRebuild } from "../../src/param-rebuild.ts";
import { ExprError, PARAM_NAME, evaluate, resolveNumbers } from "../../src/modeling/expr.ts";
import { CHORD, type PlateObject, type Recipe, type RustRecipe, type TypedWorkplane, shownName } from "./shared.ts";
import type { Session } from "../session.ts";
import { refuse } from "../refusals.ts";

/** model_anchors: every label on the path to the current step with its box, or one label's. */
function anchorsTool(this: Session, obj: PlateObject, input: Record<string, unknown>): Record<string, unknown> {
  if (!obj.tree) return refuse("no-history", "This object has no Model history yet.");
  if (typeof input.label === "string") {
    const box = this.labelBox(obj, input.label);
    return box ? { ok: true, ...anchorRow(input.label, box) } : refuse("bad-anchor", `No step is labelled "${input.label}" with a tool to measure.`);
  }
  const names = new Set<string>();
  for (let node: number | null = obj.tree.current; node !== null; node = obj.tree.nodes.get(node)?.parent ?? null) {
    const row = obj.tree.nodes.get(node);
    if (!row?.op) continue;
    names.add(row.label.replace(/ \d+\/\d+$/, ""));
  }
  for (const group of this.stepGroups(obj)) if (obj.tree.nodes.has(group.end)) names.add(group.label);
  const rows = [...names].reverse().flatMap((name) => {
    const box = this.labelBox(obj, name);
    return box ? [anchorRow(name, box)] : [];
  });
  const part = this.labelBox(obj, "part");
  return { ok: true, labels: rows.slice(0, 200), ...(part ? { part: anchorRow("part", part) } : {}) };
}

/** The parameters, parts, and each build's recipe and log, as the project keeps them. Null when there are none. */
function mcpModelRecord(this: Session): Record<string, unknown> | null {
  const recipes: Record<string, unknown> = {};
  for (const obj of this.objects) if (obj.recipe) recipes[obj.id] = { recipe: obj.recipe, ...(obj.buildLog ? { buildLog: obj.buildLog } : {}) };
  // A recipe_run source is kept once, by name; each object names it.
  for (const obj of this.objects) if (obj.rustRecipe && this.rustRecipes.has(obj.rustRecipe)) recipes[obj.id] = { ...(recipes[obj.id] as object | undefined), rust: obj.rustRecipe };
  const used = new Set(this.objects.map((obj) => obj.rustRecipe).filter((key): key is string => !!key));
  for (const [key, row] of this.rustRecipes) if (row.changed?.some((id) => this.find(id))) used.add(key);
  // --- Plugin steps (D7). A draft a stamped step names is kept too: it is that step's code.
  const drafts = new Set(this.stamps().filter((stamp) => stamp.version === 0).map((stamp) => stamp.sha256));
  for (const [key, row] of this.rustRecipes) if (row.sha256 && drafts.has(row.sha256)) used.add(key);
  const rustRecipes = Object.fromEntries([...this.rustRecipes].filter(([key]) => used.has(key)));
  const workplanes = Object.fromEntries(this.objects.filter((obj) => obj.workplaneTyped).map((obj) => [obj.id, obj.workplaneTyped]));
  const record = {
    ...(Object.keys(rustRecipes).length ? { rustRecipes } : {}),
    ...(this.animations.size ? { animations: Object.fromEntries(this.animations) } : {}),
    ...(this.parts.size ? { parts: Object.fromEntries(this.parts) } : {}),
    ...(Object.keys(recipes).length ? { recipes } : {}),
    ...(Object.keys(workplanes).length ? { workplanes } : {}),
  };
  return Object.keys(record).length ? structuredClone(record) : null;
}

/** A project's MCP record back into the session: what it does not understand it leaves out. */
function adoptMcpModel(this: Session, value: Record<string, unknown> | undefined): void {
  this.parts.clear();
  this.rustRecipes.clear();
  this.animations.clear();
  this.recipePreviewHashes.clear();
  this.recipeCheckpoints.clear();
  if (!value) return;
  const animations = value.animations;
  if (animations && typeof animations === "object" && !Array.isArray(animations)) {
    for (const [name, saved] of Object.entries(animations)) {
      const row = saved as { source?: unknown; plugin?: unknown; api?: unknown; params?: unknown; assembly?: unknown } | null;
      if (!row || typeof row.source !== "string" || typeof row.assembly !== "string") continue;
      const params = row.params && typeof row.params === "object" && !Array.isArray(row.params) ? row.params as Record<string, unknown> : {};
      this.animations.set(name, { source: row.source, assembly: row.assembly, params, ...(typeof row.plugin === "string" ? { plugin: row.plugin } : {}), ...(typeof row.api === "string" ? { api: row.api } : {}) });
    }
  }
  const rust = value.rustRecipes;
  if (rust && typeof rust === "object") {
    for (const [key, saved] of Object.entries(rust)) {
      const row = saved as Partial<RustRecipe> | null;
      if (!row || typeof row.source !== "string") continue;
      const objects = Array.isArray(row.objects) ? row.objects.filter((id): id is string => typeof id === "string") : [];
      const data = row.data && typeof row.data === "object" ? Object.fromEntries(Object.entries(row.data).filter(([, kept]) => !!kept && typeof kept === "object" && typeof kept.sha256 === "string" && "value" in kept)) : {};
      const changed = Array.isArray(row.changed) ? row.changed.filter((id): id is string => typeof id === "string") : [];
      const stamp = row.plugin && typeof row.plugin === "object" && typeof row.plugin.id === "string" && typeof row.plugin.version === "number" && typeof row.plugin.sha256 === "string" ? { plugin: { id: row.plugin.id, version: row.plugin.version, sha256: row.plugin.sha256 } } : {};
      const ingredients = row.ingredients && typeof row.ingredients === "object" ? Object.fromEntries(Object.entries(row.ingredients).flatMap(([ref, kept]) => {
        const ok = keptIngredient(kept);
        return ok ? [[ref, ok]] : [];
      })) : {};
      if (Object.keys(ingredients).length) Object.assign(stamp, { ingredients });
      this.rustRecipes.set(key, { source: row.source, params: row.params && typeof row.params === "object" ? row.params : {}, objects, ...(Object.keys(data).length ? { data } : {}), ...(typeof row.path === "string" ? { path: row.path } : {}), ...(typeof row.sha256 === "string" ? { sha256: row.sha256 } : {}), ...(typeof row.at === "number" ? { at: row.at } : {}), ...(changed.length ? { changed } : {}), ...stamp });
    }
  }
  const parts = value.parts;
  if (parts && typeof parts === "object") {
    for (const [name, part] of Object.entries(parts)) {
      const row = part as Partial<PartDef> | null;
      if (row && Array.isArray(row.ops) && row.params && typeof row.params === "object") this.parts.set(name, { params: row.params, ops: row.ops });
    }
  }
  const recipes = value.recipes;
  if (recipes && typeof recipes === "object") {
    for (const [id, saved] of Object.entries(recipes)) {
      const obj = this.find(id);
      const row = saved as { recipe?: Recipe; buildLog?: PlateObject["buildLog"]; rust?: unknown } | null;
      if (obj && typeof row?.rust === "string" && this.rustRecipes.has(row.rust)) obj.rustRecipe = row.rust;
      if (!obj || !row?.recipe || typeof row.recipe !== "object") continue;
      obj.recipe = row.recipe;
      if (row.buildLog && Array.isArray(row.buildLog.steps) && typeof row.buildLog.base === "string") obj.buildLog = row.buildLog;
    }
  }
  const workplanes = value.workplanes;
  if (workplanes && typeof workplanes === "object") {
    for (const [id, saved] of Object.entries(workplanes)) {
      const obj = this.find(id);
      const row = saved as Partial<TypedWorkplane> | null;
      const vec = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
      if (!obj || !row || !vec(row.origin) || !vec(row.turn) || !row.text || (row.source !== "global" && row.source !== "bed" && row.source !== "face")) continue;
      obj.workplaneTyped = { source: row.source, origin: row.origin as TypedWorkplane["origin"], turn: row.turn as TypedWorkplane["turn"], text: row.text };
    }
  }
}

/** model_define: a named part, its default parameters and its ops, which {kind: "use", part, with} places. */
function defineTool(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  if (input.clear === true) this.parts.clear();
  if (typeof input.name === "string") {
    const name = input.name.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_ -]*$/.test(name)) return refuse("bad-name", "A part name is letters, digits, spaces, dashes, and underscores.");
    if (!Array.isArray(input.ops) || input.ops.length === 0) return refuse("missing-argument", "A part needs ops.");
    const params = (input.params ?? {}) as Record<string, unknown>;
    try {
      // Expanded once with its defaults, so a mistake shows now rather than at the first use.
      const defaults: Record<string, number> = { ...this.params };
      for (const [key, value] of Object.entries(params)) defaults[key] = Number(resolveNumbers(value, defaults, `params.${key}`));
      expandOps(input.ops, defaults, this.parts, OP_WORDS);
    } catch (err) {
      if (err instanceof ExprError) return refuse("bad-expression", err.message);
      throw err;
    }
    this.parts.set(name, { params: structuredClone(params), ops: structuredClone(input.ops) });
  }
  return { ok: true, parts: [...this.parts.entries()].map(([name, part]) => ({ name, params: part.params, ops: part.ops.length })) };
}

/** Session parameters: names model ops may use in place of numbers, as text such as "wallH + 2". */
function paramsTool(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const set = (input.set ?? {}) as Record<string, unknown>;
  const next: Record<string, string | number> = input.clear === true ? {} : { ...this.paramText };
  for (const [name, value] of Object.entries(set)) {
    if (!PARAM_NAME.test(name)) return refuse("bad-name", `"${name}" is not a parameter name. Use letters, digits, and underscores.`);
    next[name] = typeof value === "number" && Number.isFinite(value) ? value : String(value);
  }
  // --- D22. A row this call sets must evaluate; a bad row it does not touch stays, as the app's panel keeps it.
  const table = evaluateTable(next);
  const bad = table.rows.filter((row) => row.error);
  const refused = bad.find((row) => Object.hasOwn(set, row.name));
  if (refused) return refuse("bad-expression", `${refused.name}: ${refused.error}`);
  const before = this.params;
  this.paramText = next;
  this.params = { ...table.values };
  const moved = this.followAssemblies(before);
  this.followWorkplanes();
  const errors = bad.length > 0 ? { errors: Object.fromEntries(bad.map((row) => [row.name, row.error])) } : {};
  return { ok: true, params: { ...this.params }, ...errors, ...moved };
}

/**
 * --- Assemblies M3. Each assembly that reads a changed parameter is solved again: its members' model poses move, and
 * the reply names them with their new box in model space. The print layout does not move.
 */
function followAssemblies(this: Session, before: Record<string, number>): { moved?: Record<string, unknown>[]; assemblyErrors?: Record<string, unknown>[] } {
  if (this.assemblies.length === 0) return {};
  const live = readAssemblies(this.assemblies, this.objects);
  const followed = resolveForParameters(live, (id) => this.find(id)?.modelPose, before, this.params);
  this.assemblies = followed.assemblies;
  const moved = followed.moved.flatMap(({ object, pose }) => {
    const obj = this.find(object);
    if (!obj) return [];
    obj.modelPose = pose;
    const box = this.assembledBox(obj);
    return [{ object, name: shownName(obj.name), ...(box ? { assembledMm: box } : {}) }];
  });
  const errors = followed.errors.map((row) => ({ object: row.object, reason: row.error }));
  return { ...(moved.length ? { moved } : {}), ...(errors.length ? { assemblyErrors: errors } : {}) };
}

/** --- Gaps A3. A workplane typed with expressions moves with them: ops typed on it after a set use the new plane. */
function followWorkplanes(this: Session): void {
  for (const obj of this.objects) {
    const typed = obj.workplaneTyped;
    if (!typed) continue;
    try {
      const origin = resolveNumbers(typed.text.origin ?? typed.origin, this.params) as [number, number, number];
      const turn = resolveNumbers(typed.text.turn ?? typed.turn, this.params) as [number, number, number];
      if (![...origin, ...turn].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
      obj.workplaneTyped = { ...typed, origin, turn };
      obj.workplane = workplaneOwn({ source: typed.source, origin, turn }, obj.modelPose);
    } catch {
      // A name the table lost keeps the plane where it was.
    }
  }
}

/**
 * --- Gaps A5. model_params with rebuild: the set, then every part whose shown steps are out of date is rebuilt as the
 * app's Parameters panel rebuilds it (`planRebuild`, one edit of the earliest step with the rest replayed), committed,
 * and checked. A part that cannot follow says why and is left as it was.
 */
async function paramsRebuild(this: Session, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const set = this.paramsTool(input);
  if (set.ok !== true) return set;
  const rebuilt: Record<string, unknown>[] = [];
  for (const obj of [...this.objects]) {
    if (!obj.tree) continue;
    const row = await this.rebuildFromParameters(obj);
    if (row) rebuilt.push(row);
  }
  const failed = rebuilt.filter((row) => row.ok !== true);
  return {
    ...set,
    ok: failed.length === 0,
    ...(failed.length ? { code: "build-failed" } : {}),
    rebuilt,
    ...(rebuilt.length === 0 ? { note: "No part uses a parameter that changed." } : {}),
    ...(failed.length ? { reason: `${failed.length} part${failed.length === 1 ? "" : "s"} could not follow; each says why.` } : {}),
  };
}

async function rebuildFromParameters(this: Session, obj: PlateObject): Promise<Record<string, unknown> | null> {
  const opened = await this.opened(obj);
  if ("reason" in opened) return refuse("model-unavailable", opened.reason, { object: obj.id });
  const start = opened.current;
  let moved = false;
  const plan = await planRebuild(opened, { ...this.params }, {
    pose: obj.modelPose,
    builtOn: async (parent) => {
      const at = await this.gotoNode(obj, parent);
      moved = true;
      if (at.ok !== true || !obj.solid) return String(at.reason ?? "The step this feature was built on could not be rebuilt.");
      return obj.solid;
    },
  });
  if (moved) await this.gotoNode(obj, start);
  if (plan === null || plan === "stale") return null;
  if ("error" in plan) return refuse("build-failed", plan.error, { object: obj.id });
  const tree = obj.tree!;
  const [op, ...rest] = plan.supplied;
  const followed = followRepeatSources(
    [{ id: plan.node, op: op! }, ...plan.replay.map((id, i) => ({ id, op: rest[i]! }))],
    (id) => {
      const node = tree.nodes.get(id);
      if (node?.op) return node.op;
      return node?.parent === null && tree.root.kind === "primitive" ? { kind: "root", ...tree.root.solid } : null;
    },
    obj.modelPose,
  );
  if ("error" in followed) return refuse("build-failed", followed.error, { object: obj.id });
  const replayOps = followed.ops.slice(1);
  const twin = builtBranch(tree, plan.parent, op!, replayOps);
  let steps = 0;
  let broken: { id: number; error: string } | null = null;
  if (twin != null) {
    const shown = await this.gotoNode(obj, twin);
    if (shown.ok !== true) return refuse("build-failed", String(shown.reason ?? "That branch could not be shown."), { object: obj.id });
  } else {
    const ids = this.reserveOn(tree.key, 1 + plan.replay.length);
    const renamed = stepIds([plan.node, ...plan.replay], ids);
    const replay = replayOps.map((step, i) => ({ id: ids[i + 1]!, op: renumberedSteps(step, renamed) }));
    const budget = this.replayBudgetMs(followed.ops.reduce((sum, step) => sum + 1 + (step.kind === "group" ? step.steps.length : 0), 0));
    let reply: Record<string, unknown>;
    try {
      reply = await this.treeCall(editRequest(tree.key, plan.parent, ids[0]!, op!, replay, obj.stepTolerance || CHORD), "edit", budget);
    } catch (err) {
      const lost = this.lostReply(err);
      if (lost) return { object: obj.id, ...lost };
      throw err;
    }
    if (typeof reply.error === "string" && reply.error) return refuse("kernel-refused", plainModelError(reply.error), { object: obj.id });
    const built = readBuilt(reply.built);
    broken = readBroken(reply.broken);
    const fork: ForkStep[] = ids.map((id, index) => {
      const source = index === 0 ? op! : replay[index - 1]!.op;
      const made = built?.get(id);
      return { id, op: made ? keepSketch(made.op, source) : source, fingerprint: made?.fingerprint ?? null, ...(broken?.id === id ? { broken: broken.error } : {}) };
    });
    const tip = [...fork].reverse().find((step) => !step.broken)?.id ?? ids[0]!;
    obj.tree = forked(obj.tree ?? tree, plan.parent, fork, tip);
    const solid = solidView(reply);
    if (solid) obj.solid = solid;
    obj.probes.clear();
    steps = (built?.size ?? 1);
  }
  const reason = broken ? null : await this.commitObject(obj);
  const check = await this.modelCheck(obj, {});
  return {
    object: obj.id,
    ok: broken == null && !reason,
    ...(broken ? { code: "build-failed" } : reason ? { code: "commit-failed" } : {}),
    steps,
    node: nodeHandle(obj.tree?.current ?? plan.node),
    ...(broken ? { broken: true, reason: `A step could not be rebuilt: ${broken.error} The part shows the last step that built, uncommitted.` } : {}),
    ...(reason ? { reason } : {}),
    committed: broken == null && !reason,
    bounds: obj.solid?.bounds ?? null,
    volumeMm3: obj.solid?.volumeMm3 ?? null,
    check,
  };
}

/**
 * The project's parameter table. `parameters` wins. An older file's `mcpModel.params` is the
 * fallback, and those values are numbers.
 */
function adoptParameters(this: Session, project: { parameters?: Record<string, string | number>; mcpModel?: Record<string, unknown> }): void {
  this.params = {};
  this.paramText = {};
  const top = project.parameters;
  if (top && typeof top === "object" && !Array.isArray(top)) {
    this.paramText = readParameters(top) ?? {};
  } else {
    const legacy = project.mcpModel?.params;
    if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
      const numbers: Record<string, number> = {};
      for (const [key, n] of Object.entries(legacy as Record<string, unknown>)) {
        if (PARAM_NAME.test(key) && typeof n === "number" && Number.isFinite(n)) numbers[key] = n;
      }
      this.paramText = numbers;
    }
  }
  this.params = { ...evaluateTable(this.paramText).values };
}

/**
 * A call's `params` evaluated in order on top of the session's numbers. A later name may use an
 * earlier one. The session table is unchanged.
 */
function mergeParams(this: Session, set: Record<string, unknown>): Record<string, number> | { reason: string } {
  const out: Record<string, number> = { ...this.params };
  for (const [name, value] of Object.entries(set)) {
    if (!PARAM_NAME.test(name)) return { reason: `"${name}" is not a parameter name. Use letters, digits, and underscores.` };
    try {
      out[name] = typeof value === "number" ? value : evaluate(String(value), out);
    } catch (err) {
      return { reason: `${name}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!Number.isFinite(out[name])) return { reason: `${name} is not a finite number.` };
  }
  return out;
}

/** The methods this module adds to Session. */
export const paramsMethods = {
  anchorsTool,
  mcpModelRecord,
  adoptMcpModel,
  defineTool,
  paramsTool,
  followAssemblies,
  followWorkplanes,
  paramsRebuild,
  rebuildFromParameters,
  adoptParameters,
  mergeParams,
};
