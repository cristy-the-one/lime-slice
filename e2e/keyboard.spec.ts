import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

test.use({ viewport: { width: 1440, height: 900 } });

interface Calls {
  slices: Record<string, unknown>[];
  cancels: number;
}

/** `/api/slice` answers with the cube at once. With `hold`, the job route never finishes, so a slice stays running. */
async function mockEngine(page: Page, hold = false): Promise<Calls> {
  const calls: Calls = { slices: [], cancels: 0 };
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/slice", (route) => {
    calls.slices.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: cube });
  });
  await page.route("**/api/jobs**", (route) => {
    const url = new URL(route.request().url());
    if (!hold) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
    const running = { id: "7", stage: "part", done: 2, total: 4, fraction: 0.4, status: "running" };
    if (route.request().method() === "POST" && /\/api\/jobs\/?$/.test(url.pathname)) return route.fulfill({ status: 202, json: { id: "7" } });
    if (url.pathname.endsWith("/cancel")) {
      calls.cancels += 1;
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname.endsWith("/events")) return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify(running)}\n\n` });
    return route.fulfill({ json: running });
  });
  return calls;
}

async function openCube(page: Page) {
  await page.goto("/");
  await page.locator("#fileMenu > summary").click();
  await page.locator("#samples > summary").click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function pressed(page: Page, selector: string) {
  return page.locator(selector).getAttribute("aria-pressed");
}

/** The bed position of each plate object, read by selecting its row. */
async function positions(page: Page): Promise<string[]> {
  const rows = page.locator("[data-plate-select]");
  const out: string[] = [];
  for (let i = 0; i < (await rows.count()); i++) {
    await rows.nth(i).click();
    out.push(`${await page.locator("#placeX").inputValue()},${await page.locator("#placeY").inputValue()}`);
  }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  return out;
}

test("1, 2 and 3 switch the stage; V cycles the preview mode", async ({ page }) => {
  await mockEngine(page);
  await openCube(page);
  await page.keyboard.press("1");
  await expect(page.locator("#tabPrepare")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("2");
  await expect(page.locator("#tabPreview")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("3");
  await expect(page.locator("#tabGcode")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("2");

  await page.locator("#slice").click();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current", { timeout: 15_000 });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const mode = () => page.locator("[data-mode][aria-pressed=true]").getAttribute("data-mode");
  const first = await mode();
  const seen = [first];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("v");
    seen.push(await mode());
  }
  expect(seen[3]).toBe(first);
  expect(new Set(seen).size).toBe(3);
  expect(seen[1]).not.toBe(seen[0]);
});

test("Shift+1..5 pick a strategy", async ({ page }) => {
  await mockEngine(page);
  await openCube(page);
  await page.keyboard.press("Shift+3");
  await expect(page.locator('[data-card="toughness"]')).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Shift+1");
  await expect(page.locator('[data-card="speed"]')).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Shift+4");
  await expect(page.locator('[data-card="layer"]')).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Shift+5");
  await expect(page.locator('[data-card="region"]')).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Shift+2");
  await expect(page.locator('[data-card="efficiency"]')).toHaveAttribute("aria-pressed", "true");
});

test("A arranges, Ctrl+D duplicates, Delete removes", async ({ page }) => {
  await mockEngine(page);
  await openCube(page);
  await page.keyboard.press("1");
  const rows = page.locator("[data-plate-id]");
  await expect(rows).toHaveCount(1);

  await page.keyboard.press("Control+d");
  await expect(rows).toHaveCount(2);
  await page.keyboard.press("Control+d");
  await expect(rows).toHaveCount(3);

  const before = await positions(page);
  await page.keyboard.press("a");
  await expect.poll(async () => (await positions(page)).join("|")).not.toBe(before.join("|"));
  const arranged = await positions(page);
  expect(new Set(arranged).size).toBe(3);

  await page.keyboard.press("Delete");
  await expect(rows).toHaveCount(2);
  await page.keyboard.press("Backspace");
  await expect(rows).toHaveCount(1);
  await page.keyboard.press("Delete");
  await expect(rows).toHaveCount(1);
});

test("Delete and A stay out of the way outside Prepare and inside fields", async ({ page }) => {
  await mockEngine(page);
  await openCube(page);
  await page.keyboard.press("Control+d");
  const rows = page.locator("[data-plate-id]");
  await expect(rows).toHaveCount(2);
  await page.keyboard.press("2");
  await page.keyboard.press("Delete");
  await expect(rows).toHaveCount(2);
  await page.keyboard.press("1");
  await page.locator("#placeX").focus();
  await page.keyboard.press("Backspace");
  await expect(rows).toHaveCount(2);
});

test("Esc cancels a running slice", async ({ page }) => {
  const calls = await mockEngine(page, true);
  await openCube(page);
  await page.locator("#slice").click();
  await expect(page.locator("#cancel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#cancel")).toBeHidden();
  expect(calls.cancels).toBe(1);
});

test("Ctrl+Enter slices from inside a settings field and keeps what was typed", async ({ page }) => {
  const calls = await mockEngine(page);
  await openCube(page);
  await page.locator("#lh").fill("0.16");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => calls.slices.length).toBeGreaterThan(0);
  expect(calls.slices[0]!.layerHeight).toBe(0.16);
  await expect(page.locator("#lh")).toHaveValue("0.16");
});

test("Ctrl+Enter slices a typed X position, not the old one", async ({ page }) => {
  const calls = await mockEngine(page);
  await openCube(page);
  await page.keyboard.press("1");
  const x = (i: number) => (calls.slices[i]!.pose as { translation: number[] }).translation[0]!;
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => calls.slices.length).toBe(1);
  const placed = Number(await page.locator("#placeX").inputValue());
  await page.locator("#placeX").fill(String(placed + 30));
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => calls.slices.length).toBe(2);
  expect(x(1) - x(0)).toBeCloseTo(30, 1);
});

test("Ctrl+B and Ctrl+Alt+B fold the side panels", async ({ page }) => {
  await mockEngine(page);
  await openCube(page);
  const workspace = page.locator(".workspace");
  await page.keyboard.press("Control+b");
  await expect(workspace).toHaveClass(/is-left-collapsed/);
  await page.keyboard.press("Control+b");
  await expect(workspace).not.toHaveClass(/is-left-collapsed/);
  await page.keyboard.press("Control+Alt+b");
  await expect(workspace).toHaveClass(/is-right-collapsed/);
  await page.keyboard.press("Control+Alt+b");
  await expect(workspace).not.toHaveClass(/is-right-collapsed/);
});

test("a tool key toggles its tool; Esc leaves it", async ({ page }) => {
  await mockEngine(page);
  await openCube(page);
  await page.keyboard.press("b");
  await expect(page.locator("#paintBar")).toBeVisible();
  const radius = page.locator("#brushRadius");
  const before = Number(await radius.inputValue());
  await page.keyboard.press("]");
  expect(Number(await radius.inputValue())).toBeCloseTo(before + 0.5, 3);
  await page.keyboard.press("[");
  await page.keyboard.press("[");
  expect(Number(await radius.inputValue())).toBeCloseTo(before - 0.5, 3);
  await page.keyboard.press("Escape");
  await expect(page.locator("#paintBar")).toBeHidden();
  await page.keyboard.press("k");
  await expect(page.locator("#seamBar")).toBeVisible();
  await page.keyboard.press("k");
  await expect(page.locator("#seamBar")).toBeHidden();
});

test("layer keys step the preview, and a typed ] is not a layer step", async ({ page }) => {
  await mockEngine(page);
  await openCube(page);
  await page.locator("#slice").click();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current", { timeout: 15_000 });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("2");
  const layer = () => page.locator("#rangeHigh").inputValue().then(Number);
  await page.keyboard.press("Home");
  expect(await layer()).toBe(0);
  await page.keyboard.press("]");
  expect(await layer()).toBe(1);
  await page.keyboard.press("ArrowUp");
  expect(await layer()).toBe(2);
  await page.keyboard.press("[");
  expect(await layer()).toBe(1);
  await page.keyboard.press("End");
  const last = await layer();
  expect(last).toBeGreaterThan(2);
  await page.locator("#find").focus();
  await page.keyboard.press("]");
  expect(await layer()).toBe(last);
});

test("the shortcut sheet and tooltips come from the registry", async ({ page }) => {
  await mockEngine(page);
  await openCube(page);
  await page.keyboard.press("Shift+Slash");
  const sheet = page.locator("#help");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".help-group h3")).toContainText(["Window", "Slice", "View", "Layers", "Strategy", "Plate", "Tools", "Edit", "Mouse"]);
  await expect(sheet.locator("li", { hasText: "Arrange plate" }).locator("kbd")).toHaveText(["A"]);
  await expect(sheet.locator("li", { hasText: "Remove object" }).locator("kbd")).toHaveText(["Del", "Backspace"]);
  await expect(sheet.locator("li", { hasText: "Paint seam" }).locator("kbd")).toHaveText(["K"]);
  await expect(sheet.locator("li", { hasText: "Search settings" }).locator("kbd")).toHaveText(["/", "Ctrl+F"]);
  await page.keyboard.press("2");
  await expect(page.locator("#tabPrepare")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  await page.locator("#tabPreview").hover();
  await expect(page.locator(".lime-tip[data-open=true] kbd")).toHaveText("2");
  await page.locator("#export").hover({ force: true });
  await expect(page.locator(".lime-tip[data-open=true] kbd")).toHaveText("Ctrl+E");
  await page.locator("#plateArrange").hover({ force: true });
  await expect(page.locator(".lime-tip[data-open=true] kbd")).toHaveText("A");
});
