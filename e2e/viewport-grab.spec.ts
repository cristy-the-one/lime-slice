import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { placeText } from "./place";

async function commit(page: Page, id: "#placeX" | "#placeY", value: number) {
  await page.locator(id).fill(String(value));
  await page.locator(id).press("Tab");
}

/** The 20 mm cube at (90, 100) and the 48 x 24 x 16 ledge at (150, 100). The ledge, added last, is selected. Returns its id. */
async function twoObjects(page: Page): Promise<string> {
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
  await commit(page, "#placeX", 90);
  await commit(page, "#placeY", 100);
  await page.locator("#plateAddFile").setInputFiles("samples/overhang_ledge.stl");
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await commit(page, "#placeX", 150);
  await commit(page, "#placeY", 100);
  const id = await page.locator("#prepare").getAttribute("data-plate-selected");
  expect(id).toBeTruthy();
  expect(id).not.toBe("part");
  const box = (await page.locator("#prepare").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 300);
  return id!;
}

async function selectedId(page: Page) {
  return page.locator("#prepare").getAttribute("data-plate-selected");
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

/** Make the cube the selection, so the ledge is grey, and return where the ledge is on screen. */
async function ledgeGrey(page: Page, ledge: string) {
  await page.locator("[data-plate-select='part']").click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-selected", "part");
  return greyCentre(page, ledge);
}

async function xy(page: Page): Promise<{ x: number; y: number }> {
  return { x: Number(await page.locator("#placeX").inputValue()), y: Number(await page.locator("#placeY").inputValue()) };
}

async function size(page: Page): Promise<string> {
  const text = (await page.locator("#statusText").textContent()) ?? "";
  return text.split("·")[1]?.trim() ?? "";
}

async function blurFocus(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function dragWith(page: Page, from: { x: number; y: number }, by: { dx: number; dy: number }, button: "left" | "right" = "left", steps = 8) {
  await page.keyboard.down("Control");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  await page.mouse.move(from.x + by.dx, from.y + by.dy, { steps });
  await page.mouse.up({ button });
  await page.keyboard.up("Control");
}

test("Ctrl-click selects a grey object; a plain click does not", async ({ page }) => {
  const ledge = await twoObjects(page);
  const centre = await ledgeGrey(page, ledge);
  await page.mouse.click(centre.x, centre.y);
  expect(await selectedId(page)).toBe("part");

  await page.keyboard.down("Control");
  await page.mouse.click(centre.x, centre.y);
  await page.keyboard.up("Control");
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-selected", ledge);
  expect(await xy(page)).toEqual({ x: 150, y: 100 });
});

test("Ctrl-drag on a grey object selects it and carries on as a grab", async ({ page }) => {
  const ledge = await twoObjects(page);
  const centre = await ledgeGrey(page, ledge);
  await dragWith(page, centre, { dx: 150, dy: 0 });
  expect(await selectedId(page)).toBe(ledge);
  expect((await xy(page)).x).toBeGreaterThan(160);
});

test("a Ctrl-drag moves the part by what the move gizmo's drag moves it", async ({ page }) => {
  const ledge = await twoObjects(page);
  const centre = await ledgeGrey(page, ledge);
  await page.keyboard.down("Control");
  await page.mouse.click(centre.x, centre.y);
  await page.keyboard.up("Control");
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-selected", ledge);

  await page.locator('#toolRail [data-tool="move"]').click();
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 150, centre.y + 60, { steps: 8 });
  await page.mouse.up();
  const viaGizmo = await xy(page);
  expect(Math.abs(viaGizmo.x - 150)).toBeGreaterThan(10);
  expect(Math.abs(viaGizmo.y - 100)).toBeGreaterThan(1);

  await commit(page, "#placeX", 150);
  await commit(page, "#placeY", 100);
  await page.locator('#toolRail [data-tool="move"]').click();
  await blurFocus(page);
  await dragWith(page, centre, { dx: 150, dy: 60 });
  const viaGrab = await xy(page);
  expect(Math.abs(viaGrab.x - viaGizmo.x)).toBeLessThan(0.1);
  expect(Math.abs(viaGrab.y - viaGizmo.y)).toBeLessThan(0.1);
});

test("Shift while grabbing snaps the move to whole millimetres", async ({ page }) => {
  const ledge = await twoObjects(page);
  const centre = await ledgeGrey(page, ledge);
  await page.keyboard.down("Shift");
  await dragWith(page, centre, { dx: 53, dy: 17 });
  await page.keyboard.up("Shift");
  const moved = await xy(page);
  expect(moved.x - 150).not.toBe(0);
  expect(Math.abs(moved.x - Math.round(moved.x))).toBeLessThan(0.06);
  expect(Math.abs(moved.y - Math.round(moved.y))).toBeLessThan(0.06);
});

test("a Ctrl-right-drag turns the part about Z with the gizmo's label, and it stays on the bed", async ({ page }) => {
  const ledge = await twoObjects(page);
  const centre = await ledgeGrey(page, ledge);
  await page.keyboard.down("Control");
  await page.mouse.click(centre.x, centre.y);
  expect(await size(page)).toMatch(/48\.0 × 24\.0 × 16\.0 mm/);
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(centre.x + 180, centre.y, { steps: 12 });
  await expect(page.locator("#gizmoReadout")).toHaveText("Z +90°");
  await page.mouse.up({ button: "right" });
  await page.keyboard.up("Control");
  await expect.poll(() => size(page)).toMatch(/24\.0 × 48\.0 × 16\.0 mm/);
  expect(await placeText(page)).toContain("bed Z 0.0");
  await expect(page.locator("#gizmoReadout")).toBeHidden();
});

test("X, Y and Z during a turn pick the axis", async ({ page }) => {
  const ledge = await twoObjects(page);
  const centre = await ledgeGrey(page, ledge);
  await page.keyboard.down("Control");
  await page.mouse.click(centre.x, centre.y);
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down({ button: "right" });
  await page.keyboard.press("x");
  await page.mouse.move(centre.x + 180, centre.y, { steps: 12 });
  await expect(page.locator("#gizmoReadout")).toHaveText("X +90°");
  await page.mouse.up({ button: "right" });
  await expect.poll(() => size(page)).toMatch(/48\.0 × 16\.0 × 24\.0 mm/);
  expect(await placeText(page)).toContain("bed Z 0.0");

  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down({ button: "right" });
  await page.keyboard.press("y");
  await page.mouse.move(centre.x + 180, centre.y, { steps: 12 });
  await expect(page.locator("#gizmoReadout")).toHaveText("Y +90°");
  await page.mouse.up({ button: "right" });
  await page.keyboard.up("Control");
  await expect.poll(() => size(page)).toMatch(/24\.0 × 16\.0 × 48\.0 mm/);
  expect(await placeText(page)).toContain("bed Z 0.0");
});

test("Esc during a grab puts the pose back and leaves no undo step", async ({ page }) => {
  const ledge = await twoObjects(page);
  const centre = await ledgeGrey(page, ledge);
  await page.keyboard.down("Control");
  await page.mouse.click(centre.x, centre.y);
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 80, centre.y, { steps: 8 });
  expect((await xy(page)).x).toBeGreaterThan(160);
  await page.keyboard.press("Escape");
  expect(await xy(page)).toEqual({ x: 150, y: 100 });
  await page.mouse.move(centre.x + 120, centre.y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Control");
  expect(await xy(page)).toEqual({ x: 150, y: 100 });
  await expect(page.locator("#gizmoReadout")).toBeHidden();

  await page.mouse.move(centre.x, centre.y);
  await page.keyboard.down("Control");
  await page.mouse.down({ button: "right" });
  await page.mouse.move(centre.x + 180, centre.y, { steps: 8 });
  await page.keyboard.press("Escape");
  await page.mouse.up({ button: "right" });
  await page.keyboard.up("Control");
  expect(await size(page)).toMatch(/48\.0 × 24\.0 × 16\.0 mm/);

  await blurFocus(page);
  await page.keyboard.press("Control+z");
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-selected", "part");
});

test("one grab is one undo step, even when the pointer rests mid-drag", async ({ page }) => {
  const ledge = await twoObjects(page);
  const centre = await ledgeGrey(page, ledge);
  await page.keyboard.down("Control");
  await page.mouse.click(centre.x, centre.y);
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 40, centre.y, { steps: 5 });
  await page.waitForTimeout(450);
  await page.mouse.move(centre.x + 80, centre.y + 20, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Control");
  expect((await xy(page)).x).toBeGreaterThan(160);

  await blurFocus(page);
  await page.keyboard.press("Control+z");
  await expect.poll(() => xy(page)).toEqual({ x: 150, y: 100 });
  expect(await selectedId(page)).toBe(ledge);
  await page.keyboard.press("Control+z");
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-selected", "part");
});

test("a plain drag still orbits, over an object or off it", async ({ page }) => {
  const ledge = await twoObjects(page);
  const centre = await ledgeGrey(page, ledge);
  const cam = () => page.locator("#prepare").getAttribute("data-cam");
  const before = await cam();
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 90, centre.y - 20, { steps: 8 });
  await page.mouse.up();
  await expect.poll(cam).not.toBe(before);
  expect(await selectedId(page)).toBe("part");
  const placed = await xy(page);
  expect(placed).toEqual({ x: 90, y: 100 });

  const box = (await page.locator("#prepare").boundingBox())!;
  const orbited = await cam();
  await page.mouse.move(box.x + 60, box.y + box.height - 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + box.height - 90, { steps: 8 });
  await page.mouse.up();
  await expect.poll(cam).not.toBe(orbited);
  expect(await xy(page)).toEqual(placed);
});

test("the first Ctrl over an object says what a drag does, and only the first time", async ({ page }) => {
  const ledge = await twoObjects(page);
  const centre = await ledgeGrey(page, ledge);
  const hint = page.locator("#grabHint");
  await page.mouse.move(centre.x, centre.y);
  await expect(hint).toBeHidden();
  await page.keyboard.down("Control");
  await page.mouse.move(centre.x + 3, centre.y + 2);
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("Drag to move");
  await expect(hint).toContainText("Right-drag to turn");
  await page.keyboard.up("Control");
  await expect(hint).toBeHidden();

  await page.keyboard.down("Control");
  await page.mouse.move(centre.x, centre.y);
  await page.waitForTimeout(150);
  await expect(hint).toBeHidden();
  await page.keyboard.up("Control");
});

test("Ctrl-drag and Ctrl-right-drag off every object still move the camera and touch no object", async ({ page }) => {
  const ledge = await twoObjects(page);
  await ledgeGrey(page, ledge);
  const cam = () => page.locator("#prepare").getAttribute("data-cam");
  const box = (await page.locator("#prepare").boundingBox())!;
  const empty = { x: box.x + 90, y: box.y + box.height - 90 };
  for (const button of ["left", "right"] as const) {
    const before = await cam();
    await dragWith(page, empty, { dx: 80, dy: -30 }, button);
    await expect.poll(cam).not.toBe(before);
    expect(await selectedId(page)).toBe("part");
    expect(await xy(page)).toEqual({ x: 90, y: 100 });
    expect(await size(page)).toMatch(/20\.0 × 20\.0 × 20\.0 mm/);
  }
  await expect(page.locator("#gizmoReadout")).toBeHidden();
});
