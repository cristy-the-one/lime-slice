import { expect, test } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

test("brush tools explain why they are off until a mesh is open", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.goto("/");
  await autoSliceOff(page);
  const reasons: [string, string][] = [
    ["paint", "Load a mesh to paint supports."],
    ["seam", "Load a mesh to paint the seam."],
    ["reinforce", "Load a mesh to reinforce."],
    ["supports", "Slice with tree supports to edit them."],
  ];
  for (const [tool, why] of reasons) {
    const button = page.locator(`#toolRail [data-tool="${tool}"]`);
    await expect(button, tool).toHaveAttribute("aria-disabled", "true");
    await expect(button, tool).toHaveAttribute("data-tip", why);
    await expect(button, tool).toHaveAttribute("title", why);
  }
  await page.locator("#tabPrepare").click();
  // aria-disabled keeps the tooltip, and the click still explains itself.
  await page.locator('#toolRail [data-tool="paint"]').click({ force: true });
  await expect(page.locator("#toasts")).toContainText("Load a mesh to paint supports.");
  await expect(page.locator("#paintBar")).toBeHidden();
});

test("the Features opener is 24px beside Pocket, and a keyboard focus shows why a tool is off", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabPrepare").click();
  const paint = page.locator('#toolRail [data-tool="paint"]');
  await paint.evaluate((button: HTMLElement) => button.focus({ focusVisible: true }));
  await expect(page.locator(".lime-tip")).toContainText("Load a mesh to paint supports.");
  if (process.env.LIME_SHOTS) await page.screenshot({ path: `${process.env.LIME_SHOTS}/after-disabled-stripe.png` });
  const stripe = await paint.evaluate((button) => getComputedStyle(button).backgroundImage);
  expect(stripe, "a disabled control is striped, not only faded").toContain("linear-gradient");
  await expect.poll(async () => paint.evaluate((button) => getComputedStyle(button).opacity)).toBe("1");

  await page.locator("#tabModel").click();
  await page.locator("#railModel").evaluate((el) => el.removeAttribute("data-no-solid"));
  const more = page.locator("#modelFeatureMore");
  const tool = page.locator("#modelToolFeatures");
  await expect(more).toBeVisible();
  const placed = await page.evaluate(() => {
    const opener = document.querySelector("#modelFeatureMore")!.getBoundingClientRect();
    const pocket = document.querySelector("#modelToolFeatures")!.getBoundingClientRect();
    const cx = pocket.x + pocket.width / 2;
    const cy = pocket.y + pocket.height / 2;
    const overlap = !(opener.right <= pocket.left || opener.left >= pocket.right || opener.bottom <= pocket.top || opener.top >= pocket.bottom);
    return {
      openerW: opener.width,
      openerH: opener.height,
      overlap,
      coversCentre: cx >= opener.left && cx <= opener.right && cy >= opener.top && cy <= opener.bottom,
    };
  });
  expect(placed.openerW).toBeGreaterThanOrEqual(24);
  expect(placed.openerH).toBeGreaterThanOrEqual(24);
  expect(placed.overlap, "the opener sits beside Pocket").toBe(false);
  expect(placed.coversCentre, "a click on Pocket still hits Pocket").toBe(false);
  await tool.click();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  if (process.env.LIME_SHOTS) await page.locator("#toolRail .model-feature").screenshot({ path: `${process.env.LIME_SHOTS}/after-feature-split.png` });
  await page.locator("#model").evaluate((el: HTMLElement) => el.focus({ focusVisible: true }));
  await expect.poll(async () => page.locator("#model").evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
});

test("gizmo nudge keys are 24px and overlays carry a border, a shadow and an opaque fill", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  const before = await page.locator("#toolRail .rail-group[data-folded]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-group")));
  const nudge = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>("#gizmoNudge")!;
    row.hidden = false;
    const button = row.querySelector("button")!.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    row.hidden = true;
    return { w: button.width, h: button.height, rowH: box.height };
  });
  expect(nudge.w).toBeGreaterThanOrEqual(24);
  expect(nudge.h).toBeGreaterThanOrEqual(24);
  expect(nudge.rowH).toBeLessThanOrEqual(80);
  const after = await page.locator("#toolRail .rail-group[data-folded]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-group")));
  expect(after, "showing the nudge keys does not fold another group").toEqual(before);
  if (process.env.LIME_SHOTS) {
    await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>("#gizmoNudge");
      if (row) row.hidden = false;
    });
    await page.locator("#gizmoNudge").screenshot({ path: `${process.env.LIME_SHOTS}/after-gizmo-nudge.png` });
    await page.locator("#fileMenu").evaluate((el: HTMLDetailsElement) => { el.open = true; });
    await page.screenshot({ path: `${process.env.LIME_SHOTS}/after-file-menu.png` });
  }

  const layers = await page.evaluate(() => {
    const opaque = (color: string) => {
      const match = color.match(/rgba?\(([^)]+)\)/);
      if (!match) return color !== "transparent";
      const parts = match[1]!.split(",").map((part) => part.trim());
      return parts.length < 4 || Number(parts[3]) >= 0.98;
    };
    const selectors = [
      "#fileMenu nav",
      "#modelFeatureMenu",
      "#modelContextBar",
      "#gizmoReadout",
      ".model-empty",
      "#calibrate .sheet-card",
      ".menu nav",
    ];
    return selectors.map((selector) => {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) return { selector, missing: true, border: false, shadow: false, opaque: false };
      const style = getComputedStyle(el);
      return {
        selector,
        missing: false,
        border: parseFloat(style.borderTopWidth) >= 1 && style.borderTopStyle !== "none",
        shadow: style.boxShadow !== "none",
        opaque: opaque(style.backgroundColor),
      };
    });
  });
  for (const layer of layers) {
    expect(layer.missing, layer.selector).toBe(false);
    expect(layer.border, layer.selector).toBe(true);
    expect(layer.shadow, layer.selector).toBe(true);
    expect(layer.opaque, layer.selector).toBe(true);
  }
});

test("Ctrl+. brings a faded selection bar back", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  // No selection: the shortcut has nothing to open, and it must not throw.
  await page.locator("#model").evaluate((el: HTMLElement) => el.focus({ focusVisible: true }));
  await page.keyboard.press("Control+.");
  await expect(page.locator("#modelContextBar")).toBeHidden();
});
