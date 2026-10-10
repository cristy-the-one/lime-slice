import { expect, test, type Page } from "@playwright/test";

/**
 * A two-object plate against a real engine, which slices each object in its own
 * part frame. Needs a running engine with its disk cache, as the desktop app has:
 *   lime-slice serve --port 43218 --cache-dir <dir>
 *   LIME_EDIT_API=http://127.0.0.1:43218 npx playwright test plate-real
 */
const api = process.env.LIME_EDIT_API;

test.skip(!api, "set LIME_EDIT_API to a running lime-slice serve");
test.setTimeout(300_000);

const SLICE_MS = 120_000;

type Reply = {
  gcode?: string;
  gcodeToken?: string;
  fromCache?: boolean;
  previewPatch?: { changed: unknown[] };
  objects?: { id: string; offset: [number, number] }[];
};

async function sliced(page: Page) {
  await expect(page.locator("#slice")).toBeEnabled({ timeout: SLICE_MS });
  await expect(page.locator("#cancel")).toBeHidden();
}

/** Send the app's engine calls to the real engine, and keep each slice reply. */
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

async function gcodeOf(page: Page, reply: Reply) {
  if (reply.gcode) return reply.gcode;
  const res = await page.request.get(`${api}/api/gcode/${reply.gcodeToken}`);
  expect(res.ok()).toBe(true);
  return res.text();
}

/** X range of each object's part tours: the extrusions after each `;OBJECT:<id>` up to the next object or layer. */
function objectX(gcode: string): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  let id: string | null = null;
  for (const line of gcode.split("\n")) {
    if (line.startsWith(";OBJECT:")) id = line.slice(8).trim();
    else if (line.startsWith(";LAYER:")) id = null;
    const x = id && /^G1 .*X(-?[\d.]+).*E/.exec(line);
    if (!x || !id) continue;
    const [lo, hi] = out.get(id) ?? [Infinity, -Infinity];
    out.set(id, [Math.min(lo, Number(x[1])), Math.max(hi, Number(x[1]))]);
  }
  return out;
}

async function commitX(page: Page, value: string) {
  const field = page.locator("#placeX");
  await field.fill(value);
  await field.press("Tab");
}

test("moving one plate object re-emits only its G-code, without a click", async ({ page }) => {
  const replies = await proxy(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator("#file").setInputFiles("samples/dragon_2_5.stl");
  await expect(page.locator("#objectList .obj").first()).toBeVisible({ timeout: 30_000 });
  await page.locator("#plateAdd").click();
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
  await page.locator("#plateArrange").click();
  await expect(page.locator("#plateOverlap")).toHaveCount(0);

  await page.locator("#slice").click();
  await sliced(page);
  // A disk-cache hit leaves the kept plan to a background warm-up, so plan this one.
  await page.locator("#force").click();
  await sliced(page);
  await expect(page.locator("#export")).toBeEnabled();
  const first = replies.at(-1)!;
  expect(first.fromCache).toBe(false);
  expect(first.objects?.map((o) => o.id)).toEqual(["part", expect.stringMatching(/^obj-/)]);
  const [a, b] = first.objects!.map((o) => o.id);
  const before = objectX(await gcodeOf(page, first));
  expect([...before.keys()].sort()).toEqual([a, b].sort());
  await expect(page.locator("#view3d")).toHaveAttribute("data-object-offsets", /;/);

  await page.locator("[data-plate-select]").nth(1).click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-selected", b);
  const fromX = Number(await page.locator("#placeX").inputValue());
  const count = replies.length;
  const committed = Date.now();
  await commitX(page, String(fromX + 25));
  await expect(page.locator("#export")).toBeEnabled({ timeout: SLICE_MS });
  await expect.poll(() => replies.length, { timeout: SLICE_MS }).toBe(count + 1);
  console.log(`plate move: commit to export enabled ${Date.now() - committed} ms`);
  await expect(page.locator("#stage")).not.toHaveClass(/stale/);
  const moved = replies.at(-1)!;
  expect(moved.fromCache || moved.previewPatch?.changed.length === 0, "the move re-emitted as a 0-layer patch or came from the store").toBe(true);
  expect(moved.objects!.find((o) => o.id === b)!.offset[0] - first.objects!.find((o) => o.id === b)!.offset[0]).toBeCloseTo(25, 1);
  expect(moved.objects!.find((o) => o.id === a)!.offset).toEqual(first.objects!.find((o) => o.id === a)!.offset);

  const after = objectX(await gcodeOf(page, moved));
  expect(after.get(a)![0]).toBeCloseTo(before.get(a)![0], 2);
  expect(after.get(a)![1]).toBeCloseTo(before.get(a)![1], 2);
  expect(after.get(b)![0] - before.get(b)![0]).toBeCloseTo(25, 1);
  expect(after.get(b)![1] - before.get(b)![1]).toBeCloseTo(25, 1);
});
