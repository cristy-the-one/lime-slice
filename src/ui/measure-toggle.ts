import { createElement, Ruler } from "lucide";
import { measureOn, onMeasureChange, setMeasureOn } from "../measure-pref";

/** The Measure switch in the view bar: it carries the stored preference, and follows it when a key changes it. */
export function mountMeasureToggle() {
  const box = document.querySelector<HTMLInputElement>("#measureOn");
  const face = document.querySelector<HTMLElement>("#measureField .view-toggle-face");
  if (!box || !face) return;
  face.prepend(createElement(Ruler, { width: 13, height: 13, "aria-hidden": "true", class: "ico" }));
  box.checked = measureOn();
  box.addEventListener("change", () => setMeasureOn(box.checked));
  onMeasureChange(() => {
    box.checked = measureOn();
  });
}
