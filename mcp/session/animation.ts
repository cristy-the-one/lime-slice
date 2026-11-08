/** MCP animation execution and export; sampling is always performed on a copy of the rig. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblyOf } from "../../src/assembly.ts";
import { seatLift } from "../../src/model-space.ts";
import { animationRig, type AnimationPart } from "../../src/pose-anim.ts";
import { apiVerdict } from "../../src/recipe/api-level.ts";
import { runAnimation } from "../animation-run.ts";
import { animatedGif, type GifFrame } from "../animation-gif.ts";
import { BACKGROUND, readBackground, readCamera, renderMesh } from "../render.ts";
import { slugOf } from "../plugins.ts";
import { RecipeHost, recipeCrateDir, recipeSourceFile } from "../recipe.ts";
import { resolveWrite } from "../workspace.ts";
import { NEXT, refuse } from "../refusals.ts";
import { SESSION_URL } from "../session-url.ts";
import { joinedPositions, posedPositions, type CallMeta, type ToolHandler } from "./shared.ts";
import type { Session } from "../session.ts";

async function poseAnimate(this: Session, input: Record<string, unknown>, meta?: CallMeta): Promise<Record<string, unknown>> {
  const obj = this.find(typeof input.object === "string" ? input.object : this.selected);
  if (!obj) return refuse("no-mesh", "Choose an assembly member first.", undefined, NEXT.mesh);
  const assembly = assemblyOf(this.liveAssemblies(), obj.id);
  if (!assembly) return refuse("bad-assembly", "That part does not belong to an assembly.");
  const asked = input.background === undefined ? undefined : readBackground(input.background);
  if (asked && "reason" in asked) return refuse("bad-argument", asked.reason);
  const choices = [input.source, input.path, input.plugin].filter((value) => typeof value === "string");
  if (choices.length !== 1) return refuse("conflicting-arguments", "Pass exactly one of source, path or plugin.");
  let source = typeof input.source === "string" ? input.source : "";
  let defaultName = typeof input.plugin === "string" ? input.plugin : "animation";
  let pluginCopy: { sha256: string; text: string } | undefined;
  let savedParams: Record<string, unknown> = {};
  let api: string | undefined;
  if (typeof input.path === "string") {
    const file = recipeSourceFile(input.path);
    if ("reason" in file) return refuse("recipe-source", file.reason);
    source = file.text; defaultName = file.stem;
  }
  if (typeof input.plugin === "string") {
    const kept = this.animations.get(input.plugin);
    if (kept) { source = kept.source; savedParams = kept.params; api = kept.api; }
    else {
      const plugin = await this.pluginFile(input.plugin);
      if ("reason" in plugin) return refuse("recipe-source", plugin.reason);
      if (plugin.file.header.kind !== "animation") return refuse("bad-argument", `"${input.plugin}" is a recipe plugin. Use recipe_run for it.`);
      source = plugin.file.body; api = plugin.file.header.api; pluginCopy = { sha256: plugin.file.sha256, text: plugin.file.text };
    }
  }
  const name = slugOf(typeof input.name === "string" ? input.name : defaultName);
  if (!name) return refuse("bad-argument", "Give the animation a name with letters or digits.");
  if (api) {
    const verdict = apiVerdict(api, this.crateLevels());
    if (!verdict.ok) return refuse(verdict.code, verdict.reason);
  }
  if (!this.recipeHost) this.recipeHost = new RecipeHost({ crateDir: recipeCrateDir(SESSION_URL), moduleUrl: SESSION_URL });
  const parts: AnimationPart[] = [];
  for (const member of assembly.members) {
    const row = this.find(member.object);
    if (!row) return refuse("bad-assembly", `Assembly member ${member.object} is missing.`);
    const solid = row.solid && row.solid.positions.length >= 9;
    parts.push({ object: row.id, name: row.name, positions: solid ? row.solid!.positions : posedPositions(row.source, seatLift(row.seatMm)) });
  }
  const params = { ...savedParams, ...(input.params ?? {}) as Record<string, unknown> };
  const result = await runAnimation(this.recipeHost, source, params, assembly, (id) => this.find(id)?.modelPose, parts, { fps: typeof input.fps === "number" ? input.fps : undefined, signal: meta?.signal, progress: (fraction, message) => this.noteStage(message || "animation", fraction) });
  if (!result.ok) return { ok: false, code: "animation-refused", reason: result.reason, ...(result.issues ? { issues: result.issues } : {}), ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) };
  const sampled = result.result;
  // Repeated intersections are one warning per pair, not one line per frame.
  const warningCounts = new Map<string, { first: string; count: number }>();
  for (const warning of sampled.warnings) {
    const reason = warning.reason.replace(/^Frame \d+: /, "");
    const seen = warningCounts.get(reason);
    if (seen) seen.count++;
    else warningCounts.set(reason, { first: warning.reason, count: 1 });
  }
  const warnings = [...warningCounts.values()].map(({ first, count }) => ({ reason: count > 1 ? `${first} (${count} frames)` : first }));
  const out = input.out as { gif?: string; frames?: string } | undefined;
  // Checked already: the tool's by readBackground above, the script's by sampleAnimation.
  const scripted = result.background ? readBackground(result.background) : undefined;
  const background = asked && "rgb" in asked ? asked.rgb : scripted && "rgb" in scripted ? scripted.rgb : BACKGROUND;
  const summary = { ok: true, frames: sampled.frames.length, durationS: sampled.durationS, fps: sampled.fps, keys: sampled.keys, ...(warnings.length ? { warnings } : {}), ...(result.notes.length ? { notes: result.notes } : {}) };
  if (!out) return { ...summary, rig: animationRig(assembly, parts).map(({ name, parent, joint, aligned }) => ({ name, parent, joint, ...(aligned === undefined ? {} : { aligned }) })) };
  if (!out.gif && !out.frames) return refuse("missing-argument", "out needs gif or frames.");
  if (!sampled.bounds) return refuse("no-mesh", "The assembly has no renderable geometry.");
  const read = readCamera(input.camera ?? result.camera ?? "iso");
  if ("reason" in read) return refuse("bad-view", read.reason);
  const edge = typeof input.longEdge === "number" ? input.longEdge : 640;
  if (out.gif && sampled.frames.length * edge * edge * 3 > 256 * 1024 * 1024) return refuse("bad-argument", "This GIF is too large to encode in memory. Lower the size, duration or fps.");
  const gifPath = out.gif ? resolveWrite(out.gif, ".gif") : undefined;
  const files: string[] = [];
  if (out.frames) for (let i = 0; i < sampled.frames.length; i++) files.push(resolveWrite(join(out.frames, `frame-${String(i + 1).padStart(3, "0")}.png`), ".png"));
  const gifFrames: GifFrame[] = [];
  for (let i = 0; i < sampled.frames.length; i++) {
    if (meta?.signal?.aborted) return refuse("cancelled", "The animation was cancelled.");
    const frame = sampled.frames[i]!;
    let start = 0;
    const tints: { start: number; end: number; rgb: [number, number, number] }[] = [];
    const meshes = parts.map((part) => {
      const positions = part.positions!, pose = frame.poses.get(part.object);
      const mesh = pose ? posedPositions(positions, pose) : positions;
      const end = start + mesh.length / 9;
      const color = frame.colors.get(part.object);
      if (color) { const n = parseInt(color.replace(/^#/, ""), 16); tints.push({ start, end, rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255] }); }
      start = end;
      return mesh;
    });
    const drawn = renderMesh(joinedPositions(meshes), read.camera, edge, undefined, { fit: sampled.bounds, partTints: tints, pixels: !!gifPath, background });
    if (files[i]) writeFileSync(files[i]!, drawn.png);
    if (gifPath) gifFrames.push({ rgb: drawn.rgb!, delayCs: Math.round((i + 1) * 100 / sampled.fps) - Math.round(i * 100 / sampled.fps) });
    this.noteStage(`Rendering frame ${i + 1}/${sampled.frames.length}`, (i + 1) / sampled.frames.length);
  }
  if (gifPath) writeFileSync(gifPath, animatedGif(edge, edge, gifFrames, background));
  this.animations.set(name, { source, assembly: assembly.id, params, ...(api ? { api } : {}), ...(typeof input.plugin === "string" ? { plugin: input.plugin } : {}) });
  if (pluginCopy) this.projectPlugins.set(pluginCopy.sha256, pluginCopy.text);
  this.autosaveDirty = true;
  return { ...summary, files: { ...(gifPath ? { gif: gifPath } : {}), ...(out.frames ? { frames: out.frames, count: files.length } : {}) } };
}
export const animationMethods = { poseAnimate };
export const animationHandlers: Record<string, ToolHandler> = { pose_animate: (session, input, meta) => session.poseAnimate(input, meta) };
