/**
 * Pose export over MCP (docs/plan-pose-export.md, D6):
 * pose_export {assembly, format, frame?, animation?, path?, chordMm?, step?, stl?}
 * Writes STEP (AP242 assembly tree or 7.0 flat), glTF 2.0 binary (.glb, optionally animated),
 * 3MF assembly, STL (one file or ZIP per member), OBJ + MTL, or Pose sheet (.json) at the
 * current pose or at a sampled animation frame without mutating the assembly or print layout.
 */
import { writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { assemblyOf, type Assembly } from "../../src/assembly.ts";
import { IDENTITY_POSE, seatLift, type Affine } from "../../src/model-space.ts";
import { gotoRequest } from "../../src/model-request.ts";
import { solidView } from "../../src/modeling/model-calls.ts";
import { animationRig, type AnimationPart, type AnimationResult } from "../../src/pose-anim.ts";
import {
  configLabel,
  defaultMemberColor,
  encodePose3mf,
  encodePoseGlb,
  encodePoseObjMtl,
  encodePoseSheet,
  encodePoseStl,
  orderExportMembers,
  poseExportFileName,
  type PoseExportConfig,
  type PoseExportFormat,
} from "../../src/pose-export.ts";
import { apiVerdict } from "../../src/recipe/api-level.ts";
import { explainNoMember, missingMember } from "../../src/anim-members.ts";
import { runAnimation } from "../animation-run.ts";
import { slugOf, type PluginHeader } from "../plugins.ts";
import { RecipeHost, recipeCrateDir } from "../recipe.ts";
import { NEXT, refuse } from "../refusals.ts";
import { SESSION_URL } from "../session-url.ts";
import { resolveWrite } from "../workspace.ts";
import { CHORD, posedPositions, shownName, type CallMeta, type PlateObject, type ToolHandler } from "./shared.ts";
import type { Session } from "../session.ts";

const VALID_FORMATS = new Set<PoseExportFormat>(["step", "glb", "3mf", "stl", "obj", "pose"]);

function resolveTargetAssembly(session: Session, raw: unknown): Assembly | null {
  const live = session.liveAssemblies();
  if (!live.length) return null;
  if (typeof raw === "string" && raw.trim()) {
    const wanted = raw.trim();
    const byId = live.find((a) => a.id === wanted);
    if (byId) return byId;
    const byName = live.find((a) => a.name === wanted);
    if (byName) return byName;
    const lower = wanted.toLowerCase();
    const byNameCi = live.find((a) => a.name.toLowerCase() === lower);
    if (byNameCi) return byNameCi;
    const obj = session.find(wanted);
    if (obj) {
      const byMember = assemblyOf(live, obj.id);
      if (byMember) return byMember;
    }
    return null;
  }
  if (session.selected) {
    const bySelected = assemblyOf(live, session.selected);
    if (bySelected) return bySelected;
  }
  return live.length === 1 ? live[0]! : null;
}

function partKeyOf(session: Session, part: PlateObject, keyFallback: string): string {
  if (part.bytes.byteLength > 0) return session.meshHashOf(part.bytes);
  if (part.solid && part.solid.positions.length >= 9) return session.meshKeyOf(part.solid.positions);
  if (part.source.length >= 9) return session.meshKeyOf(part.source);
  return keyFallback;
}

async function sampleNamedAnimation(
  session: Session,
  assembly: Assembly,
  animName: string,
  meta?: CallMeta,
): Promise<{ sampled: AnimationResult; title: string } | Record<string, unknown>> {
  const slug = slugOf(animName);
  const kept = session.animations.get(animName) ?? (slug ? session.animations.get(slug) : undefined);
  let source = "";
  let savedParams: Record<string, unknown> = {};
  let api: string | undefined;
  let header: PluginHeader | undefined;
  let title = animName;
  if (kept) {
    source = kept.source;
    savedParams = { ...kept.params };
    api = kept.api;
    header = session.animationHeader(kept.plugin ?? animName, kept.source);
    if (kept.assembly !== assembly.id) {
      for (const member of header?.["member-params"] ?? []) delete savedParams[member];
    }
  } else {
    const plugin = await session.pluginFile(animName);
    if ("reason" in plugin) {
      const available = [...session.animations.keys()].slice(0, 20);
      const hint = available.length ? ` Kept animations: ${available.join(", ")}.` : "";
      return refuse("no-draft", `No kept animation or animation plugin named "${animName}".${hint}`);
    }
    if (plugin.file.header.kind !== "animation") {
      return refuse("bad-argument", `"${animName}" is a recipe plugin, not an animation.`);
    }
    source = plugin.file.body;
    api = plugin.file.header.api;
    header = plugin.file.header;
    title = plugin.file.header.title || animName;
  }
  if (api) {
    const verdict = apiVerdict(api, session.crateLevels());
    if (!verdict.ok) return refuse(verdict.code, verdict.reason);
  }
  if (!session.recipeHost) {
    session.recipeHost = new RecipeHost({ crateDir: recipeCrateDir(SESSION_URL), moduleUrl: SESSION_URL });
  }
  const parts: AnimationPart[] = [];
  for (const member of assembly.members) {
    const row = session.find(member.object);
    if (!row) return refuse("bad-assembly", `Assembly member ${member.object} is missing.`);
    const solid = row.solid && row.solid.positions.length >= 9;
    parts.push({
      object: row.id,
      name: row.name,
      positions: solid ? row.solid!.positions : posedPositions(row.source, seatLift(row.seatMm)),
      ...(solid ? { chordMm: Math.max(CHORD, row.stepTolerance || CHORD) } : {}),
    });
  }
  const rig = animationRig(assembly, parts);
  if (header) {
    const missing = missingMember(rig, header["member-params"], header["member-names"], header.params, savedParams);
    if (missing) return refuse("animation-refused", missing);
  }
  const result = await runAnimation(
    session.recipeHost,
    source,
    savedParams,
    assembly,
    (id) => session.find(id)?.modelPose,
    parts,
    {
      ...(header?.["member-optional"] ? { optional: header["member-optional"] } : {}),
      signal: meta?.signal,
      progress: (fraction, msg) => session.noteStage(msg || "animation", fraction),
    },
  );
  if (!result.ok) {
    return refuse("animation-refused", explainNoMember(result.reason, savedParams, rig));
  }
  return { sampled: result.result, title };
}

async function positionsForPart(session: Session, part: PlateObject, chordMm: number): Promise<Float32Array> {
  const hasSolid = !!(part.solid && part.solid.positions.length >= 9);
  const currentChord = part.stepTolerance || CHORD;
  if ((hasSolid || part.tree) && Math.abs(chordMm - currentChord) > 1e-6) {
    const tree = await session.opened(part);
    if (!("reason" in tree)) {
      const reply = await session.treeCall(gotoRequest(tree.key, tree.current, chordMm), "export");
      const view = solidView(reply);
      if (view && view.positions.length >= 9) return view.positions;
    }
  }
  if (hasSolid) return part.solid!.positions;
  return posedPositions(part.source, seatLift(part.seatMm));
}

async function poseExport(this: Session, input: Record<string, unknown>, meta?: CallMeta): Promise<Record<string, unknown>> {
  const assembly = resolveTargetAssembly(this, input.assembly);
  if (!assembly) {
    return refuse(
      "no-assembly",
      typeof input.assembly === "string"
        ? `No assembly matching "${input.assembly}" is on the plate.`
        : "Choose an assembly to export, or create one with model_place {to}.",
      undefined,
      NEXT.assembly,
    );
  }

  const format = typeof input.format === "string" ? (input.format as PoseExportFormat) : ("" as PoseExportFormat);
  if (!VALID_FORMATS.has(format)) {
    return refuse("bad-argument", "format must be one of step, glb, 3mf, stl, obj, pose.");
  }

  const stepMode = input.step === "flat" ? "flat" : "tree";
  const stlMode = input.stl === "each" ? "each" : "one";
  const chordMm = typeof input.chordMm === "number" ? input.chordMm : CHORD;
  if (!Number.isFinite(chordMm) || chordMm < 0.01 || chordMm > 1) {
    return refuse("bad-argument", "chordMm must be between 0.01 and 1 mm.");
  }

  // Optional frame: {animation, t}
  let exportAssembly: Assembly = assembly;
  let config: PoseExportConfig = { kind: "now" };
  let poseMap: ReadonlyMap<string, Affine> | undefined;
  let colorMap: ReadonlyMap<string, string> | undefined;
  let sampledCache: { name: string; sampled: AnimationResult; title: string } | null = null;

  if (input.frame !== undefined) {
    const rawFrame = input.frame as { animation?: unknown; t?: unknown } | null;
    if (!rawFrame || typeof rawFrame !== "object" || typeof rawFrame.animation !== "string" || typeof rawFrame.t !== "number" || !Number.isFinite(rawFrame.t)) {
      return refuse("bad-argument", "frame needs {animation, t} with a finite time t in seconds.");
    }
    if (rawFrame.t < 0) return refuse("bad-argument", "frame.t must be at least 0 seconds.");
    const ran = await sampleNamedAnimation(this, assembly, rawFrame.animation, meta);
    if ("ok" in ran) return ran;
    const { sampled, title } = ran as { sampled: AnimationResult; title: string };
    sampledCache = { name: rawFrame.animation, sampled, title };
    if (!sampled.frames.length) return refuse("animation-refused", "That animation produced no frames.");
    const maxT = sampled.durationS + 1 / sampled.fps;
    if (rawFrame.t > maxT + 1e-6) {
      return refuse("bad-argument", `frame.t (${rawFrame.t} s) is past the animation's duration (${sampled.durationS} s).`);
    }
    const idx = Math.min(sampled.frames.length - 1, Math.max(0, Math.round(rawFrame.t * sampled.fps)));
    const picked = sampled.frames[idx]!;
    exportAssembly = picked.assembly;
    poseMap = picked.poses;
    colorMap = picked.colors;
    config = { kind: "frame", animation: title, frameIndex: idx, timeS: picked.time };
  }

  const poses = new Map<string, Affine>();
  const colors = new Map<string, string>();
  for (let i = 0; i < exportAssembly.members.length; i += 1) {
    const member = exportAssembly.members[i]!;
    const part = this.find(member.object);
    if (!part) return refuse("bad-assembly", `Assembly member ${member.object} is missing.`);
    poses.set(member.object, poseMap?.get(member.object) ?? part.modelPose ?? IDENTITY_POSE);
    colors.set(member.object, colorMap?.get(member.object) ?? defaultMemberColor(i));
  }

  const label = configLabel(config);
  const frameReply = config.kind === "frame" ? { frame: config.frameIndex + 1, timeS: config.timeS } : {};
  const defaultName = poseExportFileName(assembly.name, format, config, stlMode);
  const ext = format === "step" ? ".step"
    : format === "glb" ? ".glb"
    : format === "3mf" ? ".3mf"
    : format === "stl" ? (stlMode === "each" ? ".zip" : ".stl")
    : format === "obj" ? ".obj"
    : ".json";
  const targetName = typeof input.path === "string" && input.path.trim() ? input.path.trim() : defaultName;

  if (format === "step") {
    const rootMember = exportAssembly.members.find((m) => m.parent === null) ?? exportAssembly.members[0];
    const rootObj = rootMember ? this.find(rootMember.object) : undefined;
    if (!rootObj) return refuse("no-assembly", "This assembly has no part on the plate.", undefined, NEXT.assembly);
    const res = await this.exportAssemblyStep(rootObj, targetName, stepMode === "flat", {
      assembly: exportAssembly,
      poses,
      colors,
    });
    if (res.ok !== true) return res;
    const distinctParts = typeof res.distinctParts === "number" ? res.distinctParts : exportAssembly.members.length;
    const membersCount = typeof res.solids === "number" ? res.solids : exportAssembly.members.length;
    const bytes = Number(res.bytes ?? 0);
    return {
      ok: true,
      path: res.path,
      format: "step",
      step: stepMode,
      bytes,
      assembly: assembly.name,
      configuration: label,
      ...frameReply,
      members: membersCount,
      parts: distinctParts,
      note: `Wrote ${assembly.name} (${label}) as STEP (${stepMode === "flat" ? "flat" : "AP242 assembly tree"}): ${membersCount} members, ${distinctParts} ${distinctParts === 1 ? "part" : "parts"} (${bytes} bytes).`,
    };
  }

  const outPath = resolveWrite(targetName, ext);

  const keyFor = (id: string): string => {
    const part = this.find(id);
    return part ? partKeyOf(this, part, part.id) : id;
  };

  const meshByKey = new Map<string, Float32Array>();
  if (format !== "pose") {
    for (const member of exportAssembly.members) {
      const part = this.find(member.object)!;
      const key = keyFor(part.id);
      if (meshByKey.has(key)) continue;
      const positions = await positionsForPart(this, part, chordMm);
      if (positions.length < 9) {
        return refuse("bad-assembly", `${shownName(part.name)} has no triangles to export.`);
      }
      meshByKey.set(key, positions);
    }
  }

  const ordered = orderExportMembers(
    exportAssembly,
    (id) => this.find(id)?.name ?? id,
    keyFor,
    (id) => meshByKey.get(keyFor(id)) ?? new Float32Array(0),
    (id) => poses.get(id),
    (id) => colors.get(id),
  );
  if (!ordered.members.length) return refuse("no-assembly", "This assembly has no part on the plate.", undefined, NEXT.assembly);

  if (format === "pose") {
    const bytes = encodePoseSheet(ordered, config);
    writeFileSync(outPath, bytes);
    return {
      ok: true,
      path: outPath,
      format: "pose",
      bytes: bytes.byteLength,
      assembly: assembly.name,
      configuration: label,
      ...frameReply,
      members: ordered.members.length,
      parts: ordered.parts.length,
      note: `Wrote ${assembly.name} (${label}) pose sheet: ${ordered.members.length} members (${bytes.byteLength} bytes).`,
    };
  }

  if (format === "glb") {
    let glbAnimSpec: { name: string; sampled: AnimationResult } | undefined;
    if (typeof input.animation === "string" && input.animation.trim()) {
      const animName = input.animation.trim();
      if (sampledCache && sampledCache.name === animName) {
        glbAnimSpec = { name: sampledCache.title, sampled: sampledCache.sampled };
      } else {
        const ran = await sampleNamedAnimation(this, assembly, animName, meta);
        if ("ok" in ran) return ran;
        const { sampled, title } = ran as { sampled: AnimationResult; title: string };
        glbAnimSpec = { name: title, sampled };
      }
    }
    const bytes = encodePoseGlb(ordered, glbAnimSpec);
    writeFileSync(outPath, bytes);
    const animInfo = glbAnimSpec ? { name: glbAnimSpec.name, frames: glbAnimSpec.sampled.frames.length, durationS: glbAnimSpec.sampled.durationS, fps: glbAnimSpec.sampled.fps } : undefined;
    const animNote = animInfo ? `, animated (${animInfo.frames} frames)` : "";
    return {
      ok: true,
      path: outPath,
      format: "glb",
      bytes: bytes.byteLength,
      assembly: assembly.name,
      configuration: label,
      ...frameReply,
      members: ordered.members.length,
      parts: ordered.parts.length,
      ...(animInfo ? { animation: animInfo } : {}),
      note: `Wrote ${assembly.name} (${label}) as glTF binary: ${ordered.members.length} members, ${ordered.parts.length} ${ordered.parts.length === 1 ? "part" : "parts"}${animNote} (${bytes.byteLength} bytes).`,
    };
  }

  if (format === "3mf") {
    const bytes = encodePose3mf(ordered);
    writeFileSync(outPath, bytes);
    return {
      ok: true,
      path: outPath,
      format: "3mf",
      bytes: bytes.byteLength,
      assembly: assembly.name,
      configuration: label,
      ...frameReply,
      members: ordered.members.length,
      parts: ordered.parts.length,
      note: `Wrote ${assembly.name} (${label}) as 3MF assembly: ${ordered.members.length} members, ${ordered.parts.length} ${ordered.parts.length === 1 ? "part" : "parts"} (${bytes.byteLength} bytes).`,
    };
  }

  if (format === "stl") {
    const bytes = encodePoseStl(ordered, stlMode);
    writeFileSync(outPath, bytes);
    const triangles = ordered.members.reduce((sum, row) => sum + ((ordered.parts[row.partIndex]?.positions.length ?? 0) / 9), 0);
    return {
      ok: true,
      path: outPath,
      format: "stl",
      stl: stlMode,
      bytes: bytes.byteLength,
      assembly: assembly.name,
      configuration: label,
      ...frameReply,
      members: ordered.members.length,
      parts: ordered.parts.length,
      triangles,
      note: `Wrote ${assembly.name} (${label}) as ${stlMode === "each" ? "STL ZIP (one per member)" : "STL"}: ${ordered.members.length} members, ${triangles} triangles (${bytes.byteLength} bytes).`,
    };
  }

  // OBJ + MTL
  const mtlName = basename(outPath).replace(/\.obj$/i, ".mtl");
  const out = encodePoseObjMtl(ordered, mtlName);
  const mtlPath = resolveWrite(join(dirname(outPath), mtlName), ".mtl");
  writeFileSync(outPath, out.obj);
  writeFileSync(mtlPath, out.mtl);
  const totalBytes = out.obj.byteLength + out.mtl.byteLength;
  return {
    ok: true,
    path: outPath,
    mtlPath,
    format: "obj",
    bytes: totalBytes,
    assembly: assembly.name,
    configuration: label,
    ...frameReply,
    members: ordered.members.length,
    parts: ordered.parts.length,
    triangles: out.triangles,
    note: `Wrote ${assembly.name} (${label}) as OBJ + MTL: ${ordered.members.length} members, ${out.triangles} triangles (${totalBytes} bytes).`,
  };
}

export const poseExportMethods = { poseExport };
export const poseExportHandlers: Record<string, ToolHandler> = {
  pose_export: (session, input, meta) => session.poseExport(input, meta),
};
