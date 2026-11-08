/** Animated GIF with one fixed RGB palette shared by every frame. */
export interface GifFrame { rgb: Uint8Array; delayCs: number }

/** A compact LZW stream. GIF codes are packed least-significant bit first. */
function compress(indices: Uint8Array): number[] {
  const clear = 256, stop = 257;
  let next = 258, width = 9, bits = 0, count = 0;
  const bytes: number[] = [], dict = new Map<number, number>();
  const emit = (code: number) => {
    bits |= code << count; count += width;
    while (count >= 8) { bytes.push(bits & 255); bits >>>= 8; count -= 8; }
  };
  emit(clear);
  let current = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const byte = indices[i]!, pair = current * 256 + byte, found = dict.get(pair);
    if (found !== undefined) { current = found; continue; }
    emit(current);
    if (next < 4096) {
      dict.set(pair, next++);
      // The decoder adds its corresponding entry after the next code, one behind the encoder.
      if (next > (1 << width) && width < 12) width++;
    } else {
      emit(clear); dict.clear(); next = 258; width = 9;
    }
    current = byte;
  }
  emit(current); emit(stop);
  if (count) bytes.push(bits & 255);
  return bytes;
}

/** Encode opaque RGB frames using a consistent 3/3/2-bit colour palette. */
export function animatedGif(width: number, height: number, frames: readonly GifFrame[]): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 65535 || height > 65535 || !frames.length) throw new Error("GIF needs a nonempty set of frames with valid dimensions.");
  const bytes: number[] = [];
  const byte = (...v: number[]) => bytes.push(...v);
  const word = (v: number) => byte(v & 255, (v >>> 8) & 255);
  byte(...new TextEncoder().encode("GIF89a")); word(width); word(height); byte(0xf7, 0, 0);
  for (let i = 0; i < 256; i++) byte(Math.round(((i >> 5) & 7) * 255 / 7), Math.round(((i >> 2) & 7) * 255 / 7), Math.round((i & 3) * 255 / 3));
  byte(0x21, 0xff, 11, ...new TextEncoder().encode("NETSCAPE2.0"), 3, 1, 0, 0, 0);
  for (const frame of frames) {
    if (frame.rgb.length !== width * height * 3 || !Number.isFinite(frame.delayCs) || frame.delayCs < 0 || frame.delayCs > 65535) throw new Error("GIF frame dimensions or delay are invalid.");
    byte(0x21, 0xf9, 4, 4); word(Math.round(frame.delayCs)); byte(0, 0);
    byte(0x2c); word(0); word(0); word(width); word(height); byte(0, 8);
    const indices = new Uint8Array(width * height);
    for (let i = 0; i < indices.length; i++) indices[i] = (frame.rgb[3 * i]! & 0xe0) | ((frame.rgb[3 * i + 1]! & 0xe0) >> 3) | (frame.rgb[3 * i + 2]! >> 6);
    const compressed = compress(indices);
    for (let at = 0; at < compressed.length; at += 255) { const part = compressed.slice(at, at + 255); byte(part.length, ...part); }
    byte(0);
  }
  byte(0x3b);
  return Uint8Array.from(bytes);
}
