/** Images a tool result carries beside its JSON. `JSON.stringify` skips a symbol key, so the text stays plain. */

export interface InlineImage {
  data: string;
  mimeType: string;
}

const IMAGES = Symbol("lime.inline-images");

export function withImages<T extends object>(value: T, images: InlineImage[]): T {
  if (images.length > 0) Object.defineProperty(value, IMAGES, { value: images, enumerable: false });
  return value;
}

export function imagesOf(value: unknown): InlineImage[] {
  if (!value || typeof value !== "object") return [];
  return (value as { [IMAGES]?: InlineImage[] })[IMAGES] ?? [];
}

export function pngImage(png: Uint8Array): InlineImage {
  return { data: Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString("base64"), mimeType: "image/png" };
}
