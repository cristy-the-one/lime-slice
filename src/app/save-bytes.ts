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
  download(data, name, type);
}

function bytesOf(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function download(data: Uint8Array, name: string, type: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

/**
 * Save several files at once, a split to print's STL per piece: the desktop app asks for one folder and writes every file
 * there; the web build downloads each. The answer is the folder written ("" for downloads), or null when the folder
 * pick was cancelled and nothing was written.
 */
export async function saveBytesToFolder(files: readonly { name: string; bytes: ArrayBuffer | Uint8Array }[], type: string): Promise<string | null> {
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  if (tauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    const folder = await invoke<string | null>("save_files_to_folder", { files: files.map((file) => ({ name: file.name, bytesB64: bytesToBase64(bytesOf(file.bytes)) })) });
    return folder ?? null;
  }
  for (const file of files) download(bytesOf(file.bytes), file.name, type);
  return "";
}
