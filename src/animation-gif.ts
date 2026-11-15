/** Animated GIF with one fixed RGB palette shared by every frame; one entry can hold an exact background colour. */
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

const paletteIndex = (r: number, g: number, b: number) => (r & 0xe0) | ((g & 0xe0) >> 3) | (b >> 6);

/**
 * The GIF's head: the screen, the one shared palette and the loop block. The palette is the fixed 3/3/2 one, with the
 * entry `background` falls in made exactly that colour, so it depends on no frame: an encoder can write the head first
 * and each frame as it is drawn, holding one frame at a time.
 */
export function gifHead(width: number, height: number, background?: readonly [number, number, number]): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 65535 || height > 65535) throw new Error("GIF needs valid dimensions.");
  const bytes: number[] = [];
  const byte = (...v: number[]) => { for (const one of v) bytes.push(one); };
  const word = (v: number) => byte(v & 255, (v >>> 8) & 255);
  byte(...new TextEncoder().encode("GIF89a")); word(width); word(height); byte(0xf7, 0, 0);
  const exact = background ? paletteIndex(background[0], background[1], background[2]) : -1;
  for (let i = 0; i < 256; i++) {
    if (i === exact) byte(background![0], background![1], background![2]);
    else byte(Math.round(((i >> 5) & 7) * 255 / 7), Math.round(((i >> 2) & 7) * 255 / 7), Math.round((i & 3) * 255 / 3));
  }
  byte(0x21, 0xff, 11, ...new TextEncoder().encode("NETSCAPE2.0"), 3, 1, 0, 0, 0);
  return Uint8Array.from(bytes);
}

/** One frame of a GIF that `gifHead` began: its delay, its image, and its LZW data in blocks of 255. */
export function gifFrame(width: number, height: number, frame: GifFrame): Uint8Array {
  if (frame.rgb.length !== width * height * 3 || !Number.isFinite(frame.delayCs) || frame.delayCs < 0 || frame.delayCs > 65535) throw new Error("GIF frame dimensions or delay are invalid.");
  const indices = new Uint8Array(width * height);
  for (let i = 0; i < indices.length; i++) indices[i] = paletteIndex(frame.rgb[3 * i]!, frame.rgb[3 * i + 1]!, frame.rgb[3 * i + 2]!);
  const compressed = compress(indices);
  const blocks = Math.ceil(compressed.length / 255);
  const out = new Uint8Array(8 + 10 + 1 + compressed.length + blocks + 1);
  const delay = Math.round(frame.delayCs);
  out.set([0x21, 0xf9, 4, 4, delay & 255, (delay >>> 8) & 255, 0, 0, 0x2c, 0, 0, 0, 0, width & 255, (width >>> 8) & 255, height & 255, (height >>> 8) & 255, 0, 8]);
  let at = 19;
  for (let from = 0; from < compressed.length; from += 255) {
    const part = compressed.slice(from, from + 255);
    out[at++] = part.length;
    out.set(part, at);
    at += part.length;
  }
  out[at] = 0;
  return out;
}

/** The byte that ends a GIF. */
export const GIF_END = Uint8Array.of(0x3b);

/**
 * Encode opaque RGB frames using a consistent 3/3/2-bit colour palette. With `background`, the palette entry that colour
 * falls in becomes exactly that colour, so background pixels decode unchanged. Other pixels in the same entry take it
 * too: they are already within one quantisation step of it. The same bytes as `gifHead`, each `gifFrame` and `GIF_END`.
 */
export function animatedGif(width: number, height: number, frames: readonly GifFrame[], background?: readonly [number, number, number]): Uint8Array {
  if (!frames.length) throw new Error("GIF needs a nonempty set of frames with valid dimensions.");
  const parts = [gifHead(width, height, background), ...frames.map((frame) => gifFrame(width, height, frame)), GIF_END];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
