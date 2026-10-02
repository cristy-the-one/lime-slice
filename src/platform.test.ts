import { resolveLayout, type LayoutInput } from "./platform.ts";
import { chromeCanvasShare, canvasShare } from "./ui/compact/viewport-share.ts";
import { HALF_SHEET_RATIO, PEEK_PX, TAB_PX, TOP_PX, sheetHeight } from "./ui/compact/sheet.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const desk: LayoutInput = { query: null, stored: null, width: 1280, height: 800, coarse: false, mobileUa: false };
const phone: LayoutInput = { query: null, stored: null, width: 390, height: 844, coarse: true, mobileUa: true };
const land: LayoutInput = { query: null, stored: null, width: 844, height: 390, coarse: true, mobileUa: true };
const ipad: LayoutInput = { query: null, stored: null, width: 820, height: 1180, coarse: false, mobileUa: false };

check("query compact beats a saved desktop choice and a wide window", resolveLayout({ ...desk, query: "compact", stored: "desktop" }) === "compact");
check("query desktop beats a narrow phone", resolveLayout({ ...phone, query: "desktop", stored: "compact" }) === "desktop");
check("saved compact beats a wide window", resolveLayout({ ...desk, stored: "compact" }) === "compact");
check("saved desktop beats a phone width", resolveLayout({ ...phone, stored: "desktop" }) === "desktop");
check("auto on a phone width is compact", resolveLayout(phone) === "compact");
check("auto on a desktop window is desktop", resolveLayout(desk) === "desktop");
check("auto on phone landscape is compact", resolveLayout(land) === "compact");
check("auto on an iPad-sized window is desktop", resolveLayout(ipad) === "desktop");
check("a coarse desktop-sized window stays desktop", resolveLayout({ ...desk, coarse: true }) === "desktop");

const view = { width: 390, height: 844 };
const peek = chromeCanvasShare(view, { top: TOP_PX, sheet: sheetHeight("peek", view.height), tab: TAB_PX });
const half = chromeCanvasShare(view, { top: TOP_PX, sheet: sheetHeight("half", view.height), tab: TAB_PX });
const preview = chromeCanvasShare(view, { top: TOP_PX, sheet: 0, tab: TAB_PX });
const hidden = chromeCanvasShare(view, { top: 0, sheet: 0, tab: 0 });
check("prepare peek is at least 70% of the screen", peek >= 0.7, String(peek));
check("preview without the sheet is at least 70%", preview >= 0.7, String(preview));
check("chrome hidden fills the screen", hidden >= 0.9, String(hidden));
check("half sheet leaves about 48% for the model", half > 0.45 && half < 0.52, String(half));
check("half sheet ratio is the documented 0.42", HALF_SHEET_RATIO === 0.42);
check("peek sheet is 56px", sheetHeight("peek", 844) === PEEK_PX);
check("canvas share is width times height over the screen", Math.abs(canvasShare({ width: 390, height: 600 }, view) - (390 * 600) / (390 * 844)) < 1e-9);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("platform: layout priority and viewport share ok");
