/**
 * The lean form of a reply, as a chat reads it. A recipe, a kept plugin and the app's own recipe calls read the
 * replies the shared code builds (src/modeling/model-calls.ts) and must replay byte for byte, so nothing is trimmed
 * there: the session trims the answer of a call made from the chat (and of a plan's step, in the plan's reply) here,
 * after the call ran. `full: true` on the call, or LIME_MCP_LEAN=0 for the whole server, gives the reply as it was.
 *
 * From an audit of 36 sessions: a face row was about 90 tokens (its frame 40%, its box 25%) and an edge row 44 (mid and
 * dir repeat start and end), with values like 1.1368683772161603e-15 and 10.000000000000007.
 */

/** A flat face's frame comes with this many rows or fewer, or with frames: true. */
export const FRAME_ROWS = 3;

type Row = Record<string, unknown>;

/** Every number at 1e-4 (a ten-thousandth of a mm or of a degree), without a negative zero. `turn` keeps its 1e-6. */
function rounded(value: unknown, key = ""): unknown {
  if (typeof value === "number") return Number.isFinite(value) && key !== "turn" ? Math.round(value * 1e4) / 1e4 + 0 : value;
  if (Array.isArray(value)) return value.map((item) => rounded(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Row).map(([name, item]) => [name, rounded(item, name)]));
  return value;
}

function leanFace(row: Row, input: Row, frames: boolean): Row {
  const { bbox, frame, ...rest } = row;
  return rounded({ ...rest, ...(input.bbox === true && bbox !== undefined ? { bbox } : {}), ...(frames && frame !== undefined ? { frame } : {}) }) as Row;
}

/** A straight edge is its start and end: its mid is halfway and its dir runs from one to the other. A curved one keeps mid. */
function leanEdge(row: Row): Row {
  if (row.dir === undefined) return rounded(row) as Row;
  const { mid: _mid, dir: _dir, ...rest } = row;
  return rounded(rest) as Row;
}

export function leanOff(input: Row): boolean {
  return input.full === true || process.env.LIME_MCP_LEAN === "0";
}

/** `value` as a chat reads it: the reply of `tool` called with `input`. A refusal, or a tool with no lean form, is unchanged. */
export function leanReply(tool: string, input: Row, value: Row): Row {
  if (value.ok !== true || leanOff(input)) return value;
  if (tool === "model_describe" || tool === "faces_find" || tool === "edges_find") {
    const faces = Array.isArray(value.faces) ? (value.faces as Row[]) : null;
    const edges = Array.isArray(value.edges) ? (value.edges as Row[]) : null;
    const frames = input.frames === true || (faces !== null && faces.length <= FRAME_ROWS);
    return {
      ...value,
      ...(value.bounds !== undefined ? { bounds: rounded(value.bounds) } : {}),
      ...(typeof value.volumeMm3 === "number" ? { volumeMm3: rounded(value.volumeMm3) } : {}),
      ...(faces ? { faces: faces.map((row) => leanFace(row, input, frames)) } : {}),
      ...(edges ? { edges: edges.map(leanEdge) } : {}),
    };
  }
  return value;
}
