/**
 * Printer start and end G-code are header and footer text on the exported
 * file. The slice request does not carry them, and the engine preamble stays,
 * unless the start block owns heating and homing.
 *
 * Blank text, and the old built-in comment templates (`; Name` and
 * `; end Name`), leave the engine file unchanged.
 */

/** The comment a built-in printer used to store before the text was applied. */
export function legacyStockStart(printerName: string): string {
  return `; ${printerName}`;
}

/** The matching end comment. */
export function legacyStockEnd(printerName: string): string {
  return `; end ${printerName}`;
}

/**
 * Start and end text that should be spliced. The old stock comments are
 * blank, so a library saved before this existed still exports the engine file.
 */
export function spliceText(text: string, stock: string): string {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === stock) return "";
  return trimmed;
}

export interface MachineOptions {
  /** The start block heats and homes by itself, so the engine's own heat and `G28` lines go. */
  startOwnsHoming?: boolean;
  /** Fills `{bed}` and `{nozzle}` in the start and end text. */
  heat?: { bedC: number; nozzleC: number };
  /** Comment lines written after the file's leading comment header. */
  notes?: string[];
}

/**
 * `gcode` with `start` after the engine has heated and homed, and `end` before
 * the engine cooldown. Either argument blank leaves that side untouched. Both
 * blank and no notes returns `gcode` with the same bytes.
 *
 * A start block purges with a hot nozzle and its mesh probe survives, since
 * the engine's `G28` came first. After it the engine waits for its own
 * temperatures again, goes back to absolute moves and extrusion, and zeroes
 * E, so a block that cools, purges, or switches to relative moves cannot
 * throw off the first layer.
 *
 * With `startOwnsHoming` the start block comes first instead, right after the
 * comment header, and the heat, `G28`, `G90`, `M82`, and `G92 E0` lines of the
 * engine preamble are dropped. The wait for the engine's temperatures and the
 * return to absolute E follow the block as before.
 */
export function withMachineGcode(gcode: string, start: string, end: string, options: MachineOptions = {}): string {
  const heat = options.heat;
  const fill = (text: string) => heat === undefined
    ? text
    : text.replaceAll("{bed}", String(heat.bedC)).replaceAll("{nozzle}", String(heat.nozzleC));
  const head = fill(start.trim());
  const tail = fill(end.trim());
  const notes = options.notes ?? [];
  if (head === "" && tail === "" && notes.length === 0) return gcode;
  let out = gcode;
  if (notes.length > 0) {
    const at = headerEnd(out);
    out = `${out.slice(0, at)}${notes.join("\n")}\n${out.slice(at)}`;
  }
  if (head !== "") out = options.startOwnsHoming === true ? ownStart(out, head) : afterEngineStart(out, head);
  if (tail !== "") {
    const cooldown = out.lastIndexOf("M106 S0\nM104 S0\nM140 S0\n");
    if (cooldown >= 0) {
      out = `${out.slice(0, cooldown)}${tail}\n${out.slice(cooldown)}`;
    } else {
      const motors = out.lastIndexOf("\nM84\n");
      if (motors >= 0) {
        out = `${out.slice(0, motors + 1)}${tail}\n${out.slice(motors + 1)}`;
      } else {
        out = out.endsWith("\n") ? `${out}${tail}\n` : `${out}\n${tail}\n`;
      }
    }
  }
  return out;
}

function afterEngineStart(gcode: string, head: string): string {
  const at = afterHoming(gcode);
  return `${gcode.slice(0, at)}${head}\n${restore(gcode.slice(0, at))}${gcode.slice(at)}`;
}

/** Engine preamble lines the start block replaces. `G21` and the comments stay. */
const OWNED_BY_START = /^(?:(?:M140|M104|M190|M109) S[\d.]+|G28\b.*|G92 E0|G90|M82)$/;

function ownStart(gcode: string, head: string): string {
  const header = headerEnd(gcode);
  const at = afterHoming(gcode);
  const preamble = gcode.slice(header, at);
  const kept = preamble.split("\n").filter((line) => line !== "" && !OWNED_BY_START.test(line));
  const rest = kept.length > 0 ? `${kept.join("\n")}\n` : "";
  return `${gcode.slice(0, header)}${head}\n${restore(preamble)}${rest}${gcode.slice(at)}`;
}

/** The end of the leading comment header. */
function headerEnd(gcode: string): number {
  return /^(?:;.*\n)*/.exec(gcode)![0].length;
}

/**
 * Where the start block goes: after the engine's `G28` and the `G92 E0` that
 * follows it, or after the leading comment header when the file never homes.
 */
function afterHoming(gcode: string): number {
  const home = /^G28\b.*\n(?:G92 E0\n)?/m.exec(gcode);
  if (home) return home.index + home[0].length;
  return headerEnd(gcode);
}

/** The engine's heating, waited for again, then absolute moves and E at zero. */
function restore(preamble: string): string {
  const heat = ["M140", "M104", "M190", "M109"]
    .map((code) => new RegExp(`^${code} S[\\d.]+$`, "m").exec(preamble)?.[0])
    .filter((line): line is string => line !== undefined);
  return [...heat, "G90", "M82", "G92 E0"].join("\n") + "\n";
}
