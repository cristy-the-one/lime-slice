/**
 * A PNG of raw RGBA pixels. Used when the 3D view is drawn into a thumbnail.
 * `CompressionStream` is the deflate; this file does not import a native zlib binding.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE), as PNG chunks and zip entries carry it. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Nearest-neighbour shrink so the long edge is `longEdge`. */
export function downscaleRgba(src: Uint8Array, width: number, height: number, longEdge: number): { rgba: Uint8Array; width: number; height: number } {
  const scale = longEdge / Math.max(width, height);
  if (scale >= 1) return { rgba: src, width, height };
  const nextW = Math.max(1, Math.round(width * scale));
  const nextH = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(nextW * nextH * 4);
  for (let y = 0; y < nextH; y += 1) {
    const sy = Math.min(height - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < nextW; x += 1) {
      const sx = Math.min(width - 1, Math.floor((x + 0.5) / scale));
      out.set(src.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * nextW + x) * 4);
    }
  }
  return { rgba: out, width: nextW, height: nextH };
}

export function rgbaIsBlank(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) return false;
  return true;
}

/** 8-bit non-interlaced RGBA PNG. Null when the bytes do not fit or deflate is missing. */
export async function encodeRgbaPng(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array | null> {
  if (width < 1 || height < 1 || rgba.length !== width * height * 4) return null;
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    raw[row] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), row + 1);
  }
  const idat = await zlibDeflate(raw);
  if (!idat) return null;
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

async function zlibDeflate(raw: Uint8Array): Promise<Uint8Array | null> {
  const Stream = globalThis.CompressionStream;
  if (!Stream) return null;
  try {
    const stream = new Stream("deflate");
    const writer = stream.writable.getWriter();
    // The readable side has to be pulled while the bytes are written. Waiting
    // for the write first deadlocks once the frame fills the stream queue.
    const [buffer] = await Promise.all([
      new Response(stream.readable).arrayBuffer(),
      writer.write(raw as unknown as BufferSource).then(() => writer.close()),
    ]);
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}
