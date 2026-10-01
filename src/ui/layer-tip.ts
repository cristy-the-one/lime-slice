/** Thumb readout for the layer sliders: layer number and Z, without resizing the track. */
export function mountLayerTip() {
  const tip = document.createElement("div");
  tip.id = "layerTip";
  tip.className = "layer-tip";
  tip.hidden = true;
  document.body.append(tip);

  for (const id of ["#rangeHigh", "#rangeLow"]) {
    const input = document.querySelector<HTMLInputElement>(id);
    if (!input) continue;
    const show = () => placeTip(input, tip);
    input.addEventListener("pointerenter", show);
    input.addEventListener("pointermove", show);
    input.addEventListener("focus", show);
    input.addEventListener("input", show);
    input.addEventListener("pointerleave", () => {
      if (document.activeElement !== input) tip.hidden = true;
    });
    input.addEventListener("blur", () => {
      tip.hidden = true;
    });
  }
}

export function syncLayerTip() {
  for (const id of ["#rangeHigh", "#rangeLow"]) {
    const input = document.querySelector<HTMLInputElement>(id);
    if (input) input.setAttribute("aria-valuetext", layerTipText(input));
  }
}

function placeTip(input: HTMLInputElement, tip: HTMLElement) {
  const text = layerTipText(input);
  input.setAttribute("aria-valuetext", text);
  if (!text || text.startsWith("Layer —")) {
    tip.hidden = true;
    return;
  }
  const track = input.closest(".track")?.getBoundingClientRect();
  if (!track || track.height < 4) {
    tip.hidden = true;
    return;
  }
  const min = Number(input.min);
  const max = Number(input.max);
  const t = max <= min ? 1 : (Number(input.value) - min) / (max - min);
  tip.textContent = text;
  tip.hidden = false;
  tip.style.left = `${Math.round(track.right + 8)}px`;
  tip.style.top = `${Math.round(track.bottom - t * track.height)}px`;
}

function layerTipText(input: HTMLInputElement) {
  const index = Number(input.value);
  if (!Number.isFinite(index)) return "";
  const layerNo = index + 1;
  if (input.id === "rangeLow") return `Lowest layer ${layerNo}`;
  const z = document.querySelector("#readHigh")?.textContent?.trim() || "Z —";
  if (z === "—") return "Layer —";
  return `Layer ${layerNo} · ${z}`;
}
