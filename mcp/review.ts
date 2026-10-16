/** Lines a person should read. Known motion is counted. Custom and machine text is always listed. */

const KNOWN = /^(G0|G1|G2|G3|G21|G28|G90|G92|M82|M104|M106|M109|M140|M190|M204|M73|M900|SET_PRESSURE_ADVANCE)\b/i;

export interface ReviewLine {
  line: number;
  text: string;
}

export interface ReviewOptions {
  /** Lines from a layer action or from machine start or end G-code. Listed even when the code is ordinary. */
  custom?: readonly string[];
  /** Nozzle temperature this filament allows. A hotter command is named. */
  maxNozzleC?: number;
}

function commandsOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith(";"));
}

export function reviewGcode(gcode: string, options: ReviewOptions = {}): { head: string[]; tail: string[]; review: ReviewLine[]; custom: ReviewLine[] } {
  const lines = gcode.split(/\r?\n/);
  const commands = lines.filter((line) => line.trim() !== "");
  const head = commands.slice(0, 30);
  const tail = commands.slice(-30);
  const customSet = new Set((options.custom ?? []).flatMap((block) => commandsOf(block)));
  const review: ReviewLine[] = [];
  const custom: ReviewLine[] = [];
  lines.forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed === "" || trimmed.startsWith(";")) return;
    const word = trimmed.split(/\s+/, 1)[0] ?? "";
    const shown = trimmed.slice(0, 200);
    const row = { line: index + 1, text: shown };
    if (customSet.has(trimmed) && custom.length < 50) custom.push(row);
    if (KNOWN.test(word)) return;
    if (review.length < 50) review.push(row);
  });
  if (typeof options.maxNozzleC === "number") {
    for (const row of custom) {
      const heat = /(?:M104|M109)\b[^;]*\bS(\d+(?:\.\d+)?)/i.exec(row.text);
      const temp = heat ? Number(heat[1]) : NaN;
      if (Number.isFinite(temp) && temp > options.maxNozzleC) {
        row.text = `${row.text} (hotter than this filament's ${options.maxNozzleC} °C limit)`;
      }
    }
  }
  return { head, tail, review, custom };
}
