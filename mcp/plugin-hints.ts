/**
 * Hints on a plugin being kept (nugget {action:"save", kind:"plugin"} and recipe_run {keep}). They are advice, never a
 * refusal: the save has happened. Each says what a person who runs the plugin would trip over and how to write it
 * so they do not. Reply data only, so tools/list does not grow. The rules are guide {kind:"recipes"}, "Writing a
 * plugin people can use".
 */
import type { PluginParam, PluginTarget } from "./plugins.ts";

/** The most parameters shown before "common first" is worth saying. */
export const MANY_PARAMS = 12;

const norm = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const FACE_NUMBER = /^(face|faceindex|faceidx|faceno|facenumber|index|idx)$/;
const MEASURE = /^(centre|center|centrex|centrey|centrez|centerx|centery|centerz|cx|cy|cz|radius|bodyradius|sphereradius)$/;
const NEEDS_PART = /\b(on a|on an|on the|needs|works on|face|sphere|cylinder|cone|flat|curved|outline|wall|edge)\b/i;

export function pluginHints(plugin: { params: PluginParam[]; target: PluginTarget; description: string }, source: string): string[] {
  const out: string[] = [];
  const { params, target } = plugin;
  const picks = params.some((p) => p.kind === "face" || p.kind === "outline");

  const faceNumbers = params.filter((p) => (p.kind === "number" || p.kind === "count") && FACE_NUMBER.test(norm(p.name)));
  if (faceNumbers.length) {
    out.push(`Pick the face with a face param instead of a number (${faceNumbers.map((p) => p.name).join(", ")}): s.face("face").rule("largest_up").get() with s.pick_face, and keep no pick working as before.`);
  }

  const measured = params.filter((p) => (p.kind === "number" || p.kind === "count") && MEASURE.test(norm(p.name)));
  if (measured.length && !picks) {
    out.push(`Read centre/radius from a picked face instead of asking for them (${measured.map((p) => p.name).join(", ")}): a face param (.curved() for a sphere or cylinder) with s.pick_face gives kind, radius, axis and surface points.`);
  }

  const code = source.replace(/\/\/[^\n]*/g, "");
  const acts = /\.(apply|apply_many)\s*\(/.test(code);
  if (target !== "new" && acts && !picks && !/\.refuse\s*\(/.test(code)) {
    out.push('A part that doesn\'t fit should get s.refuse("<one plain sentence naming what is needed>"), never a silent no-change.');
  }

  if (target !== "new") {
    const first = plugin.description.split(/[.;:,—–]|\s-\s/)[0] ?? "";
    if (!NEEDS_PART.test(first)) {
      out.push('Start the description with what part it needs ("Craters on a sphere", "Cut on a flat face"), so a person can tell before running it.');
    }
  }

  if (params.length > MANY_PARAMS) {
    out.push(`Put common params first and rare ones last, with plain labels and help: ${params.length} params is a lot to read (aim for about 10 a person must look at).`);
  }
  return out;
}
