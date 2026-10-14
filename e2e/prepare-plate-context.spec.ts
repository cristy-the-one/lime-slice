import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { placeText } from "./place";

async function commit(page: Page, id: "#placeX" | "#placeY", value: number) {
  await page.locator(id).fill(String(value));
  await page.locator(id).press("Tab");
}

/**
 * The 20 mm cube centred at (60, 100) and the 48 x 24 x 16 ledge centred at (160, 100). The ledge, added last, is selected.
 * Returns the ledge's id; the cube's is "part".
 */
async function twoObjects(page: Page): Promise<string> {
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
  await commit(page, "#placeX", 60);
  await commit(page, "#placeY", 100);
  await page.locator("#plateAddFile").setInputFiles("samples/overhang_ledge.stl");
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await commit(page, "#placeX", 160);
  await commit(page, "#placeY", 100);
  const id = await page.locator("#prepare").getAttribute("data-plate-selected");
  expect(id).toBeTruthy();
  expect(id).not.toBe("part");
  return id!;
}

/** Every grey object's world box from the canvas, as `{ id: [minX, minY, minZ, maxX, maxY, maxZ] }`. */
async function greyBoxes(page: Page): Promise<Record<string, number[]>> {
  const raw = (await page.locator("#prepare").getAttribute("data-plate-context")) ?? "";
  return Object.fromEntries(raw.split(" ").filter(Boolean).map((entry) => {
    const [id, numbers] = entry.split(":");
    return [id!, numbers!.split(",").map(Number)];
  }));
}

function expectBox(actual: number[] | undefined, expected: number[]) {
  expect(actual).toBeDefined();
  expected.forEach((value, i) => expect(actual![i]!, `bound ${i}`).toBeCloseTo(value, 1));
}

async function select(page: Page, id: string) {
  await page.locator(`[data-plate-select='${id}']`).click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-selected", id);
}

/** Point the camera at an object, then select another. Frame selects what it frames; selecting does not move the camera. */
async function lookAtThenSelect(page: Page, look: string, selected: string) {
  await page.locator(`[data-plate-frame='${look}']`).click();
  await select(page, selected);
}

/** Where a grey object sits on the page, once the camera has stopped. */
async function greyCentre(page: Page, id: string): Promise<{ x: number; y: number }> {
  const canvas = page.locator("#prepare");
  const read = async () => {
    const raw = (await canvas.getAttribute("data-plate-context-screen")) ?? "";
    const entry = raw.split(" ").find((item) => item.startsWith(`${id}:`));
    return entry ? entry.split(":")[1]!.split(",").map(Number) : null;
  };
  let last = "";
  await expect.poll(async () => {
    const now = JSON.stringify(await read());
    const settled = now === last && now !== "null";
    last = now;
    return settled;
  }).toBe(true);
  const [x, y, w, h] = (await read())!;
  const box = (await canvas.boundingBox())!;
  return { x: box.x + x! + w! / 2, y: box.y + y! + h! / 2 };
}

/** A horizontal stroke across `centre`, as a brush or a drag makes one. */
async function strokeAcross(page: Page, centre: { x: number; y: number }) {
  await page.mouse.move(centre.x - 6, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 6, centre.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

test("the other object is drawn as a mesh at its plate pose, and selecting swaps which one is grey", async ({ page }) => {
  const ledge = await twoObjects(page);
  const canvas = page.locator("#prepare");
  await expect(canvas).toHaveAttribute("data-plate-context-count", "1");
  expect(Object.keys(await greyBoxes(page))).toEqual(["part"]);
  expectBox((await greyBoxes(page)).part, [50, 90, 0, 70, 110, 20]);
  await expect(canvas).toHaveAttribute("data-plate-boxes", `${ledge}:selected`);

  await select(page, "part");
  await expect(canvas).toHaveAttribute("data-plate-context-count", "1");
  expect(Object.keys(await greyBoxes(page))).toEqual([ledge]);
  expectBox((await greyBoxes(page))[ledge], [136, 88, 0, 184, 112, 16]);
  await expect(canvas).toHaveAttribute("data-plate-boxes", "part:selected");

  await page.locator("#rotZ").click();
  expectBox((await greyBoxes(page))[ledge], [136, 88, 0, 184, 112, 16]);
});

test("a grey object follows its own pose and no other object's", async ({ page }) => {
  const ledge = await twoObjects(page);
  const grey = () => greyBoxes(page);
  await commit(page, "#placeX", 190);
  expectBox((await grey()).part, [50, 90, 0, 70, 110, 20]);
  expect(await placeText(page)).toContain("X 190.0");

  await select(page, "part");
  await commit(page, "#placeX", 40);
  expectBox((await grey())[ledge], [166, 88, 0, 214, 112, 16]);
  await page.locator("#rotZ").click();
  expectBox((await grey())[ledge], [166, 88, 0, 214, 112, 16]);
  await page.locator("#partScale").fill("50");
  await page.locator("#partScale").press("Tab");
  expectBox((await grey())[ledge], [166, 88, 0, 214, 112, 16]);
});

test("a plate of one object draws no grey object and no overlap box", async ({ page }) => {
  const ledge = await twoObjects(page);
  const canvas = page.locator("#prepare");
  await page.locator("[data-plate-remove='part']").click();
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await expect(canvas).toHaveAttribute("data-plate-context-count", "0");
  await expect(canvas).not.toHaveAttribute("data-plate-context", /.+/);
  await expect(canvas).toHaveAttribute("data-plate-boxes", `${ledge}:selected`);
});

test("overlapping objects keep their amber boxes, and the grey one stays drawn", async ({ page }) => {
  const ledge = await twoObjects(page);
  const canvas = page.locator("#prepare");
  await expect(canvas).toHaveAttribute("data-plate-overlap", "0");
  await commit(page, "#placeX", 70);
  await expect(canvas).toHaveAttribute("data-plate-overlap", "1");
  await expect(canvas).toHaveAttribute("data-plate-boxes", `part:overlap ${ledge}:overlap`);
  await expect(canvas).toHaveAttribute("data-plate-context-count", "1");
  expectBox((await greyBoxes(page)).part, [50, 90, 0, 70, 110, 20]);

  await commit(page, "#placeX", 160);
  await expect(canvas).toHaveAttribute("data-plate-overlap", "0");
  await expect(canvas).toHaveAttribute("data-plate-boxes", `${ledge}:selected`);
});

test("the brush paints nothing on a grey object, and a click on it selects nothing", async ({ page }) => {
  const ledge = await twoObjects(page);
  const canvas = page.locator("#prepare");
  await lookAtThenSelect(page, "part", ledge);
  const centre = await greyCentre(page, "part");
  await page.locator('[data-tool="seam"]').click();
  await expect(page.locator("#seamBar")).toBeVisible();
  await page.mouse.move(centre.x, centre.y);
  await expect(canvas).toHaveAttribute("data-brush-hit", "");
  await strokeAcross(page, centre);
  await expect(canvas).toHaveAttribute("data-seam-disks", "0");
  await expect(canvas).toHaveAttribute("data-plate-selected", ledge);

  await select(page, "part");
  await page.mouse.move(centre.x, centre.y);
  await expect(canvas).not.toHaveAttribute("data-brush-hit", "");
  await strokeAcross(page, centre);
  await expect(canvas).toHaveAttribute("data-seam-disks", /[1-9]/);
});

test("dragging over a grey object moves nothing, and dragging the selected one moves it", async ({ page }) => {
  const ledge = await twoObjects(page);
  const canvas = page.locator("#prepare");
  await lookAtThenSelect(page, "part", ledge);
  const centre = await greyCentre(page, "part");
  await page.locator('#toolRail [data-tool="move"]').click();
  const before = await placeText(page);
  const greyBefore = await greyBoxes(page);
  await page.mouse.move(centre.x, centre.y);
  await expect.poll(() => canvas.evaluate((el) => (el as HTMLElement).style.cursor)).toBe("");
  await strokeAcross(page, centre);
  expect(await placeText(page)).toBe(before);
  expect(await greyBoxes(page)).toEqual(greyBefore);
  await expect(canvas).toHaveAttribute("data-plate-selected", ledge);

  await select(page, "part");
  const cubeBefore = await placeText(page);
  await page.mouse.move(centre.x, centre.y);
  await expect.poll(() => canvas.evaluate((el) => (el as HTMLElement).style.cursor)).toBe("grab");
  await strokeAcross(page, centre);
  expect(await placeText(page)).not.toBe(cubeBefore);
  expectBox((await greyBoxes(page))[ledge], [136, 88, 0, 184, 112, 16]);
});

test("on a belt printer the grey object sits at its plate pose and prints with every copy", async ({ page }) => {
  await twoObjects(page);
  const canvas = page.locator("#prepare");
  const flat = await greyBoxes(page);
  await page.locator("#machineKind").selectOption("belt");
  await expect(canvas).toHaveAttribute("data-belt", "1");
  await expect(canvas).toHaveAttribute("data-plate-context-count", "1");
  expect(await greyBoxes(page)).toEqual(flat);
  await expect(canvas).toHaveAttribute("data-belt-ghosts", "0");

  await page.locator("#beltCopies").fill("3");
  await page.locator("#beltCopies").blur();
  await expect(canvas).toHaveAttribute("data-belt-copies", "3");
  // Two later copies, each of the selected object and of the grey one.
  await expect(canvas).toHaveAttribute("data-belt-ghosts", "4");
  expect(await greyBoxes(page)).toEqual(flat);
});
