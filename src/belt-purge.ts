/**
 * Where a belt printer's purge line sits, so it touches the part.
 *
 * The IR3 V2 start draws a line across the belt, then zeroes the belt on it (`G92 E0 Z{purge_line_z}`).
 * With the belt at zero the part's first wall can start a millimetre or more past the line, on bare
 * belt. This finds where the part's first wall first touches the belt, in the file's own belt
 * coordinates (`Z` on a Z-axis belt), and puts the line's far edge at that wall's centre.
 *
 * The gcode here is the engine's body, or its skeleton (`gcode_skeleton.rs`), which keeps every line
 * this reads. Keep that file's `BeltReads` in step with the lines read below.
 */

/** Filament pushed across the belt by one line of the built-in start (`G1 X250 E25`), and its length in mm. */
export const PURGE_LINE_E_MM = 25;
export const PURGE_LINE_LENGTH_MM = 250;
/** The line's width when the filament diameter or the layer height is unknown. */
export const PURGE_LINE_WIDTH_MM = 1.2;
/** How far above the first layer's height an extrusion may end and still touch the belt. */
const TOUCH_SLACK_MM = 0.01;

/** The width of the purge line: its cross-section over the first layer's height. */
export function purgeLineWidth(filamentDiameterMm: number | undefined, layerHeightMm: number): number {
  if (filamentDiameterMm === undefined || !(filamentDiameterMm > 0) || !(layerHeightMm > 0)) return PURGE_LINE_WIDTH_MM;
  const area = Math.PI * (filamentDiameterMm / 2) ** 2;
  return (PURGE_LINE_E_MM * area) / PURGE_LINE_LENGTH_MM / layerHeightMm;
}

/**
 * The belt position for `G92 E0 Z...`, rounded to 3 decimals. Zero when the file is not a belt file
 * with a Z belt running the positive way, or has no layers: the old behaviour, the belt's zero on the line.
 *
 * `c` is the smallest belt position of a non-support extrusion that ends within the first layer's
 * height of the belt, or of any extrusion that does when no part does, or the first layer's own
 * position when none does. The line is placed that far along, less half its width.
 */
export function purgeLineZ(gcode: string, filamentDiameterMm?: number): number {
  const belt = /^; belt: angle \S+ axis (\w) dir ([+-]1)$/m.exec(gcode);
  if (!belt || belt[1] !== "Z" || belt[2] !== "+1") return 0;
  let z = 0;
  let firstZ: number | undefined;
  let height: number | undefined;
  let support = false;
  let part = Infinity;
  let any = Infinity;
  let at = 0;
  while (at < gcode.length) {
    let end = gcode.indexOf("\n", at);
    if (end < 0) end = gcode.length;
    const first = gcode.charCodeAt(at);
    if (first === 59 /* ; */) {
      if (gcode.startsWith(";LAYER:", at)) {
        const line = gcode.slice(at, end);
        const zWord = / Z:(-?[\d.]+)/.exec(line);
        if (zWord) z = Number(zWord[1]);
        if (height === undefined) {
          const h = / H:([\d.]+)/.exec(line);
          if (h) height = Number(h[1]);
          if (zWord) firstZ = z;
        }
      } else if (gcode.startsWith(";TYPE:", at)) {
        support = gcode.startsWith(";TYPE:SUPPORT", at);
      }
    } else if (first === 71 /* G */ && height !== undefined && isMove(gcode, at)) {
      if (endsAtBelt(gcode.slice(at, end), height)) {
        if (z < any) any = z;
        if (!support && z < part) part = z;
      }
    }
    at = end + 1;
  }
  if (height === undefined) return 0;
  const c = Number.isFinite(part) ? part : Number.isFinite(any) ? any : (firstZ ?? 0);
  return Math.round((c - purgeLineWidth(filamentDiameterMm, height) / 2) * 1000) / 1000 + 0;
}

/** Whether the line at `at` starts `G1 `, `G2 `, or `G3 `. */
function isMove(text: string, at: number): boolean {
  const n = text.charCodeAt(at + 1);
  return n >= 49 && n <= 51 && text.charCodeAt(at + 2) === 32;
}

/** An extrusion move whose end is within the first layer's height of the belt. */
function endsAtBelt(line: string, height: number): boolean {
  let extrudes = false;
  let y = NaN;
  for (const word of line.split(" ").slice(1)) {
    if (word.startsWith("E")) extrudes = true;
    else if (word.startsWith("Y")) y = Number(word.slice(1));
  }
  return extrudes && y <= height + TOUCH_SLACK_MM;
}
