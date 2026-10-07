/**
 * Printer start and end G-code are header and footer text on the exported
 * file. The slice request does not carry them, and the engine preamble stays.
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

/**
 * `gcode` with `start` after the engine has heated and homed, and `end` before
 * the engine cooldown. Either argument blank leaves that side untouched. Both
 * blank returns `gcode` with the same bytes.
 *
 * A start block purges with a hot nozzle and its mesh probe survives, since
 * the engine's `G28` came first. After it the engine waits for its own
 * temperatures again, goes back to absolute moves and extrusion, and zeroes
 * E, so a block that cools, purges, or switches to relative moves cannot
 * throw off the first layer.
 */
export function withMachineGcode(gcode: string, start: string, end: string): string {
  const head = start.trim();
  const tail = end.trim();
  if (head === "" && tail === "") return gcode;
  let out = gcode;
  if (head !== "") {
    const at = afterHoming(out);
    out = `${out.slice(0, at)}${head}\n${restore(out.slice(0, at))}${out.slice(at)}`;
  }
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

/**
 * Where the start block goes: after the engine's `G28` and the `G92 E0` that
 * follows it, or after the leading comment header when the file never homes.
 */
function afterHoming(gcode: string): number {
  const home = /^G28\b.*\n(?:G92 E0\n)?/m.exec(gcode);
  if (home) return home.index + home[0].length;
  const header = /^(?:;.*\n)*/.exec(gcode);
  return header ? header[0].length : 0;
}

/** The engine's heating, waited for again, then absolute moves and E at zero. */
function restore(preamble: string): string {
  const heat = ["M140", "M104", "M190", "M109"]
    .map((code) => new RegExp(`^${code} S[\\d.]+$`, "m").exec(preamble)?.[0])
    .filter((line): line is string => line !== undefined);
  return [...heat, "G90", "M82", "G92 E0"].join("\n") + "\n";
}
