import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

/**
 * A part of glass is drawn see-through in Pose (docs: the Glass checkbox in the selected part's card, `pose-glass`), saved
 * with the project and one Undo step. The object under the pointer that a click would select is outlined in Pose and in
 * Prepare, and `data-hover-object` says which.
 */

const shots = process.env.LIME_SHOTS ?? path.join("test-results", "ux-glass-hover");

async function commit(page: Page, id: "#placeX" | "#placeY", value: number) {
  await page.locator(id).fill(String(value));
  await page.locator(id).press("Tab");
}

/** The cube ("part") at (90, 100) and the ledge at (150, 100), the ledge selected. Returns the ledge's id. */
async function cubeAndLedge(page: Page): Promise<string> {
  await page.addInitScript(() => {
    localStorage.setItem("lime-slice-theme", "dark");
    localStorage.setItem("lime-slice-closed-groups", "[]");
  });
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
  return id!;
}

async function openPose(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("2");
  await expect(page.locator("#tabPose")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#pose")).toHaveAttribute("data-opaque", /true|false/);
}

/** One animation frame later, twice: the hover is picked on the next frame, and drawn on the one after. */
async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

test("a Glass part is see-through in Pose, saved with the project, and one Undo step", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  const ledge = await cubeAndLedge(page);
  await page.locator(`[data-plate-select='${ledge}']`).click();
  await openPose(page);
  const pose = page.locator("#pose");
  await expect(pose).toHaveAttribute("data-opaque", "true");
  await expect(pose).not.toHaveAttribute("data-glass", /.+/);

  const glass = page.locator("#posePanel [data-pose-glass]");
  await expect(glass).toHaveAttribute("data-pose-glass", ledge);
  await expect(glass).not.toBeChecked();
  await glass.check();
  await expect(pose).toHaveAttribute("data-opaque", "false");
  await expect(pose).toHaveAttribute("data-glass", ledge);
  // Selection still tints it.
  await expect(pose).toHaveAttribute("data-looks", `${ledge}:selected`);

  // One Ctrl+Z takes it back, and Redo brings it again.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+z");
  await expect(pose).toHaveAttribute("data-opaque", "true");
  await expect(page.locator("#posePanel [data-pose-glass]")).not.toBeChecked();
  await page.keyboard.press("Control+Shift+z");
  await expect(pose).toHaveAttribute("data-opaque", "false");
  await expect(page.locator("#posePanel [data-pose-glass]")).toBeChecked();

  // The shot with the ledge selected: glass, tinted by the selection.
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, "pose-glass-selected.png") });

  // It stays pickable, and a pick selects without moving the camera.
  const box = (await pose.boundingBox())!;
  await page.waitForTimeout(400);
  const camera = await pose.getAttribute("data-camera");
  expect(camera).toBeTruthy();
  let picked = "";
  for (let y = 0.3; y <= 0.8 && picked !== ledge; y += 0.05) {
    for (let x = 0.3; x <= 0.8 && picked !== ledge; x += 0.05) {
      await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
      picked = (await pose.getAttribute("data-picked")) ?? "";
    }
  }
  expect(picked, "a click on the glass part picks it").toBe(ledge);
  await page.locator("[data-pose-action='select'][data-object='part']").click();
  await expect(pose).toHaveAttribute("data-selected", "part");
  await page.waitForTimeout(400);
  expect(await pose.getAttribute("data-camera"), "selecting does not move the camera").toBe(camera);

  // The shot: the ledge as glass, the cube solid behind it.
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, "pose-glass.png") });

  // Saved with the project, and read back from it; a file without the field reads as not glass.
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const doc = JSON.parse(fs.readFileSync((await download.path())!).toString("utf8")) as { version: number; objects: { id: string; glass?: boolean }[] };
  expect(doc.objects.find((row) => row.id === ledge)?.glass).toBe(true);
  expect(doc.objects.find((row) => row.id === "part")?.glass).toBeUndefined();
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "glass.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await openPose(page);
  await expect(pose).toHaveAttribute("data-opaque", "false");
  await expect(pose).toHaveAttribute("data-glass", ledge);

  const older = { ...doc, objects: doc.objects.map(({ glass: _glass, ...row }) => row) };
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "older.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(older)) });
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await openPose(page);
  await expect(pose).toHaveAttribute("data-opaque", "true");
});

test("the Glass command is listed with its reason until a part is selected in Pose", async ({ page }) => {
  const ledge = await cubeAndLedge(page);
  const row = page.locator('#paletteList [data-id="pose-glass"]');
  const ask = async () => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Control+K");
    await page.locator("#paletteInput").fill("glass");
  };
  const close = async () => {
    await page.keyboard.press("Escape");
    await expect(page.locator("#palette")).toBeHidden();
  };
  // In Prepare it is listed but cannot run: the reason is in its tip, never hidden.
  await ask();
  await expect(row).toHaveAttribute("aria-disabled", "true");
  await expect(row).toHaveAttribute("title", "Glass is in Pose.");
  await close();

  // In Pose with a part selected it runs: the command ticks the Glass checkbox.
  await page.locator(`[data-plate-select='${ledge}']`).click();
  await openPose(page);
  await ask();
  await expect(row).not.toHaveAttribute("aria-disabled", "true");
  await row.click();
  await expect(page.locator("#pose")).toHaveAttribute("data-glass", ledge);
});

test("Pose outlines the part under the pointer, and says which in data-hover-object", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  const ledge = await cubeAndLedge(page);
  await page.locator(`[data-plate-select='${ledge}']`).click();
  await openPose(page);
  const pose = page.locator("#pose");
  await expect(pose).toHaveAttribute("data-hover-object", "");
  const box = (await pose.boundingBox())!;

  // Sweep the view for the cube, the part that is not selected. The selected ledge is never outlined.
  let found: { x: number; y: number } | null = null;
  for (let y = 0.25; y <= 0.85 && !found; y += 0.05) {
    for (let x = 0.2; x <= 0.8 && !found; x += 0.04) {
      await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
      await frames(page);
      const hovered = await pose.getAttribute("data-hover-object");
      expect(hovered, "the selected part is never outlined").not.toBe(ledge);
      if (hovered === "part") found = { x: box.x + box.width * x, y: box.y + box.height * y };
    }
  }
  expect(found, "the cube is somewhere under the pointer").not.toBeNull();
  await expect(pose).toHaveAttribute("data-hover-drawn", "true");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, "hover-pose.png") });

  // Not while a button is down: an orbit that passes over the cube outlines nothing.
  await page.mouse.move(box.x + 12, box.y + box.height - 12);
  await expect(pose).toHaveAttribute("data-hover-object", "");
  await page.mouse.down();
  await page.mouse.move(found!.x, found!.y, { steps: 6 });
  await frames(page);
  await expect(pose).toHaveAttribute("data-hover-object", "");
  await page.mouse.up();

  // Gone when the pointer leaves the canvas.
  await page.mouse.move(found!.x, found!.y);
  await expect(pose).toHaveAttribute("data-hover-object", /part|^$/);
  await page.mouse.move(box.x + box.width + 40, box.y + 40);
  await expect(pose).toHaveAttribute("data-hover-object", "");
  await expect(pose).toHaveAttribute("data-hover-drawn", "false");
});

/** Where a grey object sits on the Prepare page, once the camera has stopped. */
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

test("Prepare outlines the grey object a Ctrl-click would select, and clears it when the pointer leaves", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  const ledge = await cubeAndLedge(page);
  await page.locator("[data-plate-select='part']").click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-selected", "part");
  const canvas = page.locator("#prepare");
  // Back off, so the grey ledge is on screen.
  const stage = (await canvas.boundingBox())!;
  await page.mouse.move(stage.x + stage.width * 0.6, stage.y + stage.height * 0.6);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 300);
  const centre = await greyCentre(page, ledge);

  await page.mouse.move(centre.x, centre.y);
  await expect(canvas).toHaveAttribute("data-hover-object", ledge);
  await expect(canvas).toHaveAttribute("data-hover-drawn", "true");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, "hover-prepare.png") });

  // Over the selected part itself, nothing: it is already marked.
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 6, box.y + box.height / 2);
  await expect(canvas).toHaveAttribute("data-hover-object", "");

  // Not while a button is down.
  await page.mouse.move(box.x + 60, box.y + box.height - 60);
  await page.mouse.down();
  await page.mouse.move(centre.x, centre.y, { steps: 6 });
  await frames(page);
  await expect(canvas).toHaveAttribute("data-hover-object", "");
  await page.mouse.up();

  // Leaving the canvas clears it. The orbit moved the camera, so the ledge stands elsewhere now.
  const moved = await greyCentre(page, ledge);
  await page.mouse.move(moved.x, moved.y);
  await expect(canvas).toHaveAttribute("data-hover-object", ledge);
  await page.mouse.move(box.x + box.width + 60, box.y + 20);
  await expect(canvas).toHaveAttribute("data-hover-object", "");

  // A Ctrl-click on it selects it and leaves the camera where it was; the selected one is not outlined.
  const camera = await canvas.getAttribute("data-cam");
  await page.keyboard.down("Control");
  await page.mouse.click(moved.x, moved.y);
  await page.keyboard.up("Control");
  await expect(canvas).toHaveAttribute("data-plate-selected", ledge);
  await page.waitForTimeout(400);
  expect(await canvas.getAttribute("data-cam"), "selecting does not move the camera").toBe(camera);
  await page.mouse.move(moved.x + 2, moved.y + 1);
  await frames(page);
  await expect(canvas).toHaveAttribute("data-hover-object", "");
});
