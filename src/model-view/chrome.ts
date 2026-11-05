/** Bed colours, the fit line, the over-volume chip, and the measure callouts. */
import type { Box } from "../measure";
import { bedForBox, fitSentence, liveBox, outerMm } from "../viewport-chrome";
import { perspectiveMeasure } from "../measure-camera";
import type { ViewCtx } from "./ctx";

export function installChrome(ctx: ViewCtx): void {
  const { bedRef, camera, canvas, controls, fit, measure, overChip } = ctx;
  ctx.drawMeasure = drawMeasure;
  ctx.paintFit = paintFit;
  ctx.syncBedOrigin = syncBedOrigin;

  let overShown = false;

  function shownBox(): Box | null {
    if (!ctx.solidBox) return null;
    const factor = ctx.ghost?.kind === "scale" && ctx.ghost.factor > 0 ? ctx.ghost.factor : 1;
    return liveBox(ctx.solidBox, factor);
  }

  /** Whether the part fits the build volume is about the part, not where it sits or turns in model space. */
  function paintFit() {
    const factor = ctx.ghost?.kind === "scale" && ctx.ghost.factor > 0 ? ctx.ghost.factor : 1;
    const box = ctx.ownBox ? liveBox(ctx.ownBox, factor) : null;
    if (!box) {
      if (!fit.hidden) fit.hidden = true;
      paintOver(false, "");
      return;
    }
    const sentence = fitSentence(outerMm(box), ctx.bed);
    if (fit.textContent !== sentence.text) fit.textContent = sentence.text;
    fit.dataset.over = sentence.over ? "1" : "0";
    fit.hidden = false;
    paintOver(sentence.over, sentence.text);
  }

  /** The status line's warning while the part is past the build volume. Touched only when that changes. */
  function paintOver(over: boolean, text: string) {
    if (!overChip || (over === overShown && (!over || overChip.dataset.tip === text))) return;
    overShown = over;
    overChip.hidden = !over;
    if (over) overChip.dataset.tip = text;
  }

  /** The bed sits centred under the open solid, its plate at the solid's lowest point in model space. */
  function syncBedOrigin() {
    const rect = bedForBox(ctx.bed, shownBox());
    bedRef.setOrigin(rect.x0, rect.y0, rect.z0);
    const text = `${rect.x0.toFixed(1)},${rect.y0.toFixed(1)},${rect.z0.toFixed(1)}`;
    if (canvas.dataset.bedOrigin !== text) canvas.dataset.bedOrigin = text;
    return ctx.bedOn ? rect : null;
  }

  function drawMeasure() {
    const box = shownBox();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    measure.render({
      w,
      h,
      box,
      cam: [camera.position.x, camera.position.y, camera.position.z],
      bed: syncBedOrigin(),
      ...perspectiveMeasure(camera, controls.target, w, h, (p, out) => out.set(p[0], p[1], p[2])),
    });
  }
}
