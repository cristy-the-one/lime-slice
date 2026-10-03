/**
 * A foreign 3MF can carry a slicer's settings next to the mesh.
 * This app reads the mesh only. The note names the slicer when a zip entry says so.
 * It does not parse or apply those settings.
 */

const VENDORS: readonly [string, string][] = [
  ["prusaslicer", "PrusaSlicer"],
  ["slic3r", "PrusaSlicer"],
  ["orcaslicer", "OrcaSlicer"],
  ["bambustudio", "Bambu Studio"],
  ["bambu", "Bambu Studio"],
];

/** Vendor label when the 3MF package names a slicer project, otherwise null. */
export function foreignSlicer3mf(bytes: Uint8Array): string | null {
  const names = zipEntryNames(bytes);
  if (names.length === 0) return null;
  const blob = names.join("\n").toLowerCase();
  for (const [needle, label] of VENDORS) {
    if (blob.includes(needle)) return label;
  }
  if (/(^|\n|\/)cura(\/|\n|$)/.test(blob) || blob.includes("cura.fdm")) return "Cura";
  if (blob.includes("project_settings.config") || blob.includes("model_settings.config")) return "slicer";
  return null;
}

export function foreign3mfMessage(vendor: string): string {
  const whose = vendor === "slicer" ? "Slicer" : vendor;
  return `Opened the mesh only. ${whose} settings in this 3MF were not imported.`;
}

/** File names from local and central headers. Compressed file bytes are not read. */
export function zipEntryNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  for (let i = 0; i + 30 < bytes.length; i++) {
    const sig = bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24);
    if (sig === 0x04034b50) pushName(names, bytes, i + 30, u16(bytes, i + 26));
    else if (sig === 0x02014b50 && i + 46 < bytes.length) pushName(names, bytes, i + 46, u16(bytes, i + 28));
  }
  return names;
}

function pushName(names: string[], bytes: Uint8Array, start: number, length: number) {
  if (length === 0 || length > 200 || start + length > bytes.length) return;
  let name = "";
  for (let i = 0; i < length; i++) {
    const code = bytes[start + i]!;
    if (code < 0x20 || code > 0x7e) return;
    name += String.fromCharCode(code);
  }
  names.push(name);
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}
