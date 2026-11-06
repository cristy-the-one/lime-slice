// Converts Hershey .jhf files (the USENET distribution as packed by kamalmostafa/hershey-fonts) into the compact text the pen-font
// code reads (crates/lime-model-occt/src/text/hershey/*.hf). It only parses text; nothing in the input is executed.
//   node tools/hershey-convert.mjs <dir with the .jhf files> <out dir>
// Output: a `cap <units>` line, then one line per ASCII character: `<code> <advance> <x>,<y> <x>,<y> ; <x>,<y> ...`
// with x from the glyph's left edge and y up from the baseline, in the font's own units (the cap height is the `cap` line).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FONTS = { "hershey-simplex": "futural", "hershey-duplex": "futuram", "hershey-complex": "rowmand", "hershey-script": "scripts", "hershey-gothic": "gothiceng" };
const [, , inDir, outDir] = process.argv;
if (!inDir || !outDir) throw new Error("usage: hershey-convert.mjs <jhf dir> <out dir>");
mkdirSync(outDir, { recursive: true });

const num = (c) => c.charCodeAt(0) - 82; // 'R' is 0

function parse(text) {
  const glyphs = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const count = Number(line.slice(5, 8));
    const data = line.slice(8);
    const left = num(data[0]);
    const right = num(data[1]);
    const strokes = [[]];
    for (let i = 1; i < count; i++) {
      const a = data[2 * i];
      const b = data[2 * i + 1];
      if (a === " " && b === "R") strokes.push([]);
      else strokes.at(-1).push([num(a) - left, num(b)]);
    }
    glyphs.push({ advance: right - left, strokes: strokes.filter((s) => s.length > 0) });
  }
  return glyphs;
}

for (const [id, source] of Object.entries(FONTS)) {
  const glyphs = parse(readFileSync(join(inDir, `${source}.jhf`), "utf8"));
  const h = glyphs["H".charCodeAt(0) - 32];
  const ys = h.strokes.flat().map((p) => p[1]);
  const baseline = Math.max(...ys);
  const cap = baseline - Math.min(...ys);
  const lines = [`cap ${cap}`];
  glyphs.forEach((g, i) => {
    const code = 32 + i;
    if (code > 126) return;
    const body = g.strokes.map((s) => s.map(([x, y]) => `${x},${baseline - y}`).join(" ")).join(" ; ");
    lines.push(`${code} ${g.advance}${body ? " " + body : ""}`);
  });
  writeFileSync(join(outDir, `${id}.hf`), lines.join("\n") + "\n");
  console.log(id, source, "cap", cap, "glyphs", lines.length - 1);
}
