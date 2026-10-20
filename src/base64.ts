type NodeBuffer = Uint8Array & { toString(encoding: "base64"): string };
type NodeBufferStatic = {
  from(source: ArrayBufferLike | string, offsetOrEncoding?: number | "base64", length?: number): NodeBuffer;
};

/** Node's Buffer, where there is one. A webview has none and uses the engine's own or the chunked path below. */
function nodeBuffer(): NodeBufferStatic | undefined {
  return (globalThis as { Buffer?: NodeBufferStatic }).Buffer;
}

/** Base64 of `bytes`. The engine's own encoder takes 6 ms on a 24 MB mesh, where chunked btoa takes 0.54 s. */
export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  const buffer = nodeBuffer();
  if (buffer) return buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/**
 * `bytesToBase64` for a webview that has neither the engine's encoder nor Buffer: the browser's own encoder, through a
 * Blob and a FileReader, is native code where the chunked path above builds the text a character at a time (a 44 MB
 * project took 1.7 s there, against 0.1 s here).
 */
export async function bytesToBase64Async(bytes: Uint8Array): Promise<string> {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native || nodeBuffer() || typeof FileReader === "undefined" || typeof Blob === "undefined") return bytesToBase64(bytes);
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(new Blob([bytes as BlobPart]));
    });
    const comma = url.indexOf(",");
    if (url.startsWith("data:") && comma > 0 && url.slice(0, comma).endsWith(";base64")) return url.slice(comma + 1);
  } catch {
    // Fall through to the chunked path.
  }
  return bytesToBase64(bytes);
}

/** The bytes of base64 `text`, or null when it is not base64. The engine's own decoder when it has one. */
export function base64ToBytes(text: string): Uint8Array | null {
  const native = (Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array }).fromBase64;
  try {
    if (native) return native.call(Uint8Array, text);
    const buffer = nodeBuffer();
    if (buffer) {
      // Buffer skips what is not base64 instead of refusing it, and reads the URL-safe - and _: a length that is not the text's, or either of those, sends the text to the strict path.
      const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
      const expected = Math.floor(((text.length - padding) * 3) / 4);
      const made = buffer.from(text, "base64");
      if (made.length === expected && text.length % 4 === 0 && !text.includes("-") && !text.includes("_")) {
        // A small Buffer is a slice of a shared pool: hand back bytes that own their memory.
        return made.byteOffset === 0 && made.buffer.byteLength === made.length ? new Uint8Array(made.buffer, 0, made.length) : new Uint8Array(made);
      }
    }
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
