/** Run an animation script against a fixed rig and sample it without changing the plate. */
import { animationRig, sampleAnimation, type AnimationPart, type AnimationResult, type PoseAnimation } from "../src/pose-anim.ts";
import type { Assembly, PoseOf } from "../src/assembly.ts";
import { resolveIngredients } from "./ingredients.ts";
import { DEFAULT_LIMITS, recipeDataFile, recipeDataMissing, type RecipeHost } from "./recipe.ts";

export type AnimationRun = { ok: true; result: AnimationResult; camera?: unknown; notes: string[] } | { ok: false; reason: string; issues?: { line?: number; reason: string }[]; diagnostics?: unknown[] };

export async function runAnimation(host: RecipeHost, source: string, params: Record<string, unknown>, assembly: Assembly, poseOf: PoseOf, parts: readonly AnimationPart[], options: { fps?: number; signal?: AbortSignal; progress?: (fraction: number, message: string) => void } = {}): Promise<AnimationRun> {
  const ready = host.available();
  if (!ready.ok) return { ok: false, reason: ready.reason };
  const ingredients = resolveIngredients(source);
  if ("reason" in ingredients) return { ok: false, reason: ingredients.reason };
  const built = await host.build("pose_animation", source, false, ingredients.suffix);
  if (!built.ok || !built.exe) return { ok: false, reason: built.reason ?? "The animation did not build.", diagnostics: built.diagnostics };
  if (options.signal?.aborted) return { ok: false, reason: "The animation was cancelled." };
  const rig = animationRig(assembly, parts);
  const notes: string[] = [];
  let sampled: AnimationResult | undefined;
  let issues: { line?: number; reason: string }[] | undefined;
  let camera: unknown;
  const run = await host.run(built.exe, { kind: "animation", params }, async (site) => {
    if (site.tool === "rig") return { ok: true, result: { members: rig } };
    if (site.tool === "log") { notes.push(String(site.args.message ?? site.args.text ?? "").slice(0, 400)); return { ok: true, result: {} }; }
    if (site.tool === "data") {
      const name = typeof site.args.name === "string" ? site.args.name : "";
      const data = recipeDataFile(name);
      if (!data || "reason" in data) return { ok: false, error: data?.reason ?? recipeDataMissing(name) };
      return { ok: true, result: data.value };
    }
    if (site.tool === "animate") {
      if (sampled || issues) return { ok: false, error: "An animation script may animate only once." };
      camera = site.args.camera;
      const input = { ...site.args, ...(options.fps !== undefined ? { fps: options.fps } : {}) } as unknown as PoseAnimation;
      const result = sampleAnimation(input, assembly, poseOf, parts);
      if ("issues" in result) { issues = result.issues; return { ok: false, error: issues.map((issue) => `${issue.line ? `line ${issue.line}: ` : ""}${issue.reason}`).join("; ") }; }
      sampled = result;
      return { ok: true, result: { frames: result.frames.length, durationS: result.durationS, fps: result.fps, keys: result.keys } };
    }
    return { ok: false, error: "That animation call is not available." };
  }, DEFAULT_LIMITS, options.signal, options.progress);
  if (!run.ok || issues) return { ok: false, reason: run.reason ?? issues?.[0]?.reason ?? "The animation failed.", ...(issues ? { issues } : {}) };
  if (!sampled) return { ok: false, reason: "The script ended without an animation." };
  return { ok: true, result: sampled, ...(camera ? { camera } : {}), notes: [...notes, ...(run.notes ?? [])] };
}
