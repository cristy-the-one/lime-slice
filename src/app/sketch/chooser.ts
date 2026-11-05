/** The chooser's rows: the plane, the offset field. */
import { S } from "./state";
import { paragraph, planeButton, textButton } from "./cards";
import { FACE_FOR_HOLES } from "./helpers";
import { publish } from "./view";

export function chooserRow(): Node[] {
  return [
    ...(S.faceForHoles ? [paragraph(FACE_FOR_HOLES)] : []),
    paragraph("Sketch on"),
    planeButton("XY", "XY plane"),
    planeButton("XZ", "XZ plane"),
    planeButton("YZ", "YZ plane"),
    planeButton("workplane", "Workplane"),
    offsetField(),
    textButton("Cancel", { sketchCancel: "" }),
  ];
}

function offsetField(): HTMLElement {
  const label = document.createElement("label");
  label.className = "sketch-offset";
  label.append("Offset ");
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "decimal";
  input.size = 5;
  input.value = String(S.chooseOffset);
  input.dataset.sketchOffset = "";
  input.setAttribute("aria-label", "Offset of the origin plane, mm");
  input.title = "Move XY, XZ or YZ along its normal before sketching on it.";
  input.addEventListener("input", () => {
    const value = Number(input.value.trim().replace(",", "."));
    input.setAttribute("aria-invalid", Number.isFinite(value) ? "false" : "true");
    if (!Number.isFinite(value)) {
      S.host.readout("Type the offset in millimetres, such as 30 or -5.");
      return;
    }
    S.chooseOffset = value;
    publish("skip");
  });
  label.append(input, " mm");
  return label;
}

/** Keep a fixed label inside the window. A driving dimension must not slide fully off screen. */
export function placeFixed(node: HTMLElement, x: number, y: number) {
  const width = node.offsetWidth || 72;
  const height = node.offsetHeight || 22;
  const left = Math.min(window.innerWidth - 8 - width / 2, Math.max(8 + width / 2, x));
  const top = Math.min(window.innerHeight - 8 - height / 2, Math.max(8 + height / 2, y));
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}
