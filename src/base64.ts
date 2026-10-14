/** Base64 of `bytes`. The engine's own encoder takes 6 ms on a 24 MB mesh, where chunked btoa takes 0.54 s. */
export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/** The bytes of base64 `text`, or null when it is not base64. The engine's own decoder when it has one. */
export function base64ToBytes(text: string): Uint8Array | null {
  const native = (Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array }).fromBase64;
  try {
    if (native) return native.call(Uint8Array, text);
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
