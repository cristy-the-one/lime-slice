import { measureOn, onMeasureChange, setMeasureOn } from "../measure-pref";

/**
 * The rail's Measure button, and in Model the View menu's box: both show the stored preference, flip it, and follow a
 * key that changes it.
 */
export function mountMeasureToggle() {
  const button = document.querySelector<HTMLButtonElement>("#measureField");
  const box = document.querySelector<HTMLInputElement>("#modelRulers");
  const paint = () => {
    button?.setAttribute("aria-pressed", String(measureOn()));
    if (box) box.checked = measureOn();
  };
  button?.addEventListener("click", () => setMeasureOn(!measureOn()));
  box?.addEventListener("change", () => setMeasureOn(box.checked));
  onMeasureChange(paint);
  paint();
}
