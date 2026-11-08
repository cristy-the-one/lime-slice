/** A small GIF reader for tests: the global palette and each frame's decoded RGB, so a test sees what a viewer shows. */
export interface ReadGif { width: number; height: number; palette: [number, number, number][]; frames: Uint8Array[]; localPalettes: number }

function decodeLzw(codes: Uint8Array, minSize: number, count: number): Uint8Array {
  const clear = 1 << minSize, stop = clear + 1, out = new Uint8Array(count);
  let table: number[][] = [], width = minSize + 1, bits = 0, held = 0, at = 0, written = 0;
  let previous: number[] | null = null;
  const reset = () => { table = Array.from({ length: stop + 1 }, (_, i) => (i < clear ? [i] : [])); width = minSize + 1; previous = null; };
  reset();
  for (;;) {
    while (held < width) {
      if (at >= codes.length) throw new Error("GIF: the image data ended early.");
      bits |= codes[at++]! << held; held += 8;
    }
    const code = bits & ((1 << width) - 1);
    bits >>>= width; held -= width;
    if (code === clear) { reset(); continue; }
    if (code === stop) break;
    const before: number[] | null = previous;
    let entry = table[code];
    if (!entry) {
      if (!before || code !== table.length) throw new Error(`GIF: code ${code} is not in the table.`);
      entry = [...before, before[0]!];
    }
    if (written + entry.length > count) throw new Error("GIF: the frame has too many pixels.");
    out.set(entry, written); written += entry.length;
    if (before && table.length < 4096) table.push([...before, entry[0]!]);
    if (table.length === 1 << width && width < 12) width++;
    previous = entry;
  }
  if (written !== count) throw new Error(`GIF: the frame has ${written} of ${count} pixels.`);
  return out;
}

export function readGif(bytes: Uint8Array): ReadGif {
  const text = String.fromCharCode(...bytes.subarray(0, 6));
  if (text !== "GIF89a" && text !== "GIF87a") throw new Error("Not a GIF.");
  const word = (at: number) => bytes[at]! | (bytes[at + 1]! << 8);
  const width = word(6), height = word(8), flags = bytes[10]!;
  let at = 13;
  const palette: [number, number, number][] = [];
  if (flags & 0x80) {
    const size = 2 << (flags & 7);
    for (let i = 0; i < size; i++) palette.push([bytes[at + i * 3]!, bytes[at + i * 3 + 1]!, bytes[at + i * 3 + 2]!]);
    at += size * 3;
  }
  const subBlocks = () => {
    const parts: number[] = [];
    while (bytes[at] !== 0) { const size = bytes[at]!; for (let i = 1; i <= size; i++) parts.push(bytes[at + i]!); at += size + 1; }
    at++;
    return Uint8Array.from(parts);
  };
  const frames: Uint8Array[] = [];
  let localPalettes = 0;
  for (;;) {
    const block = bytes[at++];
    if (block === 0x3b) break;
    if (block === 0x21) { at++; subBlocks(); continue; }
    if (block !== 0x2c) throw new Error(`GIF: unexpected block ${block}.`);
    const image = bytes[at + 8]!;
    at += 9;
    if (image & 0x80) { localPalettes++; at += (2 << (image & 7)) * 3; }
    const minSize = bytes[at++]!;
    const indices = decodeLzw(subBlocks(), minSize, width * height);
    const rgb = new Uint8Array(width * height * 3);
    indices.forEach((index, i) => rgb.set(palette[index]!, i * 3));
    frames.push(rgb);
  }
  return { width, height, palette, frames, localPalettes };
}
