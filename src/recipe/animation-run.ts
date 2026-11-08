/** App-side animation script execution. Sampling uses the same rig and interpolation as MCP. */
import type { Assembly, PoseOf } from "../assembly.ts";
import { animationRig, sampleAnimation, type AnimationPart, type AnimationResult, type PoseAnimation } from "../pose-anim.ts";
import type { AppRecipes } from "./tauri.ts";
import { DEFAULT_LIMITS, type RecipeReply } from "./host.ts";
import { inlineIngredients } from "./ingredients.ts";
import { splitPluginData } from "./plugin-data.ts";

export type AppAnimation = { ok: true; result: AnimationResult; camera?: unknown; notes: string[] } | { ok: false; reason: string; issues?: { line?: number; reason: string }[] };

export async function runAppAnimation(recipes: AppRecipes, name: string, source: string, params: Record<string, unknown>, assembly: Assembly, poseOf: PoseOf, parts: readonly AnimationPart[], signal?: AbortSignal): Promise<AppAnimation> {
  const split = splitPluginData(source);
  if (split.problem) return { ok: false, reason: split.problem };
  const resolved = inlineIngredients(split.code, (ref) => ({ reason: `The animation needs ingredient ${ref.module}; carry it in the plugin before playing.` }));
  if ("reason" in resolved) return { ok: false, reason: resolved.reason };
  const built = await recipes.build(name, split.code, false, resolved.suffix);
  if (!built.ok || !built.exe) return { ok: false, reason: built.reason ?? (built.diagnostics.map((d) => `line ${d.line}: ${d.message}`).join("; ") || "The animation did not build.") };
  const rig = animationRig(assembly, parts), notes: string[] = [];
  let sampled: AnimationResult | undefined, camera: unknown;
  let issues: { line?: number; reason: string }[] | undefined;
  const run = await recipes.run(built.exe, { kind: "animation", params }, async (site): Promise<RecipeReply> => {
    if (site.tool === "rig") return { ok: true, result: { members: rig } };
    if (site.tool === "log") { if (notes.length < 200) notes.push(String(site.args.message ?? site.args.text ?? "").slice(0, 400)); return { ok: true, result: {} }; }
    if (site.tool === "data") {
      const key = typeof site.args.name === "string" ? site.args.name : "";
      const data = split.data[key];
      return data ? { ok: true, result: data.value } : { ok: false, error: `The animation needs data ${key}, which is not carried in the plugin.` };
    }
    if (site.tool === "animate") {
      if (sampled || issues) return { ok: false, error: "An animation script may animate only once." };
      camera = site.args.camera;
      const result = sampleAnimation(site.args as unknown as PoseAnimation, assembly, poseOf, parts);
      if ("issues" in result) { issues = result.issues; return { ok: false, error: issues.map((issue) => `${issue.line ? `line ${issue.line}: ` : ""}${issue.reason}`).join("; ") }; }
      sampled = result;
      return { ok: true, result: { frames: result.frames.length, durationS: result.durationS, fps: result.fps, keys: result.keys } };
    }
    return { ok: false, error: "That animation call is not available." };
  }, DEFAULT_LIMITS, signal);
  if (!run.ok || issues) return { ok: false, reason: run.reason ?? issues?.[0]?.reason ?? "The animation failed.", ...(issues ? { issues } : {}) };
  if (!sampled) return { ok: false, reason: "The script ended without an animation." };
  return { ok: true, result: sampled, ...(camera ? { camera } : {}), notes: [...notes, ...(run.notes ?? [])] };
}
