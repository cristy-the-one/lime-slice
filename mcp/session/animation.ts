/** MCP animation execution and export; sampling is always performed on a copy of the rig. */
import { closeSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { assemblyOf } from "../../src/assembly.ts";
import { seatLift } from "../../src/model-space.ts";
import { animationRig, endsWhereItStarts, frameTiming, type AnimationPart, type AnimationResult } from "../../src/pose-anim.ts";
import { apiVerdict } from "../../src/recipe/api-level.ts";
import { eventLoopTurn, runAnimation } from "../animation-run.ts";
import { GIF_END, gifFrame, gifHead } from "../animation-gif.ts";
import { BACKGROUND, readBackground, readCamera, renderMesh } from "../render.ts";
import { listExtra, parsePlugin, pluginsDir, readPlugin, slugOf, type PluginHeader } from "../plugins.ts";
import { explainNoMember, missingMember } from "../../src/anim-members.ts";
import { RecipeHost, recipeCrateDir, recipeSourceFile } from "../recipe.ts";
import { resolveWrite } from "../workspace.ts";
import { NEXT, refuse } from "../refusals.ts";
import { SESSION_URL } from "../session-url.ts";
import { CHORD, joinedPositions, posedPositions, type CallMeta, type ToolHandler } from "./shared.ts";
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
  // The header of the plugin run (or of a source that carries one): its parameters and the members it needs.
  let header: PluginHeader | undefined;
  if (typeof input.path === "string") {
    const file = recipeSourceFile(input.path);
    if ("reason" in file) return refuse("recipe-source", file.reason);
    source = file.text; defaultName = file.stem;
  }
  if (typeof input.plugin === "string") {
    const kept = this.animations.get(input.plugin);
    if (kept) { source = kept.source; savedParams = kept.params; api = kept.api; header = this.animationHeader(kept.plugin ?? input.plugin, kept.source); }
    else {
      const plugin = await this.pluginFile(input.plugin);
      if ("reason" in plugin) return refuse("recipe-source", plugin.reason);
      if (plugin.file.header.kind !== "animation") return refuse("bad-argument", `"${input.plugin}" is a recipe plugin. Use recipe_run for it.`);
      source = plugin.file.body; api = plugin.file.header.api; pluginCopy = { sha256: plugin.file.sha256, text: plugin.file.text }; header = plugin.file.header;
    }
  } else {
    const framed = source.startsWith("//! ---") ? parsePlugin(source) : null;
    if (framed && !("reason" in framed) && framed.header.kind === "animation") header = framed.header;
  }
  const keep = input.keep === undefined ? undefined : (input.keep && typeof input.keep === "object" ? input.keep : {}) as { title?: unknown; description?: unknown; members?: unknown };
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
    parts.push({ object: row.id, name: row.name, positions: solid ? row.solid!.positions : posedPositions(row.source, seatLift(row.seatMm)), ...(solid ? { chordMm: Math.max(CHORD, row.stepTolerance || CHORD) } : {}) });
  }
  // Member names kept with the project's animation are for the assembly it played on; another assembly starts from the defaults.
  const keptOn = typeof input.plugin === "string" ? this.animations.get(input.plugin)?.assembly : undefined;
  if (keptOn !== undefined && keptOn !== assembly.id) for (const member of header?.["member-params"] ?? []) delete savedParams[member];
  const params = { ...savedParams, ...(input.params ?? {}) as Record<string, unknown> };
  // --- docs/plan-animation-plugins.md A3. A member the plugin needs and this assembly lacks: refused before the build.
  const rig = animationRig(assembly, parts);
  if (header) {
    const missing = missingMember(rig, header["member-params"], header["member-names"], header.params, params);
    if (missing) return refuse("animation-refused", missing);
  }
  const result = await runAnimation(this.recipeHost, source, params, assembly, (id) => this.find(id)?.modelPose, parts, { fps: typeof input.fps === "number" ? input.fps : undefined, signal: meta?.signal, progress: (fraction, message) => this.noteStage(message || "animation", fraction) });
  if (!result.ok) return { ok: false, code: "animation-refused", reason: explainNoMember(result.reason, params, rig), ...(result.issues ? { issues: result.issues.map((issue) => ({ ...issue, reason: explainNoMember(issue.reason, params, rig) })) } : {}), ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) };
  const sampled = result.result;
  // Crossings come one warning a pair already (frameInterference), with the frames they hold and the check that made
  // them. A warning a key repeats (a colour set twice) is said once.
  const seen = new Set<string>();
  const warnings = sampled.warnings.filter((warning) => !seen.has(warning.reason) && !!seen.add(warning.reason));
  const timing = frameTiming(sampled);
  const out = input.out as { gif?: string; frames?: string } | undefined;
  // Checked already: the tool's by readBackground above, the script's by sampleAnimation.
  const scripted = result.background ? readBackground(result.background) : undefined;
  const background = asked && "rgb" in asked ? asked.rgb : scripted && "rgb" in scripted ? scripted.rgb : BACKGROUND;
  const summary = { ok: true, frames: sampled.frames.length, durationS: sampled.durationS, fps: sampled.fps, keys: sampled.keys, ...(warnings.length ? { warnings } : {}), ...(timing ? { frameTiming: timing } : {}), ...(result.notes.length ? { notes: result.notes } : {}) };
  // --- docs/plan-animation-plugins.md A1. keep: this run is the check; the plugin records the members it used. It is
  // kept only once the run has done all it was asked: after sampling for a dry run, after the last frame is written for
  // an export (which may have become a job; its slice_wait result then carries kept). A cancel or a failure keeps nothing.
  const keepNow = async (): Promise<Record<string, unknown>> => {
    if (!keep) return {};
    if (meta?.signal?.aborted) return { keepRefused: "The run was cancelled, so the animation was not kept." };
    return this.keepAnimation(keep, source, typeof input.plugin === "string" ? input.plugin : typeof input.name === "string" ? slugOf(input.name) : undefined, result.used, params);
  };
  if (!out) return { ...summary, ...(await keepNow()), rig: rig.map(({ name, parent, joint, aligned }) => ({ name, parent, joint, ...(aligned === undefined ? {} : { aligned }) })) };
  const written = await this.writeAnimationFrames(sampled, parts, { out, camera: input.camera ?? result.camera, longEdge: input.longEdge, background }, meta);
  if ("ok" in written) return written;
  const kept = await keepNow();
  const keptAs = "kept" in kept ? kept.kept as { id: string } : undefined;
  this.animations.set(name, { source, assembly: assembly.id, params, ...(api ? { api } : {}), ...(keptAs ? { plugin: keptAs.id } : typeof input.plugin === "string" ? { plugin: input.plugin } : {}) });
  if (pluginCopy) this.projectPlugins.set(pluginCopy.sha256, pluginCopy.text);
  if (keptAs) {
    const file = readPlugin(keptAs.id, pluginsDir());
    if (file && !("reason" in file)) this.projectPlugins.set(file.sha256, file.text);
  }
  this.autosaveDirty = true;
  return { ...summary, ...kept, files: written.files };
}

/**
 * Sampled frames drawn and written as pose_animate writes them (docs/plan-mcp-reliability.md): a GIF and/or numbered PNG
 * frames, each file under a .partial name until the last frame is done, a frame encoded and written as it is drawn, a
 * turn of the event loop before each frame so slice_cancel is heard, and every file removed on a cancel or a failure.
 * Shared by pose_animate and motion_run.
 */
async function writeAnimationFrames(this: Session, sampled: AnimationResult, parts: readonly AnimationPart[], options: { out: { gif?: string; frames?: string }; camera?: unknown; longEdge?: unknown; background: [number, number, number] }, meta?: CallMeta): Promise<{ files: Record<string, unknown> } | Record<string, unknown>> {
  const out = options.out;
  const background = options.background;
  if (!out.gif && !out.frames) return refuse("missing-argument", "out needs gif or frames.");
  if (!sampled.bounds) return refuse("no-mesh", "The assembly has no renderable geometry.");
  const read = readCamera(options.camera ?? "iso");
  if ("reason" in read) return refuse("bad-view", read.reason);
  const edge = typeof options.longEdge === "number" ? options.longEdge : 640;
  const gifPath = out.gif ? resolveWrite(out.gif, ".gif") : undefined;
  const files: string[] = [];
  if (out.frames) for (let i = 0; i < sampled.frames.length; i++) files.push(resolveWrite(join(out.frames, `frame-${String(i + 1).padStart(3, "0")}.png`), ".png"));
  // Every file is written under a .partial name and takes its own name only when the last frame is done: a cancel, a
  // failure or a restart part way leaves no half-written GIF or a short run of frames under the names asked for. One
  // frame is held at a time: the GIF's palette is fixed (3/3/2 with the background exact), so each frame is encoded and
  // written as it is drawn, and memory does not grow with the frame count.
  const partial = (path: string) => `${path}.partial`;
  // A GIF loops: a last frame that shows the first one's poses and colours is left out of it, so the loop does not
  // hold that pose twice (endsWhereItStarts). The PNG frames keep every frame.
  const gifCount = gifPath && endsWhereItStarts(sampled.frames) ? sampled.frames.length - 1 : sampled.frames.length;
  const drawCount = files.length ? sampled.frames.length : gifCount;
  const written: string[] = [];
  let gif: number | undefined;
  const clean = () => {
    if (gif !== undefined) { try { closeSync(gif); } catch { /* already closed */ } gif = undefined; }
    for (const path of written) rmSync(path, { force: true });
  };
  try {
    if (gifPath) { gif = openSync(partial(gifPath), "w"); written.push(partial(gifPath)); writeSync(gif, gifHead(edge, edge, background)); }
    for (let i = 0; i < drawCount; i++) {
      // A turn of the event loop before each frame: the server answers other calls and hears slice_cancel meanwhile.
      await eventLoopTurn();
      if (meta?.signal?.aborted) { clean(); return refuse("cancelled", `The animation was cancelled at frame ${i + 1} of ${drawCount}; no file was written.`); }
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
      const inGif = gif !== undefined && i < gifCount;
      const drawn = renderMesh(joinedPositions(meshes), read.camera, edge, undefined, { fit: sampled.bounds, partTints: tints, pixels: inGif, background });
      if (files[i]) { writeFileSync(partial(files[i]!), drawn.png); written.push(partial(files[i]!)); }
      // Frame i shows from i/fps to (i+1)/fps, in the GIF's whole hundredths: the delays add up to the frames' times.
      if (inGif) writeSync(gif!, gifFrame(edge, edge, { rgb: drawn.rgb!, delayCs: Math.round((i + 1) * 100 / sampled.fps) - Math.round(i * 100 / sampled.fps) }));
      this.noteStage(`Rendering frame ${i + 1}/${drawCount}`, (i + 1) / drawCount);
    }
    if (gif !== undefined) { writeSync(gif, GIF_END); closeSync(gif); gif = undefined; }
    for (const path of written) renameSync(path, path.slice(0, -".partial".length));
  } catch (err) {
    clean();
    throw err;
  }
  return { files: { ...(gifPath ? { gif: gifPath } : {}), ...(gifPath && gifCount !== sampled.frames.length ? { gifFrames: gifCount } : {}), ...(out.frames ? { frames: out.frames, count: files.length } : {}) } };
}
/**
 * --- docs/plan-animation-plugins.md A1. pose_animate {keep} and nugget save: the script kept as a `kind: animation`
 * plugin by `pluginSave` (its versions, its title clash note), with the member names the run used. A refused keep is a
 * sentence in the reply; the run stands.
 */
async function keepAnimation(this: Session, keep: { title?: unknown; description?: unknown; members?: unknown }, source: string, name: string | undefined, used: readonly string[] | undefined, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const saved = await this.pluginSave({ source, title: keep.title, description: keep.description, ...(name ? { name } : {}), animation: { ...(used ? { used } : {}), values, ...(keep.members !== undefined ? { members: keep.members } : {}) } });
  return "reason" in saved ? { keepRefused: saved.reason } : { kept: saved };
}

/**
 * nugget {action: "save", kind: "animation", from}: an animation this project keeps, by the name pose_animate gave it.
 * When its assembly is still here, it runs once more (a dry run) so the plugin records the members it uses; else it is
 * kept from its code and values alone.
 */
async function animationSaveFrom(this: Session, from: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const key = this.animations.has(from) ? from : slugOf(from);
  const row = this.animations.get(key);
  if (!row) return refuse("no-draft", `No animation named ${from} is kept with this project.${this.animations.size ? ` It keeps: ${[...this.animations.keys()].slice(0, 20).join(", ")}.` : " pose_animate {object, source, name, out} keeps one with the project, or keep it in the library at once with pose_animate {keep}."}`);
  const keep = { title: input.title, description: input.description, ...(input.members !== undefined ? { members: input.members } : {}) };
  const member = this.liveAssemblies().find((assembly) => assembly.id === row.assembly)?.members.find((m) => this.find(m.object));
  if (member) {
    const ran = await this.poseAnimate({ object: member.object, source: row.source, params: row.params, name: row.plugin ?? key, keep });
    if (ran.ok !== true) return refuse("plugin-invalid", `The animation did not run on its assembly, so it was not kept: ${String(ran.reason ?? "it failed.")}`);
    if (typeof ran.keepRefused === "string") return refuse("plugin-invalid", ran.keepRefused);
    const kept = ran.kept as { id: string };
    return { ok: true, ...(ran.kept as Record<string, unknown>), path: join(pluginsDir(), `${kept.id}.rs`) };
  }
  const saved = await this.pluginSave({ source: row.source, title: keep.title, description: keep.description, name: row.plugin ?? key, animation: { values: row.params, ...(keep.members !== undefined ? { members: keep.members } : {}) } });
  if ("reason" in saved) return refuse("plugin-invalid", saved.reason);
  return { ok: true, ...saved, note: "Its assembly is not on the plate, so the members it uses were not read from a run: name its member parameters with members.", path: join(pluginsDir(), `${saved.id}.rs`) };
}

/**
 * The header of an animation plugin by id, from the library, this project's copies or a read-only library; or of
 * `source` when it carries one. Never a describe run.
 */
function animationHeader(this: Session, id: string, source?: string): PluginHeader | undefined {
  const framed = source?.startsWith("//! ---") ? parsePlugin(source) : null;
  if (framed && !("reason" in framed) && framed.header.kind === "animation") return framed.header;
  const own = readPlugin(id, pluginsDir());
  if (own && !("reason" in own) && own.header.kind === "animation") return own.header;
  for (const text of this.projectPlugins.values()) {
    const file = parsePlugin(text);
    if (!("reason" in file) && file.header.plugin === id && file.header.kind === "animation") return file.header;
  }
  return listExtra().find((file) => file.header.plugin === id && file.header.kind === "animation")?.header;
}

export const animationMethods = { poseAnimate, keepAnimation, animationSaveFrom, animationHeader, writeAnimationFrames };
export const animationHandlers: Record<string, ToolHandler> = { pose_animate: (session, input, meta) => session.poseAnimate(input, meta) };
