import type { OverrideDocument } from "../overrides.ts";

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch));
}

function num(field: string, label: string, value: string, min: number, max: number, step: number): string {
  return `<label class="field setting" data-label="${esc(label.toLowerCase())}">${esc(label)}<input data-field="${field}" type="number" min="${min}" max="${max}" step="${step}" value="${esc(value)}" aria-label="${esc(label)}" /></label>`;
}

function optional(value: number | undefined, digits = 0): string {
  if (value === undefined) return "";
  if (digits === 0) return String(value);
  return String(Math.round(value * 10 ** digits) / 10 ** digits);
}

export function overrideSectionHtml(doc: OverrideDocument, selectedId: string | null, tool: "move" | "scale"): string {
  const ranges = doc.ranges.map((range) => `
    <div class="override-card" data-override-card data-range="${esc(range.id)}">
      ${num("zFrom", "From Z mm", String(range.zFrom), 0, 1000, 0.1)}
      ${num("zTo", "To Z mm", String(range.zTo), 0, 1000, 0.1)}
      ${num("infill", "Infill %", optional(range.override.infill === undefined ? undefined : range.override.infill * 100), 0, 100, 1)}
      ${num("walls", "Walls", optional(range.override.walls), 0, 20, 1)}
      ${num("speed", "Speed mm/s", optional(range.override.speed), 1, 1000, 1)}
      <button class="btn" type="button" data-override-remove="range">Remove range</button>
    </div>`).join("");
  const volumes = doc.volumes.map((volume) => `
    <div class="override-card${volume.id === selectedId ? " is-selected" : ""}" data-override-card data-volume="${esc(volume.id)}">
      <button class="btn" type="button" data-override-select="${esc(volume.id)}" aria-pressed="${volume.id === selectedId ? "true" : "false"}">${esc(volumeLabel(volume.kind))}</button>
      ${num("x", "X mm", String(volume.x), -500, 1500, 0.1)}
      ${num("y", "Y mm", String(volume.y), -500, 1500, 0.1)}
      ${num("z", "Z mm", String(volume.z), -500, 1500, 0.1)}
      ${num("sx", "Size X mm", String(volume.sx), 0.2, 1000, 0.1)}
      ${num("sy", "Size Y mm", String(volume.sy), 0.2, 1000, 0.1)}
      ${num("sz", "Size Z mm", String(volume.sz), 0.2, 1000, 0.1)}
      ${num("infill", "Infill %", optional(volume.override.infill === undefined ? undefined : volume.override.infill * 100), 0, 100, 1)}
      ${num("walls", "Walls", optional(volume.override.walls), 0, 20, 1)}
      ${num("speed", "Speed mm/s", optional(volume.override.speed), 1, 1000, 1)}
      <button class="btn" type="button" data-override-remove="volume">Remove volume</button>
    </div>`).join("");
  return `
    <p class="meta">Infill, walls, and speed are stored with the project. Slice does not send them yet.</p>
    <p class="meta">Layer height stays the one slice setting. A range cannot change it until the engine accepts that.</p>
    <h3>Height ranges</h3>
    <div id="heightList">${ranges || `<p class="meta">No height ranges.</p>`}</div>
    <button class="btn" id="heightAdd" type="button">Add range</button>
    <h3>Modifier volumes</h3>
    <div class="row">
      <button class="btn" id="volumeBox" type="button">Box</button>
      <button class="btn" id="volumeCylinder" type="button">Cylinder</button>
      <button class="btn" id="volumeSphere" type="button">Sphere</button>
      <button class="btn" id="modToolMove" type="button" aria-pressed="${tool === "move" ? "true" : "false"}">Move</button>
      <button class="btn" id="modToolScale" type="button" aria-pressed="${tool === "scale" ? "true" : "false"}">Scale</button>
    </div>
    <p class="meta">Move and scale use the gizmo on the shape. Shift snaps 1 mm.</p>
    <div id="volumeList">${volumes || `<p class="meta">No modifier volumes.</p>`}</div>`;
}

function volumeLabel(kind: "box" | "cylinder" | "sphere"): string {
  if (kind === "box") return "Box";
  if (kind === "cylinder") return "Cylinder";
  return "Sphere";
}
