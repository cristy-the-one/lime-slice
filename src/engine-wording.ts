/**
 * The slicer names the request field in an error (`belt.widthMm`).
 * The banner says what that field is.
 *
 * A cartesian slice omits `belt` (`beltSliceField(null)`), so the width check
 * runs only when the active printer is a belt. 250 mm is the Ideaformer IR3 V2.
 * A split half parked beside a 220 mm plate is what stretches the span to about 440 mm.
 */

const BELT_FIELD: Record<string, string> = {
  widthMm: "Belt width",
  maxLengthMm: "Belt length",
  angleDeg: "Belt angle",
  axis: "Belt axis",
  direction: "Belt direction",
  copies: "Belt copies",
  gapMm: "Belt gap",
  raftLayers: "Belt raft",
};

export function humanEngineError(message: string): string {
  const narrow = /^belt\.widthMm (\S+) is narrower than the part, which is (\d+(?:\.\d+)?) mm across the belt$/.exec(message);
  if (narrow) {
    return `The belt is ${narrow[1]} mm wide, and this plate is ${narrow[2]} mm across it.`;
  }
  const length = /^belt\.maxLengthMm (\S+) is shorter than the belt run of (\d+(?:\.\d+)?) mm$/.exec(message);
  if (length) {
    return `The belt's max length is ${length[1]} mm, shorter than this run of ${length[2]} mm.`;
  }
  return message.replace(/\bbelt\.([A-Za-z0-9]+)/g, (all, key: string) => BELT_FIELD[key] ?? all);
}
