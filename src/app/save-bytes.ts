/**
 * Save a binary export as the app saves every one (File, Export 3MF, Model's STEP button): the desktop app's save dialog
 * with `name` and `extension` offered, or, in the web build, a download named `name`.
 */
import { bytesToBase64 } from "../base64";

export async function saveBytes(bytes: ArrayBuffer | Uint8Array, name: string, extension: string, type: string) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  if (tauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_text_file", { text: "", defaultName: name, extension, bytesB64: bytesToBase64(data) });
    return;
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}
