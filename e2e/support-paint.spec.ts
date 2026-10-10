import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Paint support blockers on the prepare mesh against a real engine, which serves stored
 * recipes from its disk cache as the desktop app does:
 *   lime-slice serve --port 43218 --cache-dir <dir>
 *   LIME_EDIT_API=http://127.0.0.1:43218 npx playwright test support-paint
 */
const api = process.env.LIME_EDIT_API;

test.skip(!api, "set LIME_EDIT_API to a running lime-slice serve");
test.setTimeout(300_000);

const SLICE_MS = 120_000;
const out = path.resolve("artifacts");
fs.mkdirSync(out, { recursive: true });

type Reply = {
  skeleton?: { id: number[] };
  supportPaint?: { enforce: number; block: number; enforceUnhit: number; blockUnhit: number };
  fromCache?: boolean;
};

async function proxy(page: Page) {
  const replies: Reply[] = [];
  await page.route("http://127.0.0.1:43118/**", async (route) => {
    const url = route.request().url().replace("http://127.0.0.1:43118", api!);
    const response = await route.fetch({ url, timeout: SLICE_MS });
    if (/\/api\/jobs\/[^/]+\/result$|\/api\/slice$/.test(url) && response.status() === 200) replies.push(JSON.parse(await response.text()));
    await route.fulfill({ response });
  });
  return replies;
}

async function sliced(page: Page) {
  await expect(page.locator("#slice")).toBeEnabled({ timeout: SLICE_MS });
  await expect(page.locator("#cancel")).toBeHidden();
}

const limbs = (reply: Reply | undefined) => reply?.skeleton?.id.length ?? -1;

test("block paint on the ledge drops its supports, and undo brings them back", async ({ page }) => {
  const replies = await proxy(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator("#fileMenu > summary").click();
  await page.locator("#samples > summary").click();
  await page.locator('[data-sample="overhang_ledge.stl"]').click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible({ timeout: 30_000 });
  await page.locator("#levelPick").selectOption("advanced");
  await page.locator("#supports").check();
  await page.locator("#sstyle").selectOption("tree");
  await page.locator("#slice").click();
  await sliced(page);
  const before = limbs(replies.at(-1));
  expect(before, "the ledge grows tree supports").toBeGreaterThan(0);

  await page.getByRole("tab", { name: "Prepare", exact: true }).click();
  await page.keyboard.press("b");
  const bar = page.locator("#paintBar");
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Block" }).click();
  await expect(bar.getByRole("button", { name: "Block" })).toHaveAttribute("aria-pressed", "true");
  await page.locator("#brushRadius").fill("20");
  await expect(page.locator("#brushRadiusOut")).toHaveText("20.0 mm");

  // The ledge's front face, low, near its free end: a 20 mm ball there reaches most of its
  // underside. Hits are bed millimetres, so the face is found from the hits themselves: the
  // ledge spans z 12 to 16 and its front is the lowest y there.
  const canvas = page.locator("#prepare");
  const box = (await canvas.boundingBox())!;
  const hits: { x: number; y: number; at: number[] }[] = [];
  for (let row = 1; row < 40; row++) {
    for (let col = 1; col < 48; col++) {
      const x = box.x + (box.width * col) / 48;
      const y = box.y + (box.height * row) / 40;
      await page.mouse.move(x, y);
      const hit = (await canvas.getAttribute("data-brush-hit")) ?? "";
      if (hit) hits.push({ x, y, at: hit.split(",").map(Number) });
    }
  }
  const ledge = hits.filter((h) => h.at[2]! > 12.2 && h.at[2]! < 13.2);
  const front = Math.min(...ledge.map((h) => h.at[1]!));
  const end = Math.max(...hits.map((h) => h.at[0]!));
  const at = ledge.find((h) => h.at[1]! < front + 0.2 && h.at[0]! > end - 10 && h.at[0]! < end - 2) ?? null;
  expect(at, "the ledge's front face under the pointer").not.toBeNull();

  const sent = replies.length;
  await page.mouse.move(at!.x, at!.y);
  await page.mouse.down();
  await page.mouse.move(at!.x + 12, at!.y, { steps: 6 });
  await page.mouse.up();
  const painted = Number(await canvas.getAttribute("data-paint-disks"));
  expect(painted).toBeGreaterThan(0);
  await expect.poll(() => replies.length, { timeout: SLICE_MS }).toBeGreaterThan(sent);
  await sliced(page);
  const blocked = replies.at(-1)!;
  expect(blocked.supportPaint).toEqual({ enforce: 0, block: painted, enforceUnhit: 0, blockUnhit: 0 });
  expect(limbs(blocked), "block paint drops tips").toBeLessThan(before);
  await expect(page.locator("#paintStatus")).toHaveText(`0 enforce, ${painted} block.`);
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.waitForTimeout(400);
  await canvas.screenshot({ path: path.join(out, "support-paint-block.png") });

  await page.keyboard.press("Control+z");
  await expect(canvas).toHaveAttribute("data-paint-disks", "0");
  await page.locator("#slice").click();
  await sliced(page);
  const restored = replies.at(-1)!;
  expect(restored.supportPaint).toBeUndefined();
  expect(limbs(restored), "undo brings the supports back").toBe(before);
  console.log(`ledge limbs: ${before} unpainted, ${limbs(blocked)} with ${painted} block disk(s), ${limbs(restored)} after undo`);
});
