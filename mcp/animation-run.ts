/** Run an animation script against a fixed rig and sample it without changing the plate. */
import { animationRig, sampleAnimationSteps, type AnimationPart, type AnimationResult, type PoseAnimation } from "../src/pose-anim.ts";
import { RIG_READ_TOOLS, rigRead } from "../src/rig-reads.ts";
import type { Assembly, PoseOf } from "../src/assembly.ts";
import { resolveIngredients } from "./ingredients.ts";
import { splitPluginData } from "../src/recipe/plugin-data.ts";
import { ANIMATION_LIMITS, recipeDataFile, recipeDataMissing, type RecipeHost } from "./recipe.ts";

/** A turn of the event loop: timers, other requests and a cancel run before the work goes on. */
export const eventLoopTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export type AnimationRun = { ok: true; result: AnimationResult; camera?: unknown; background?: string; notes: string[] } | { ok: false; reason: string; issues?: { line?: number; reason: string }[]; diagnostics?: unknown[] };

export async function runAnimation(host: RecipeHost, source: string, params: Record<string, unknown>, assembly: Assembly, poseOf: PoseOf, parts: readonly AnimationPart[], options: { fps?: number; signal?: AbortSignal; progress?: (fraction: number, message: string) => void } = {}): Promise<AnimationRun> {
  const ready = host.available();
  if (!ready.ok) return { ok: false, reason: ready.reason };
  const split = splitPluginData(source);
  if (split.problem) return { ok: false, reason: split.problem };
  const ingredients = resolveIngredients(split.code);
  if ("reason" in ingredients) return { ok: false, reason: ingredients.reason };
  const built = await host.build("pose_animation", split.code, false, ingredients.suffix);
  if (!built.ok || !built.exe) return { ok: false, reason: built.reason ?? "The animation did not build.", diagnostics: built.diagnostics };
  if (options.signal?.aborted) return { ok: false, reason: "The animation was cancelled." };
  const rig = animationRig(assembly, parts);
  const notes: string[] = [];
  let sampled: AnimationResult | undefined;
  let issues: { line?: number; reason: string }[] | undefined;
  let camera: unknown;
  let background: string | undefined;
  const run = await host.run(built.exe, { kind: "animation", params }, async (site) => {
    if (site.tool === "rig") return { ok: true, result: { members: rig } };
    // Recipe API 1.13: reads of the rig at a pose the script states (docs/plan-contact-poses.md section 3).
    if (RIG_READ_TOOLS.has(site.tool)) return rigRead(site.tool, site.args, assembly, poseOf, parts);
    if (site.tool === "log") { notes.push(String(site.args.message ?? site.args.text ?? "").slice(0, 400)); return { ok: true, result: {} }; }
    if (site.tool === "data") {
      const name = typeof site.args.name === "string" ? site.args.name : "";
      const carried = split.data[name];
      if (carried) return { ok: true, result: carried.value };
      const data = recipeDataFile(name);
      if (!data || "reason" in data) return { ok: false, error: data?.reason ?? recipeDataMissing(name) };
      return { ok: true, result: data.value };
    }
    if (site.tool === "animate") {
      if (sampled || issues) return { ok: false, error: "An animation script may animate only once." };
      camera = site.args.camera;
      if (typeof site.args.background === "string") background = site.args.background;
      const input = { ...site.args, ...(options.fps !== undefined ? { fps: options.fps } : {}) } as unknown as PoseAnimation;
      // The window's steps (sampleAnimationSteps: each frame posed and checked for crossings), with a turn of the event
      // loop between frames: a scene of many parts takes seconds a frame, and the server must go on answering (and hear
      // a cancel) meanwhile.
      const steps = sampleAnimationSteps(input, assembly, poseOf, parts);
      let step = steps.next();
      while (!step.done) {
        if (options.signal?.aborted) return { ok: false, error: "The animation was cancelled." };
        options.progress?.(step.value.count ? step.value.frame / step.value.count : 0, `Posing and checking frame ${step.value.frame}/${step.value.count}`);
        await eventLoopTurn();
        step = steps.next();
      }
      const result = step.value;
      if ("issues" in result) { issues = result.issues; return { ok: false, error: issues.map((issue) => `${issue.line ? `line ${issue.line}: ` : ""}${issue.reason}`).join("; ") }; }
      sampled = result;
      return { ok: true, result: { frames: result.frames.length, durationS: result.durationS, fps: result.fps, keys: result.keys } };
    }
    return { ok: false, error: "That animation call is not available." };
  }, ANIMATION_LIMITS, options.signal, options.progress);
  if (!run.ok || issues) return { ok: false, reason: run.reason ?? issues?.[0]?.reason ?? "The animation failed.", ...(issues ? { issues } : {}) };
  if (!sampled) return { ok: false, reason: "The script ended without an animation." };
  return { ok: true, result: sampled, ...(camera ? { camera } : {}), ...(background ? { background } : {}), notes: [...notes, ...(run.notes ?? [])] };
}
