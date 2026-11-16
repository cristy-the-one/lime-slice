/** App-side animation script execution. Sampling uses the same rig and interpolation as MCP. */
import type { Assembly, PoseOf } from "../assembly.ts";
import { animationRig, type AnimationPart, type AnimationResult, type PoseAnimation } from "../pose-anim.ts";
import { CANCELLED, sampleAnimationInBackground } from "../pose-anim-sample.ts";
import { RIG_READ_TOOLS, rigRead } from "../rig-reads.ts";
import type { AppRecipes } from "./tauri.ts";
import { ANIMATION_LIMITS, type RecipeReply } from "./host.ts";
import { inlineIngredients } from "./ingredients.ts";
import { splitPluginData } from "./plugin-data.ts";
import { namesInCall } from "../anim-members.ts";

/** `used`: the member names and patterns the script sent (docs/plan-animation-plugins.md A2), for Keep in library. */
export type AppAnimation = { ok: true; result: AnimationResult; spec: PoseAnimation; camera?: unknown; notes: string[]; used: string[] } | { ok: false; reason: string; issues?: { line?: number; reason: string }[] };

/**
 * Where a build stands, for the Pose panel: the script is compiled, then run; when it calls `animate` the frames are
 * prepared (`frame` of `count`, each checked for parts that cross); then the script finishes.
 */
export type AnimationStage = { stage: "build" } | { stage: "run" } | { stage: "frames"; frame: number; count: number } | { stage: "finish" };
export interface AppAnimationOptions {
  /** Stops the build, the script and the frames. */
  signal?: AbortSignal;
  onStage?: (stage: AnimationStage) => void;
  /** Lend the parts' position buffers to the frames' worker (`sampleAnimationInBackground`): parts made for this run only. */
  transfer?: boolean;
  /** False prepares the frames on this thread, in slices (`sampleAnimationSliced`). */
  worker?: boolean;
  /** Pairs of members the crossing check leaves out (`SampleOptions.ignore`), as pose_animate {ignore} gives them. */
  ignore?: [string, string][];
}

export async function runAppAnimation(recipes: AppRecipes, name: string, source: string, params: Record<string, unknown>, assembly: Assembly, poseOf: PoseOf, parts: readonly AnimationPart[], options: AppAnimationOptions = {}): Promise<AppAnimation> {
  const { signal, onStage } = options;
  const split = splitPluginData(source);
  if (split.problem) return { ok: false, reason: split.problem };
  const resolved = inlineIngredients(split.code, (ref) => ({ reason: `The animation needs ingredient ${ref.module}; carry it in the plugin before playing.` }));
  if ("reason" in resolved) return { ok: false, reason: resolved.reason };
  onStage?.({ stage: "build" });
  const built = await recipes.build(name, split.code, false, resolved.suffix);
  if (signal?.aborted) return { ok: false, reason: CANCELLED };
  if (!built.ok || !built.exe) return { ok: false, reason: built.reason ?? (built.diagnostics.map((d) => `line ${d.line}: ${d.message}`).join("; ") || "The animation did not build.") };
  const rig = animationRig(assembly, parts), notes: string[] = [];
  let sampled: AnimationResult | undefined, camera: unknown, spec: PoseAnimation | undefined;
  let issues: { line?: number; reason: string }[] | undefined;
  onStage?.({ stage: "run" });
  const used = new Set<string>();
  const run = await recipes.run(built.exe, { kind: "animation", params }, async (site): Promise<RecipeReply> => {
    for (const name of namesInCall(site.tool, site.args)) used.add(name);
    if (site.tool === "rig") return { ok: true, result: { members: rig } };
    // Recipe API 1.13: reads of the rig at a pose the script states (docs/plan-contact-poses.md section 3).
    if (RIG_READ_TOOLS.has(site.tool)) return rigRead(site.tool, site.args, assembly, poseOf, parts);
    if (site.tool === "log") { if (notes.length < 200) notes.push(String(site.args.message ?? site.args.text ?? "").slice(0, 400)); return { ok: true, result: {} }; }
    if (site.tool === "data") {
      const key = typeof site.args.name === "string" ? site.args.name : "";
      const data = split.data[key];
      return data ? { ok: true, result: data.value } : { ok: false, error: `The animation needs data ${key}, which is not carried in the plugin.` };
    }
    if (site.tool === "animate") {
      if (sampled || issues) return { ok: false, error: "An animation script may animate only once." };
      camera = site.args.camera;
      spec = site.args as unknown as PoseAnimation;
      const result = await sampleAnimationInBackground(spec, assembly, poseOf, parts, {
        onProgress: (frame, count) => onStage?.({ stage: "frames", frame, count }),
        ...(signal ? { signal } : {}), ...(options.transfer ? { transfer: true } : {}), ...(options.worker === false ? { worker: false } : {}), ...(options.ignore ? { ignore: options.ignore } : {}),
      });
      onStage?.({ stage: "finish" });
      if ("issues" in result) { issues = result.issues; return { ok: false, error: issues.map((issue) => `${issue.line ? `line ${issue.line}: ` : ""}${issue.reason}`).join("; ") }; }
      sampled = result;
      return { ok: true, result: { frames: result.frames.length, durationS: result.durationS, fps: result.fps, keys: result.keys } };
    }
    return { ok: false, error: "That animation call is not available." };
  }, ANIMATION_LIMITS, signal);
  if (signal?.aborted) return { ok: false, reason: CANCELLED };
  if (!run.ok || issues) return { ok: false, reason: run.reason ?? issues?.[0]?.reason ?? "The animation failed.", ...(issues ? { issues } : {}) };
  if (!sampled || !spec) return { ok: false, reason: "The script ended without an animation." };
  return { ok: true, result: sampled, spec, ...(camera ? { camera } : {}), notes: [...notes, ...(run.notes ?? [])], used: [...used] };
}
