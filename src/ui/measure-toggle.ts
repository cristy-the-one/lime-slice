import { measureOn, onMeasureChange, setMeasureOn } from "../measure-pref";

/**
 * The rail's Measure button, and in Model the View menu's box: both show the stored preference, flip it, and follow a
 * key that changes it. The box comes with the Model module, so it is bound by `mountModelRulers` when that loads.
 */
export function mountMeasureToggle() {
  const button = document.querySelector<HTMLButtonElement>("#measureField");
  const paint = () => {
    button?.setAttribute("aria-pressed", String(measureOn()));
  };
  button?.addEventListener("click", () => setMeasureOn(!measureOn()));
  onMeasureChange(paint);
  paint();
}

/** Model's View menu box for the same preference. */
export function mountModelRulers() {
  const box = document.querySelector<HTMLInputElement>("#modelRulers");
  if (!box) return;
  const paint = () => {
    box.checked = measureOn();
  };
  box.addEventListener("change", () => setMeasureOn(box.checked));
  onMeasureChange(paint);
  paint();
}
