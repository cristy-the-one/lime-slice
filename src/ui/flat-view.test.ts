import { fitFlatView, frameFlatView, holdFlatView, mapFlat, panFlat, screenBox, unmapFlat, wheelKind, wheelZoomFactor, zoomFlat, type XyBounds } from "./flat-view.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function near(name: string, actual: number, expected: number, tol = 1e-6): void {
  check(name, Math.abs(actual - expected) <= tol, `got ${actual}, want ${expected}`);
}

const pad = 28;
const wide: XyBounds = { minX: 0, minY: 0, maxX: 20, maxY: 0.1 };
const fat: XyBounds = { minX: 0, minY: 0, maxX: 20, maxY: 18 };

const fitted = fitFlatView(wide, 800, 600, pad);
near("a wide layer is limited by its width", fitted.scale, (800 - pad * 2) / 20, 1e-6);
near("the fit is centered in x", fitted.cx, 10);
near("the fit is centered in y", fitted.cy, 0.05);

const [sx, sy] = mapFlat(fitted, 800, 600, 10, 0.05);
near("the center maps to the canvas center", sx, 400);
near("the center maps to the canvas middle", sy, 300);
const [ux, uy] = unmapFlat(fitted, 800, 600, sx, sy);
near("unmap returns x", ux, 10);
near("unmap returns y", uy, 0.05);

const shifted: XyBounds = { minX: 0, minY: 5, maxX: 20, maxY: 5.1 };
const held = frameFlatView(fitted, shifted, 800, 600, pad, "fit");
near("a similar layer keeps the zoom", held.scale, fitted.scale, 1e-6);
near("a similar layer recenters", held.cy, 5.05, 1e-6);
const box = screenBox(held, shifted, 800, 600);
check("the recentered layer is inside", box.top > pad - 1 && box.bottom < 600 - pad + 1 && box.left > pad - 1 && box.right < 800 - pad + 1);

const grown = frameFlatView(fitted, fat, 800, 600, pad, "fit");
near("a taller layer is framed again", grown.scale, (600 - pad * 2) / 18, 1e-4);
near("the taller layer is centered", grown.cy, 9);

const zoomed = zoomFlat(fitted, 800, 600, 100, 80, 2);
const [wx, wy] = unmapFlat(zoomed, 800, 600, 100, 80);
const [ox, oy] = unmapFlat(fitted, 800, 600, 100, 80);
near("zoom keeps the cursor's x", wx, ox, 1e-6);
near("zoom keeps the cursor's y", wy, oy, 1e-6);
check("zoom in raises the scale", zoomed.scale > fitted.scale * 1.9);

const panned = panFlat(fitted, 40, -20);
near("a right drag looks further left", panned.cx, fitted.cx - 40 / fitted.scale, 1e-6);
near("an up drag looks further up", panned.cy, fitted.cy - 20 / fitted.scale, 1e-6);

const away: XyBounds = { minX: 100, minY: 100, maxX: 110, maxY: 110 };
const followed = holdFlatView(fitted, away, 800, 600, pad, false);
const awayBox = screenBox(followed, away, 800, 600);
check("a user zoom does not give up its scale", Math.abs(followed.scale - fitted.scale) < 1e-6);
check("a layer that left the canvas is brought back", awayBox.left < 800 && awayBox.right > 0 && awayBox.top < 600 && awayBox.bottom > 0);

check("pinch zooms", wheelKind(0, -8, 0, true, false) === "zoom");
check("a mouse wheel zooms", wheelKind(0, -120, 0, false, false) === "zoom");
check("a line wheel zooms", wheelKind(0, -1, 1, false, false) === "zoom");
check("a sideways trackpad scroll pans", wheelKind(12, -4, 0, false, false) === "pan");
check("a fine trackpad scroll pans", wheelKind(0, -8, 0, false, false) === "pan");
check("a fractional trackpad scroll pans", wheelKind(0, -3.5, 0, false, false) === "pan");
check("scroll down zooms out", wheelZoomFactor(100, 0) < 1);
check("scroll up zooms in", wheelZoomFactor(-100, 0) > 1);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("flat view: frame, pan, and zoom ok");
