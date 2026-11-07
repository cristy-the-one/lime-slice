import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

async function openCube(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", (route) => route.fulfill({ status: 404, json: { error: "off" } }));
  await page.addInitScript(() => {
    localStorage.setItem("lime-slice-theme", "dark");
    localStorage.setItem("lime-slice-open-subgroups", '["pivot-chain"]');
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#partScale")).toHaveValue("100");
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#pivotX")).toBeVisible();
}

async function commitPivot(page: Page, x: string, y: string, z: string) {
  await page.locator("#pivotX").fill(x);
  await page.locator("#pivotX").press("Tab");
  await page.locator("#pivotY").fill(y);
  await page.locator("#pivotY").press("Tab");
  await page.locator("#pivotZ").fill(z);
  await page.locator("#pivotZ").press("Tab");
}

function parsePivots(raw: string | null): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {};
  for (const bit of (raw ?? "").split(" ").filter(Boolean)) {
    const [id, coords] = bit.split(":");
    const [x, y, z] = (coords ?? "").split(",").map(Number);
    if (id) out[id] = [x ?? 0, y ?? 0, z ?? 0];
  }
  return out;
}

test("a custom pivot stays put when the part turns, and a chain follows", async ({ page }) => {
  await openCube(page);
  await expect(page.locator('#toolRail [data-tool="pivot"]')).toBeVisible();
  await expect(page.locator('#toolRail [data-tool="ik"]')).toBeVisible();

  const before = await page.locator("#placeX").inputValue();
  await commitPivot(page, "0", "0", "0");
  await expect(page.locator("#prepare")).toHaveAttribute("data-pivot-custom", "true");
  const held = await page.locator("#prepare").getAttribute("data-pivot");
  expect(held).toBeTruthy();

  await page.locator("#rotZ").click();
  const turned = await page.locator("#prepare").getAttribute("data-pivot");
  const [hx, hy, hz] = (held ?? "").split(",").map(Number);
  const [tx, ty, tz] = (turned ?? "").split(",").map(Number);
  expect(tx).toBeCloseTo(hx ?? 0, 1);
  expect(ty).toBeCloseTo(hy ?? 0, 1);
  expect(tz).toBeCloseTo(hz ?? 0, 1);
  await expect(page.locator("#placeX")).not.toHaveValue(before);

  await page.keyboard.press("Control+z");
  await expect(page.locator("#placeX")).toHaveValue(before);
  await expect(page.locator("#prepare")).toHaveAttribute("data-pivot-custom", "true");

  await page.locator("#pivotReset").click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-pivot-custom", "false");

  await page.locator("#plateDuplicate").click();
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
  await page.locator("[data-chain-link]").evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.locator("[data-chain-head]")).toHaveCount(1);

  const linked = parsePivots(await page.locator("#prepare").getAttribute("data-plate-pivots"));
  const ids = Object.keys(linked);
  expect(ids.length).toBe(2);
  const parentId = await page.locator("[data-plate-id][data-selected='true']").getAttribute("data-plate-id");
  const childId = ids.find((id) => id !== parentId);
  expect(childId).toBeTruthy();
  const childBefore = linked[childId!]!;

  const x = Number(await page.locator("#placeX").inputValue());
  await page.locator("#placeX").fill(String(x + 10));
  await page.locator("#placeX").press("Tab");
  const moved = parsePivots(await page.locator("#prepare").getAttribute("data-plate-pivots"));
  expect(moved[childId!]![0]).toBeCloseTo(childBefore[0] + 10, 0);

  await page.locator("[data-chain-select]").evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.locator("[data-chain-head]")).toHaveAttribute("data-selected", "true");
  await page.locator("#plateDuplicate").click();
  await expect(page.locator("[data-plate-id]")).toHaveCount(4);
  await page.keyboard.press("Control+z");
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
});
