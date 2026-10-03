import { expect, test, type Page } from "@playwright/test";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";

function zipNamed(name: string): Buffer {
  const named = Buffer.from(name);
  const local = Buffer.alloc(30 + named.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(named.length, 26);
  named.copy(local, 30);
  return local;
}

async function quiet(page: Page) {
  page.on("dialog", (dialog) => void dialog.accept());
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] } }));
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

test("a slicer 3MF opens as a mesh and says its settings were not imported", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await page.locator("#file").setInputFiles("samples/calibration_cube_20mm.3mf");
  await expect(page.locator("#status")).toContainText("loaded");
  await expect(page.locator("#toasts").getByText("were not imported")).toHaveCount(0);

  await page.locator("#file").setInputFiles({
    name: "bench.3mf",
    mimeType: "model/3mf",
    buffer: zipNamed("Metadata/Slic3r_PE_model.config"),
  });
  await expect(page.locator("#status")).toContainText("loaded");
  await expect(page.locator("#toasts").getByRole("status").filter({ hasText: "Opened the mesh only. PrusaSlicer settings in this 3MF were not imported." })).toBeVisible();

  await page.locator("#file").setInputFiles({
    name: "orca.3mf",
    mimeType: "model/3mf",
    buffer: zipNamed("Metadata/OrcaSlicer_model.config"),
  });
  await expect(page.locator("#toasts").getByRole("status").filter({ hasText: "OrcaSlicer settings in this 3MF were not imported." })).toBeVisible();
});

test.describe("compact foreign 3MF", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });

  test("the prepare canvas stays in front at the peek", async ({ page }) => {
    await quiet(page);
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.locator("#file").setInputFiles({
      name: "cura-part.3mf",
      mimeType: "model/3mf",
      buffer: zipNamed("Cura/printer.def.json"),
    });
    await expect(page.locator("#toasts").getByRole("status").filter({ hasText: "Cura settings in this 3MF were not imported." })).toBeVisible();
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    const prepare = await share(page, "#prepare");
    expect(prepare, `prepare viewport share ${prepare}`).toBeGreaterThanOrEqual(0.7);
  });
});
