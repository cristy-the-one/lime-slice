import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
const SHOTS = "C:/Users/marius/AppData/Local/Temp/claude/3b29c894b02d8456/cb98bffa-53e1-40b2-8e01-f9c708602ca7/scratchpad/hide-prepare";

async function commit(page: Page, id: "#placeX" | "#placeY", value: number) {
  await page.locator(id).fill(String(value));
  await page.locator(id).press("Tab");
}

/** The 20 mm cube at (60, 100), and the ledge at (160, 100), added last, so selected. Returns the ledge's id and the slice bodies sent. */
async function twoObjects(page: Page) {
  const bodies: Record<string, unknown>[] = [];
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: cube });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
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
  const id = (await page.locator("#prepare").getAttribute("data-plate-selected"))!;
  expect(id).not.toBe("part");
  await page.locator("#prepare").hover();
  return { ledge: id, bodies };
}

/** Where the cube sits on the page, once the camera has stopped. */
async function cubeCentre(page: Page) {
  const canvas = page.locator("#prepare");
  const read = async () => {
    const entry = ((await canvas.getAttribute("data-plate-context-screen")) ?? "").split(" ").find((item) => item.startsWith("part:"));
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

async function ctrlClick(page: Page, at: { x: number; y: number }) {
  await page.keyboard.down("Control");
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up("Control");
  await page.waitForTimeout(150);
}

const eye = (page: Page, id: string) => page.locator(`[data-prep-eye='${id}']`);

test("a hidden part is not drawn or grabbed in Prepare, Show all brings it back, and it is still sliced", async ({ page }) => {
  const { ledge, bodies } = await twoObjects(page);
  const canvas = page.locator("#prepare");
  await expect(canvas).toHaveAttribute("data-plate-context-count", "1");
  const centre = await cubeCentre(page);
  await expect(eye(page, ledge)).toBeDisabled();
  await expect(page.locator("#plateHiddenNote")).toHaveCount(0);

  await eye(page, "part").click();
  await expect(eye(page, "part")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-plate-id='part']")).toHaveAttribute("data-hidden", "true");
  await expect(canvas).toHaveAttribute("data-plate-context-count", "0");
  await expect(page.locator("#plateHiddenNote")).toContainText("still sliced and printed");
  await page.locator("#gear").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#theme").selectOption("dark");
  await page.locator("#gear").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
  await page.screenshot({ path: `${SHOTS}/prepare-hidden-dark.png` });

  // The hidden cube cannot be grabbed: a Ctrl-click where it stands selects nothing.
  await ctrlClick(page, centre);
  await expect(canvas).toHaveAttribute("data-plate-selected", ledge);

  // It is still on the plate and still sliced.
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect((bodies[0]!.objects as unknown[]).length).toBe(2);

  await page.locator("[data-prep-showall]").click();
  await expect(canvas).toHaveAttribute("data-plate-context-count", "1");
  await expect(page.locator("#plateHiddenNote")).toHaveCount(0);
  await ctrlClick(page, centre);
  await expect(canvas).toHaveAttribute("data-plate-selected", "part");
});

test("selecting a hidden part's row shows it, and the selected part's eye is disabled", async ({ page }) => {
  const { ledge } = await twoObjects(page);
  const canvas = page.locator("#prepare");
  await eye(page, "part").click();
  await expect(canvas).toHaveAttribute("data-plate-context-count", "0");
  await page.locator("[data-plate-select='part']").click();
  await expect(canvas).toHaveAttribute("data-plate-selected", "part");
  await expect(canvas).toHaveAttribute("data-plate-context-count", "1");
  await expect(eye(page, "part")).toBeDisabled();
  await expect(page.locator("#plateHiddenNote")).toHaveCount(0);
  await eye(page, ledge).click();
  await expect(canvas).toHaveAttribute("data-plate-context-count", "0");
});
