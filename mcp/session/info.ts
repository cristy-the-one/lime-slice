/**
 * session_info and guide.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { appVersion } from "../export-gcode.ts";
import { listLibrary, pluginsDir } from "../plugins.ts";
import { ingredientLines, ingredientsDir } from "../ingredients.ts";
import { listLessons, listPresets, seenInPractice } from "../nuggets.ts";
import { GUIDES, guideByUri, KIND_GUIDES, TEXT_FONT_LINES, TEXT_OWN_FONT_LINES, TEXT_REFUSALS } from "../guides.ts";
import { OP_KINDS, OP_SUMMARY, opSchemaFor } from "../schema.ts";
import { COMPOSITE_KINDS, isComposite, MAX_PIECES } from "../../src/modeling/compose.ts";
import { shownName, type ToolHandler } from "./shared.ts";
import type { Session } from "../session.ts";
import { NEXT, refuse } from "../refusals.ts";
import { bridgeHumanContext, bridgeReceipts, bridgeStatus } from "../bridge-client.ts";
import { tandemEarlier } from "../tandem-receipts.ts";
import type { Mat3 } from "../../src/mesh-place.ts";

/** Why the desktop holds parts back and what clears each, or "" when none is. Older desktops send only `conflict`. */
function heldParts(human: Record<string, unknown>): string {
  const rows = Array.isArray(human.conflicts) ? human.conflicts.filter((row): row is Record<string, unknown> => !!row && typeof row === "object") : [];
  const said = rows.map((row) => (typeof row.reason === "string" ? row.reason : typeof row.name === "string" ? row.name : "")).filter(Boolean);
  if (said.length) return `${said.join(" ")} Pull once that is cleared.`;
  return typeof human.conflict === "string" && human.conflict ? `The desktop held back MCP's update to ${human.conflict}; reconcile it before pulling.` : "";
}

/** Pull plate placements only after every changed part passes the same baseline check. */
async function tandemPull(this: Session): Promise<Record<string, unknown>> {
  const value = await bridgeHumanContext();
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse("tandem-unavailable", "The Tandem desktop is not connected or cannot provide context.");
  const human = value as Record<string, unknown>;
  if (human.mirrorSession !== this.bridgeSession) return refuse("tandem-conflict", "The desktop and MCP do not have the same mirrored session.");
  const held = heldParts(human);
  if (held) return refuse("tandem-conflict", held);
  if (human.mirrorSeq !== this.bridgePlateSeq || this.bridgePlateSeq === 0) return refuse("tandem-busy", "The desktop has not applied the latest MCP plate snapshot. Wait for its receipt before pulling.");
  if (this.inflight !== 1) return refuse("tandem-busy", "Another MCP operation is still running. Wait for it before pulling.");
  if (human.gesture !== false || human.editing !== false) return refuse("tandem-busy", "Finish the active desktop edit before pulling its placements.");
  if (human.humanChangesTruncated !== false || !Array.isArray(human.humanChanges)) return refuse("tandem-unavailable", "The desktop change summary is unavailable or incomplete.");
  const updates: Array<{ obj: NonNullable<ReturnType<Session["find"]>>; offset: { x: number; y: number; z: number }; orient: Mat3; scale: number; centered: boolean }> = [];
  const ids = new Set<string>();
  for (const raw of human.humanChanges) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refuse("bad-argument", "The desktop change summary is invalid.");
    const row = raw as Record<string, unknown>;
    if (typeof row.object !== "string" || ids.has(row.object) || row.removed || row.meshChanged !== false || !row.base || typeof row.base !== "object" || Array.isArray(row.base)) return refuse("tandem-unsupported", "Tandem can currently pull placements only; removals, meshes and invalid changes need manual reconciliation.");
    ids.add(row.object);
    const obj = this.find(row.object);
    const base = row.base as Record<string, unknown>;
    if (!obj || shownName(obj.name) !== base.name || row.name !== base.name || obj.scale * 100 !== base.scalePercent || obj.centered !== base.centered || this.meshHashOf(obj.bytes) !== base.meshHash || JSON.stringify(obj.offset) !== JSON.stringify(base.offset) || JSON.stringify(obj.orient) !== JSON.stringify(base.orient)) return refuse("tandem-conflict", `The MCP version of ${row.object} no longer matches the desktop baseline; reconcile it first.`);
    const offset = row.offset as Record<string, unknown> | undefined;
    const orient = row.orient;
    if (!offset || typeof offset !== "object" || ![offset.x, offset.y, offset.z, row.scalePercent].every((n) => typeof n === "number" && Number.isFinite(n)) || (row.scalePercent as number) <= 0 || typeof row.centered !== "boolean" || !Array.isArray(orient) || orient.length !== 9 || !orient.every((n) => typeof n === "number" && Number.isFinite(n))) return refuse("bad-argument", `The desktop placement for ${row.object} is invalid.`);
    updates.push({ obj, offset: { x: offset.x as number, y: offset.y as number, z: offset.z as number }, orient: [...orient] as Mat3, scale: (row.scalePercent as number) / 100, centered: row.centered });
  }
  if (updates.length === 0) return { ok: true, changed: [] };
  this.remember("Tandem human placements");
  for (const update of updates) Object.assign(update.obj, { offset: update.offset, orient: update.orient, scale: update.scale, centered: update.centered });
  this.relink();
  return { ok: true, changed: updates.map((update) => update.obj.id) };
}

async function sessionInfo(this: Session): Promise<Record<string, unknown>> {
  let engine: string | null = null;
  let occt = false;
  let reason = "";
  let where: { path: string; installed: boolean } | null = null;
  try {
    engine = await this.ask(this.engine.version());
    occt = await this.ask(this.engine.occt());
    where = (await this.ask(this.engine.where?.())) ?? null;
  } catch (err) {
    reason = err instanceof Error ? err.message : "The engine did not answer.";
  }
  const running = this.workJobs.find((row) => !row.done);
  const assemblies = this.liveAssemblies();
  const [status, human, receipts, earlier] = await Promise.all([bridgeStatus(), bridgeHumanContext(), bridgeReceipts(), tandemEarlier(this, null)]);
  // Always present, so an agent can tell a missing bridge from a quiet one (feedback 2026-11-09, section 3).
  const tandem = {
    bridge: status.bridge,
    ...(status.why ? { why: status.why } : {}),
    ...(status.url ? { url: status.url } : {}),
    ...(human ? { human } : {}),
    ...(receipts ? { receipts: receipts.slice(-8) } : {}),
    ...(earlier.length ? { earlier } : {}),
    note: status.bridge === "connected"
      ? "MCP changes show in the window live, shape and Model history included; what they replace there is one Ctrl+Z away. Each change's reply has tandemReceipt (applied, applied-replaced, waiting, no-bridge…). tandem_pull imports the person's placements."
      : "No window is connected: app_open reloads the whole file in the app, and later changes do not show live.",
  };
  return {
    ok: true,
    serverVersion: appVersion(),
    tandem,
    engine,
    ...(where ? { enginePath: where.path, ...(where.installed ? { engineNote: "This checkout has no engine built, so the installed app's engine of the same version answers." } : {}) } : {}),
    occt,
    ...(reason ? { reason } : {}),
    workspace: process.env.LIME_MCP_WORKSPACE ?? "",
    ...(this.previousAutosave ? { autosave: this.previousAutosave } : {}),
    ...((this.recipeCheckpoints.size || Object.keys(this.previousAutosave?.checkpoints ?? {}).length) ? { recipeCheckpoints: [...new Set([...this.recipeCheckpoints.keys(), ...Object.keys(this.previousAutosave?.checkpoints ?? {})])] } : {}),
    ...(running ? { job: { job: running.handle, tool: running.tool, ...(running.object ? { object: running.object } : {}), ...(running.ctx.stage ? { stage: running.ctx.stage } : {}) } } : {}),
    printer: this.printer().name,
    filament: this.filament().name,
    ...(assemblies.length ? { assemblies: assemblies.map((row) => ({ assembly: row.name, members: row.members.map((member) => member.object), ...(row.members.some((member) => member.joint) ? { joints: row.members.filter((member) => member.joint).map((member) => ({ object: member.object, joint: structuredClone(member.joint) })) } : {}) })) } : {}),
    printerSend: false,
    plugins: this.pluginsLine(),
    nuggets: this.nuggetsLine(),
    model: {
      ops: ["boolean", "extrude", "revolve", "loft", "sweep", "shell", "faceExtrude", "moveFaces", "hole", "fillet", "chamfer", "transition", "split", "partition", "scale", "join", "root"],
      composite: [...COMPOSITE_KINDS],
      primitives: ["box", "cylinder", "sphere", "ellipsoid", "cone", "torus", "wedge", "polygon", "tube"],
      // --- 3.1 F16. A limit per call, as the app's composite tools have it, not per history: one object's history
      // passed 500 steps over several calls, which is fine, and maxSteps read as if it should have stopped there.
      maxStepsPerCall: MAX_PIECES,
      stepLimit: `One composite, batch, or build makes at most ${MAX_PIECES} kernel steps; the op that would pass that is refused like any other refusal. A history has no limit: split the work over several calls.`,
      expressions: true,
      guides: GUIDES.map((row) => row.uri.replace("lime://guide/", "")),
    },
  };
}

/** "Plugins: N in your library; M drafts in this session." for session_info. */
function pluginsLine(this: Session): string {
  let count = 0;
  try {
    count = listLibrary(pluginsDir()).length;
  } catch {
    count = 0;
  }
  const drafts = new Set([...this.rustRecipes.keys()].map((key) => key.split("@")[0])).size;
  return `Plugins: ${count} in your library (${pluginsDir()}); ${drafts} draft${drafts === 1 ? "" : "s"} in this session. nugget {action:"find", query} finds one.`;
}

/** --- I16. "Nuggets: 6 ingredients, 9 presets, 14 lessons." for session_info. */
function nuggetsLine(this: Session): string {
  let counts = [0, 0, 0];
  try {
    counts = [listLibrary(ingredientsDir(), "ingredient").length, listPresets().length, listLessons().length];
  } catch {
    counts = [0, 0, 0];
  }
  const say = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `Nuggets: ${say(counts[0]!, "ingredient")}, ${say(counts[1]!, "preset")}, ${say(counts[2]!, "lesson")}.`;
}

/** The worked guides as a tool, for clients that do not read resources. */
function guide(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input.kind === "string") {
    const kind = input.kind.trim();
    if (kind === "recipes") return this.guide({ topic: "recipes" });
    const text = Object.hasOwn(KIND_GUIDES, kind) ? KIND_GUIDES[kind] : undefined;
    const answer = text ? { ok: true, kind, text } : this.opGuide(kind);
    // --- I15. "Seen in practice": the user's lessons about this kind, newest first. Data, never instructions.
    const seen = answer.ok === true ? seenInPractice(kind) : [];
    return seen.length ? { ...answer, data: { seenInPractice: seen } } : answer;
  }
  const topic = typeof input.topic === "string" ? input.topic.trim().toLowerCase() : "";
  if (!topic) return { ok: true, topics: GUIDES.map((row) => ({ topic: row.uri.replace("lime://guide/", ""), name: row.name, tools: row.tools })) };
  const found = guideByUri(`lime://guide/${topic}`);
  if (!found) return refuse("unknown-topic", `There is no guide named ${topic}. Topics: ${GUIDES.map((row) => row.uri.replace("lime://guide/", "")).join(", ")}.`, undefined, NEXT.guide);
  // The recipes guide ends with the user's kept ingredients by name, so one is found before a new one is written.
  const text = topic === "recipes" ? [found.text, ...ingredientLines()].join("\n") : found.text;
  return { ok: true, topic, name: found.name, tools: found.tools, text };
}

/** One op kind's full schema, its line from tools/list, and the ops guide's lines about it. */
function opGuide(this: Session, kind: string): Record<string, unknown> {
  const schema = opSchemaFor(kind);
  if (!schema) return refuse("unknown-topic", `There is no op kind ${kind}. Kinds: ${OP_KINDS.join(", ")}.`, undefined, NEXT.guide);
  const ops = guideByUri("lime://guide/ops")?.text.split("\n") ?? [];
  const examples = ops.filter((line) => new RegExp(`^\\s*(\\w+, )*${kind}[:,]`).test(line) || line.includes(`kind:\"${kind}\"`));
  // --- Text with real fonts: the bundled fonts, one line each, and what a text refuses.
  const fonts = kind === "text" ? { fonts: [...TEXT_FONT_LINES, ...TEXT_OWN_FONT_LINES, ...this.fonts.list().map((font) => `${font.name}: your font, in this project. Id ${font.id}${font.weight ? `, weights ${font.weight.min} to ${font.weight.max}` : ""}${font.restricted ? ". Its licence forbids embedding, so the project keeps only the outlines of the letters used" : ""}.`)], refusals: TEXT_REFUSALS } : {};
  return { ok: true, kind, summary: OP_SUMMARY[kind], composite: isComposite(kind), schema, examples, ...fonts };
}

/** The methods this module adds to Session. */
export const infoMethods = {
  tandemPull,
  sessionInfo,
  pluginsLine,
  nuggetsLine,
  guide,
  opGuide,
};

export const infoHandlers: Record<string, ToolHandler> = {
  tandem_pull: (s) => s.tandemPull(),
  session_info: (s) => s.sessionInfo(),
  guide: (s, input) => s.guide(input),
};
