/** Lines a person should read. Known motion and temperature commands are counted, not listed. */

const KNOWN = /^(G0|G1|G2|G3|G21|G28|G90|G92|M82|M104|M106|M109|M140|M190|M204|M73|M900|SET_PRESSURE_ADVANCE)\b/i;

export interface ReviewLine {
  line: number;
  text: string;
}

export function reviewGcode(gcode: string): { head: string[]; tail: string[]; review: ReviewLine[] } {
  const lines = gcode.split(/\r?\n/);
  const commands = lines.filter((line) => line.trim() !== "");
  const head = commands.slice(0, 30);
  const tail = commands.slice(-30);
  const review: ReviewLine[] = [];
  lines.forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed === "" || trimmed.startsWith(";")) return;
    const word = trimmed.split(/\s+/, 1)[0] ?? "";
    if (KNOWN.test(word)) return;
    if (review.length < 50) review.push({ line: index + 1, text: trimmed.slice(0, 200) });
  });
  return { head, tail, review };
}
