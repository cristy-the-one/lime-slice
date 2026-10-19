import { measureOn, onMeasureChange, setMeasureOn } from "../measure-pref";

/** The rail's Measure button: it shows the stored preference, flips it, and follows a key that changes it. */
export function mountMeasureToggle() {
  const button = document.querySelector<HTMLButtonElement>("#measureField");
  if (!button) return;
  const paint = () => button.setAttribute("aria-pressed", String(measureOn()));
  button.addEventListener("click", () => setMeasureOn(!measureOn()));
  onMeasureChange(paint);
  paint();
}
