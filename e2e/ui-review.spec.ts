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

test("the Features opener stays inside Pocket and the model view shows a focus ring", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  // The feature group is solid-only; show it so the opener can be measured.
  await page.locator("#railModel").evaluate((el) => el.removeAttribute("data-no-solid"));
  const more = page.locator("#modelFeatureMore");
  const tool = page.locator("#modelToolFeatures");
  await expect(more).toBeVisible();
  const placed = await page.evaluate(() => {
    const opener = document.querySelector("#modelFeatureMore")!.getBoundingClientRect();
    const pocket = document.querySelector("#modelToolFeatures")!.getBoundingClientRect();
    const cx = pocket.x + pocket.width / 2;
    const cy = pocket.y + pocket.height / 2;
    return {
      openerW: opener.width,
      openerH: opener.height,
      inside: opener.left >= pocket.left - 0.5 && opener.top >= pocket.top - 0.5
        && opener.right <= pocket.right + 0.5 && opener.bottom <= pocket.bottom + 0.5,
      coversCentre: cx >= opener.left && cx <= opener.right && cy >= opener.top && cy <= opener.bottom,
    };
  });
  expect(placed.openerW).toBeGreaterThanOrEqual(16);
  expect(placed.openerH).toBeGreaterThanOrEqual(20);
  expect(placed.inside, "the opener stays inside the Pocket button").toBe(true);
  expect(placed.coversCentre, "a click on Pocket still hits Pocket").toBe(false);
  await tool.click();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await page.locator("#model").evaluate((el: HTMLElement) => el.focus({ focusVisible: true }));
  await expect.poll(async () => page.locator("#model").evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
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
