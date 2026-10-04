import { expect, test, type Page } from "@playwright/test";
import { canvasShare } from "../src/ui/compact/viewport-share";

async function quietEngine(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
}

async function openCube(page: Page) {
  await quietEngine(page);
  await page.goto("/");
  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#status")).toContainText("loaded");
}

async function share(page: Page, selector: string) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height, viewW: window.innerWidth, viewH: window.innerHeight };
  }, selector);
  expect(box, selector).not.toBeNull();
  return canvasShare({ width: box!.width, height: box!.height }, { width: box!.viewW, height: box!.viewH });
}

async function findInScroller(page: Page, scroller: string) {
  return page.evaluate((sel) => {
    const port = document.querySelector(sel);
    const find = document.querySelector("#find");
    const level = document.querySelector(".level-bar");
    const profile = document.querySelector(".profile-row");
    if (!port || !find || !level || !profile) return null;
    const portBox = port.getBoundingClientRect();
    const findBox = find.getBoundingClientRect();
    const levelBox = level.getBoundingClientRect();
    const profileBox = profile.getBoundingClientRect();
    return {
      findTop: findBox.top,
      findBottom: findBox.bottom,
      portTop: portBox.top,
      portBottom: portBox.bottom,
      levelBottom: levelBox.bottom,
      profileBottom: profileBox.bottom,
      stuck: document.querySelector(".find-row")?.classList.contains("is-stuck") ?? false,
    };
  }, scroller);
}

test.use({ viewport: { width: 1440, height: 900 } });

test("search stays pinned, shortcuts focus it, and a query scrolls to the match", async ({ page }) => {
  await openCube(page);
  const find = page.locator("#find");
  await expect(page.locator(".find-row")).toHaveCSS("position", "sticky");
  await expect(page.locator(".profile-row")).toHaveCSS("position", "static");
  await expect(page.locator(".level-bar")).toHaveCSS("position", "static");

  const overflow = await page.locator("#left").evaluate((el) => el.scrollHeight > el.clientHeight + 80);
  expect(overflow).toBe(true);
  await page.locator("#left").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const pinned = await findInScroller(page, "#left");
  expect(pinned).not.toBeNull();
  expect(pinned!.findTop).toBeGreaterThanOrEqual(pinned!.portTop - 1);
  expect(pinned!.findBottom).toBeLessThanOrEqual(pinned!.portBottom + 1);
  expect(pinned!.levelBottom).toBeLessThanOrEqual(pinned!.portTop + 1);
  expect(pinned!.profileBottom).toBeLessThanOrEqual(pinned!.portTop + 1);
  expect(pinned!.stuck).toBe(true);

  await page.locator("#left").evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.locator(".find-row")).not.toHaveClass(/is-stuck/);

  await page.evaluate(() => document.documentElement.setAttribute("data-scheme", "light"));
  const light = await page.locator(".find-row").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(light).not.toBe("rgba(0, 0, 0, 0)");
  expect(light).not.toBe("transparent");
  await page.evaluate(() => document.documentElement.setAttribute("data-scheme", "dark"));
  const dark = await page.locator(".find-row").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(dark).not.toBe("rgba(0, 0, 0, 0)");
  expect(dark).not.toBe(light);

  await page.locator("#stage").click();
  await page.keyboard.press("/");
  await expect(find).toBeFocused();
  await find.fill("seam");
  const selected = await find.evaluate((el: HTMLInputElement) => {
    el.blur();
    return el.value;
  });
  expect(selected).toBe("seam");
  await page.keyboard.press("Control+f");
  await expect(find).toBeFocused();
  const range = await find.evaluate((el: HTMLInputElement) => ({ start: el.selectionStart, end: el.selectionEnd, value: el.value }));
  expect(range.start).toBe(0);
  expect(range.end).toBe(range.value.length);

  await page.keyboard.press("Escape");
  await expect(find).toHaveValue("");
  await expect(page.locator("#lh")).toBeVisible();

  await page.locator("#lh").focus();
  await page.keyboard.press("Control+f");
  await expect(page.locator("#lh")).toBeFocused();
  await page.keyboard.press("/");
  await expect(page.locator("#lh")).toBeFocused();

  await page.locator("#tabGcode").click();
  await expect(page.locator("#gcodePane")).toBeVisible();
  await page.locator("#gcodePane").focus();
  await expect(page.locator("#gcodePane")).toBeFocused();
  await page.keyboard.press("Control+f");
  await expect(page.locator("#gcodePane")).toBeFocused();
  await expect(find).not.toBeFocused();

  await page.locator("#tabPrepare").click();
  await page.locator("#left").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const before = await page.locator("#left").evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(100);
  await find.fill("gyroid");
  await expect(page.locator("#gyroid3d")).toBeVisible();
  const placed = await page.evaluate(() => {
    const scroller = document.querySelector("#left")!;
    const row = document.querySelector(".find-row")!;
    const match = document.querySelector("#gyroid3d")!.closest(".setting")!;
    const s = scroller.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const m = match.getBoundingClientRect();
    return { scrollTop: scroller.scrollTop, matchTop: m.top, rowBottom: r.bottom, scrollerBottom: s.bottom };
  });
  expect(placed.scrollTop).toBeLessThan(before);
  expect(placed.matchTop).toBeGreaterThanOrEqual(placed.rowBottom - 8);
  expect(placed.matchTop).toBeLessThan(placed.rowBottom + 40);

  await find.fill("seam");
  await find.evaluate((el: HTMLInputElement) => {
    el.focus();
    el.setSelectionRange(1, 3);
  });
  await page.locator("#ironing").evaluate((el: HTMLInputElement) => {
    el.checked = !el.checked;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const caret = await find.evaluate((el: HTMLInputElement) => ({
    focused: document.activeElement === el,
    start: el.selectionStart,
    end: el.selectionEnd,
    value: el.value,
  }));
  expect(caret).toEqual({ focused: true, start: 1, end: 3, value: "seam" });
});

test.describe("compact sticky search", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });

  test("the search stays in the sheet and the peek canvas stays at least 70%", async ({ page }) => {
    await quietEngine(page);
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
    await expect(page.locator("#compactFile")).toContainText("calibration_cube");
    await page.waitForTimeout(250);
    const prepare = await share(page, "#prepare");
    expect(prepare, `prepare share ${prepare}`).toBeGreaterThanOrEqual(0.7);

    await page.locator("#compactTabs [data-tab=settings]").click();
    await page.waitForTimeout(250);
    await expect(page.locator(".find-row")).toHaveCSS("position", "sticky");
    await expect(page.locator(".find-row")).toHaveCSS("top", "0px");
    await expect(page.locator(".profile-row")).toHaveCSS("position", "static");
    const overflow = await page.locator("#compactSheetBody").evaluate((el) => el.scrollHeight > el.clientHeight + 40);
    expect(overflow).toBe(true);
    await page.locator("#compactSheetBody").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const pinned = await findInScroller(page, "#compactSheetBody");
    expect(pinned).not.toBeNull();
    expect(pinned!.findTop).toBeGreaterThanOrEqual(pinned!.portTop - 1);
    expect(pinned!.findBottom).toBeLessThanOrEqual(pinned!.portBottom + 1);
    expect(pinned!.levelBottom).toBeLessThanOrEqual(pinned!.portTop + 1);
    expect(pinned!.profileBottom).toBeLessThanOrEqual(pinned!.portTop + 1);
    expect(pinned!.stuck).toBe(true);

    await page.locator("#compactTabs [data-tab=prepare]").click();
    await page.waitForTimeout(250);
    const again = await share(page, "#prepare");
    expect(again, `prepare share ${again}`).toBeGreaterThanOrEqual(0.7);
  });
});
