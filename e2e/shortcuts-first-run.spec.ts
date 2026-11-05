import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { ORIGIN } from "../playwright.config";

test.use({ colorScheme: "dark" });
const SHOTS = process.env.LIME_SHOTS ?? "";
const FIRST_RUN = { cookies: [], origins: [{ origin: ORIGIN, localStorage: [{ name: "lime-slice-auto-slice", value: "0" }] }] };
const RETURNING = { cookies: [], origins: [{ origin: ORIGIN, localStorage: [{ name: "lime-slice-auto-slice", value: "0" }, { name: "lime-slice-settings-level", value: "expert" }] }] };

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name) });
}

test.describe("first run", () => {
  test.use({ storageState: FIRST_RUN });

  for (const [width, height] of [[1440, 1000], [900, 900]] as const) {
    test(`opens Prepare at the Simple level when nothing is saved (${width}x${height})`, async ({ page }) => {
      await quiet(page);
      await page.setViewportSize({ width, height });
      await page.goto("/");
      await expect(page.locator("#tabPrepare")).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#prepareBody")).toBeVisible();
      await expect(page.locator("#previewBody")).toBeHidden();
      await expect(page.locator("#levelPick")).toHaveValue("simple");
      await expect(page.locator("html")).toHaveAttribute("data-settings-level", "simple");
      await shot(page, `first-run-${width}.png`);
    });
  }

  test("a level the person picks is kept on the next launch", async ({ page }) => {
    await quiet(page);
    await page.goto("/");
    await page.locator("#levelPick").selectOption("advanced");
    await page.reload();
    await expect(page.locator("#levelPick")).toHaveValue("advanced");
    await expect(page.locator("#tabPreview")).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("returning launch", () => {
  test.use({ storageState: RETURNING });

  test("a saved expert level stays expert and the app opens on Preview", async ({ page }) => {
    await quiet(page);
    await page.goto("/");
    await expect(page.locator("#levelPick")).toHaveValue("expert");
    await expect(page.locator("#tabPreview")).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("the shortcut sheet", () => {
  test.use({ storageState: RETURNING });

  test("opens on this workspace's group, searches, and closes with Esc", async ({ page }) => {
    await quiet(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/");
    await page.locator("#tabPrepare").click();
    await page.keyboard.press("?");
    const sheet = page.locator("#help");
    await expect(sheet).toBeVisible();
    await expect(page.locator("#helpSearch")).toBeFocused();

    const open = sheet.locator("details.help-group[open]");
    await expect(open).toHaveCount(2);
    await expect(open.locator("h3")).toHaveText(["Plate", "Tools"]);
    await expect(sheet.locator("details.help-group:not([open])").first()).toBeVisible();

    // The first row is on screen: the card is inside the window and the list starts at its top.
    const first = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>("#help .sheet-card")!.getBoundingClientRect();
      const body = document.querySelector<HTMLElement>("#helpShortcuts")!;
      const row = body.querySelector<HTMLElement>("details[open] li")!.getBoundingClientRect();
      const bodyBox = body.getBoundingClientRect();
      return { cardTop: card.top, cardBottom: card.bottom, vh: innerHeight, scroll: body.scrollTop, rowTop: row.top, bodyTop: bodyBox.top };
    });
    expect(first.cardTop).toBeGreaterThanOrEqual(0);
    expect(first.cardBottom).toBeLessThanOrEqual(first.vh);
    expect(first.scroll).toBe(0);
    expect(first.rowTop).toBeGreaterThanOrEqual(first.bodyTop);

    // One click opens a closed group.
    await sheet.locator("summary", { hasText: "Layers" }).click();
    await expect(sheet.locator("details.help-group[open] h3")).toHaveText(["Layers", "Plate", "Tools"]);

    // Search: ? stays text, groups with a hit open, the context shows beside a shared key.
    await page.locator("#helpSearch").click();
    await page.keyboard.type("smooth loft");
    const rows = sheet.locator("li");
    await expect(rows.first()).toContainText("Smooth loft");
    await expect(rows.first().locator("kbd")).toHaveText("S");
    await expect(rows.first().locator(".help-ctx")).toHaveText("Sketch, in a loft");
    await expect(sheet.locator("details.help-group:not([open])")).toHaveCount(0);
    await shot(page, `sheet-search-${(page.viewportSize()!.width)}.png`);

    await page.locator("#helpSearch").fill("zzzz");
    await expect(sheet.locator(".help-empty")).toBeVisible();
    await page.locator("#helpSearch").fill("?");
    await expect(sheet).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    // Reopening starts clean.
    await page.keyboard.press("?");
    await expect(page.locator("#helpSearch")).toHaveValue("");
    await expect(sheet.locator("details.help-group[open] h3")).toHaveText(["Plate", "Tools"]);
  });

  test("Redo's second chord keeps its label, and a shared key says where it works", async ({ page }) => {
    await quiet(page);
    await page.goto("/");
    await page.keyboard.press("?");
    await page.locator("#helpSearch").fill("redo");
    const redo = page.locator("#help li", { hasText: /^Ctrl\+Shift\+Z/ }).first();
    await expect(redo.locator("kbd")).toHaveText(["Ctrl+Shift+Z", "Ctrl+Y"]);
    await expect(redo.locator(".help-label")).toHaveText("Redo");
    await expect(redo.locator(".help-ctx")).toHaveText("Outside a sketch");
    const top = await redo.evaluate((li) => {
      const keys = li.querySelector(".help-keys")!.getBoundingClientRect();
      const what = li.querySelector(".help-what")!.getBoundingClientRect();
      return { keysH: keys.height, whatH: what.height };
    });
    // The chords sit on one line beside the label rather than wrapping under it.
    expect(top.keysH).toBeLessThan(top.whatH + 8);
  });

  test("a narrow window keeps the sheet inside it", async ({ page }) => {
    await quiet(page);
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto("/");
    await page.keyboard.press("?");
    await page.locator("#helpSearch").fill("sketch");
    const box = await page.locator("#help .sheet-card").boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(900);
    expect(box!.y + box!.height).toBeLessThanOrEqual(900);
    await shot(page, "sheet-search-900.png");
  });
});

test.describe("the command palette", () => {
  test.use({ storageState: RETURNING });

  test("hides its own row and leads with the last five commands used", async ({ page }) => {
    await quiet(page);
    await page.goto("/");
    await page.keyboard.press("Control+K");
    const list = page.locator("#paletteList");
    await expect(list.locator("li").first()).toBeVisible();
    await expect(list).not.toContainText("Command palette");
    await expect(list).not.toContainText("Recent");

    const used = ["Theme: Dark", "Theme: Light", "Theme: System", "Settings level: Advanced", "Settings level: Simple", "Settings level: Expert"];
    for (const label of used) {
      await page.locator("#paletteInput").fill(label);
      await page.keyboard.press("Enter");
      await expect(page.locator("#palette")).toBeHidden();
      await page.keyboard.press("Control+K");
    }
    const labels = await list.locator("li > span").evaluateAll((spans) => spans.map((span) => span.firstChild?.textContent ?? ""));
    expect(labels.slice(0, 5)).toEqual([...used].reverse().slice(0, 5));
    await expect(list.locator("li").first().locator("small")).toContainText("Recent");
    await expect(list.locator("li").nth(5).locator("small")).not.toContainText("Recent");
    await expect(list).not.toContainText("Command palette");

    // Typing ranks as before; a reload keeps the list for this viewer.
    await page.locator("#paletteInput").fill("slice");
    await expect(list.locator("li").first()).toContainText("Slice");
    await page.keyboard.press("Escape");
    await page.reload();
    await page.keyboard.press("Control+K");
    await expect(list.locator("li").first()).toContainText("Settings level: Expert");
  });

  test("works with storage blocked", async ({ page }) => {
    await quiet(page);
    await page.addInitScript(() => {
      const real = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key: string) {
        if (key === "lime-slice-recent-commands") throw new Error("blocked");
        return real.call(this, key);
      };
    });
    await page.goto("/");
    await page.keyboard.press("Control+K");
    await expect(page.locator("#paletteList li").first()).toBeVisible();
    await expect(page.locator("#paletteList")).not.toContainText("Command palette");
  });
});
