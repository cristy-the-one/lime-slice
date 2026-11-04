/**
 * --- Recipe API 1.3 (docs/plan-text-on-curves-and-fonts.md section 4.7). The host's `text_outline` call: the letters of a text
 * as a flat outline a recipe can extrude, cut a stencil from, or test a fit with. The recipe crate reads no fonts, so the
 * engine lays the text out (`textLayout`, the same call the Text card's preview makes) and this turns its answer into the
 * `section` row shape every recipe already reads: `Section` in `lime_recipe` (`region` for `geom2d`, `loops` for `extrude`).
 *
 * The outline is centred on the origin of an identity frame (U right, V up), in millimetres, capitals `height` tall.
 */
import type { Vec2 } from "../model-tree.ts";
import type { RecipeReply } from "./host.ts";

type Body = Record<string, unknown>;

/** Points about this far apart along a curve, mm: a recipe's region and loops are polylines. */
const STEP_MM = 0.1;

/** The fields of the call that the engine's layout reads. */
const LAYOUT_FIELDS = ["text", "font", "style", "height", "spacing", "lineSpacing", "align", "angleDeg", "weight", "strokeWidth"] as const;

const round = (n: number) => Math.round(n * 1e4) / 1e4;

function polyLoop(pts: Vec2[]): Body {
  const first = pts[0]!;
  return {
    start: [round(first[0]), round(first[1])],
    segments: [...pts.slice(1), first].map((p) => ({ kind: "line", to: [round(p[0]), round(p[1])] })),
  };
}

/**
 * The reply to `text_outline {text, font, height, style?, weight?, spacing?, lineSpacing?, align?, angleDeg?, strokeWidth?}`.
 * `layout` is the engine's stateless `textLayout` call; a refusal is the layout's own sentence ("This font has no ‘ñ’...").
 */
export async function answerTextOutline(args: Body, layout: (request: Body) => Promise<Body>): Promise<RecipeReply> {
  if (typeof args.text !== "string" || !args.text.trim()) return { ok: false, error: "text_outline needs text." };
  if (typeof args.height !== "number" || !(args.height > 0)) return { ok: false, error: "text_outline needs a height: the capitals', in millimetres." };
  const request: Body = { call: "textLayout", stepMm: STEP_MM, lineMm: 0.4 };
  for (const key of LAYOUT_FIELDS) if (args[key] !== undefined) request[key] = args[key];
  if (request.font === undefined) request.font = "sans";
  const reply = await layout(request);
  if (reply.ok !== true || !Array.isArray(reply.faces)) {
    const said = typeof reply.error === "string" ? reply.error : typeof reply.reason === "string" ? reply.reason : "The letters could not be laid out.";
    return { ok: false, error: said };
  }
  const regions: { outer: Vec2[]; holes: Vec2[][] }[] = [];
  const loops: Body[] = [];
  for (const face of reply.faces as { loops?: unknown }[]) {
    if (!Array.isArray(face.loops) || face.loops.length === 0) continue;
    const rings = (face.loops as Vec2[][]).map((ring) => ring.map((p) => [round(p[0]), round(p[1])] as Vec2));
    regions.push({ outer: rings[0]!, holes: rings.slice(1) });
    for (const ring of rings) loops.push(polyLoop(ring));
  }
  if (regions.length === 0) return { ok: false, error: "The text has no letters to draw. Spaces leave no outline." };
  const row: Body = {
    frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], w: [0, 0, 1] },
    origin: [0, 0, 0],
    turn: [0, 0, 0],
    loops,
    regions,
    areaMm2: round(typeof reply.inkMm2 === "number" ? reply.inkMm2 : 0),
  };
  return { ok: true, result: { ok: true, font: reply.font, letters: regions.length, sections: [row] } };
}
