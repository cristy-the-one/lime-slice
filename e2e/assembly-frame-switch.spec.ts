import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type MockSolid } from "./model-tree-mock";

/**
 * Assemblies M11 (docs/plan-assemblies.md, section 4): the Place tool's "Part frame | Model frame" switch. It shows for
 * a member of an assembly only, sets the part's `frame` (the field model_place {frame} sets) as one Undo step, and with
 * M10 it changes how Model draws and numbers the part.
 */

const shots = process.env.LIME_SHOTS ?? path.join("test-results", "assembly-frame-switch");

type V = [number, number, number];

/** A box the modeler reports as a solid, in its own CAD frame, from `at`. */
function boxSolid(size: V, at: V = [0, 0, 0]): MockSolid {
  const [sx, sy, sz] = size;
  const c = (x: number, y: number, z: number): V => [at[0] + x * sx, at[1] + y * sy, at[2] + z * sz];
  const quads: V[][] = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  const positions: number[] = [];
  const triangles: number[] = [];
  quads.forEach((q, face) => {
    for (const tri of [[0, 1, 2], [0, 2, 3]]) {
      for (const i of tri) positions.push(...q[i]!);
      triangles.push(face);
    }
  });
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [] };
}

const SOLIDS: Record<string, MockSolid> = {
  "body.step": boxSolid([40, 30, 20], [60, 0, 0]),
  "hook.step": boxSolid([20, 20, 10]),
};

async function commit(page: Page, id: string, value: number) {
  await page.locator(id).fill(String(value));
  await page.locator(id).press("Tab");
}

const canvas = (page: Page) => page.locator("#model");
const field = async (page: Page, id: string) => Number(await page.locator(id).inputValue());
const placed = async (page: Page) => Promise.all(["#modelPlaceX", "#modelPlaceY", "#modelPlaceZ", "#modelPlaceRz"].map((id) => field(page, id)));
const solidBox = async (page: Page) => (await canvas(page).getAttribute("data-solid")) ?? "";
const contextBox = async (page: Page) => (((await canvas(page).getAttribute("data-context")) ?? "").split(" ")[0] ?? "").split(":")[1] ?? "";
const pressed = (page: Page, frame: "part" | "model") => page.locator(`#modelPlaceFrame [data-place-frame='${frame}']`);

async function openPlace(page: Page) {
  if ((await page.locator("#modelToolPlace").getAttribute("aria-pressed")) !== "true") await page.locator("#modelToolPlace").click();
  await expect(page.locator("#modelPlaceX")).toBeVisible();
}

/** The body and the hook on the bed, the hook open in Model before it is attached. Returns the hook's id. */
async function twoParts(page: Page): Promise<string> {
  const named = (route: { request(): { postDataJSON(): { filename?: string } } }) => SOLIDS[route.request().postDataJSON().filename ?? ""]!;
  await page.addInitScript(() => {
    localStorage.setItem("lime-slice-theme", "dark");
    localStorage.setItem("lime-slice-closed-groups", "[]");
  });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: named(route).positions } }));
  await mockModelTree(page, { open: (request) => SOLIDS[String(request.filename)]!, probe: () => ({ ok: true }) });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  const step = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
  await page.locator("#file").setInputFiles({ name: "body.step", mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await page.locator("#tabPrepare").click();
  await commit(page, "#placeX", 100);
  await commit(page, "#placeY", 100);
  await page.locator("#plateAddFile").setInputFiles({ name: "hook.step", mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await commit(page, "#placeX", 160);
  await commit(page, "#placeY", 100);
  return (await page.locator("#prepare").getAttribute("data-plate-selected"))!;
}

test("the Place tool's frame switch: members only, one Undo step, and Model draws the part in the frame chosen", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  const hook = await twoParts(page);

  // A part in no assembly has no frame to switch.
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000");
  await openPlace(page);
  await expect(page.locator("#modelPlaceFrame")).toBeHidden();
  await page.locator("#modelCancel").click();

  // Attached, the hook is a member in the part frame (D2): the switch shows, on Part frame.
  await page.locator("#tabPrepare").click();
  const body = (await page.locator("[data-plate-select]").first().getAttribute("data-plate-select"))!;
  await page.locator(`[data-plate-select='${body}']`).click();
  await page.locator(`[data-plate-attach='${hook}']`).click();
  await expect(page.locator("[data-assembly-head]")).toContainText("2 parts");
  await page.locator(`[data-plate-select='${hook}']`).click();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000");
  await openPlace(page);
  await expect(page.locator("#modelPlaceFrame")).toBeVisible();
  await expect(pressed(page, "part")).toHaveAttribute("aria-pressed", "true");
  await expect(pressed(page, "model")).toHaveAttribute("aria-pressed", "false");

  // Turned a quarter and moved, the hook stands in its own frame (M10): drawn unturned, the body turned around it.
  await commit(page, "#modelPlaceRz", 90);
  await commit(page, "#modelPlaceX", 30);
  await expect.poll(() => contextBox(page)).toBe("0.00,-50.00,0.00,30.00,-10.00,20.00");
  expect(await solidBox(page)).toBe("0.00,0.00,0.00,20.00,20.00,10.00");
  await expect(page.locator("#modelPositionOpen")).toHaveAttribute("aria-label", "Position: X 30 · Turn Z 90°. Its Model numbers are in its own frame. Opens Place.");
  await page.waitForTimeout(500);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: path.join(shots, "frame-switch-part.png") });

  // Model frame: the hook is drawn where the assembly puts it, beside the body as it stands in model space, and the
  // Place numbers, which are the assembly pose, stay.
  await pressed(page, "model").click();
  await expect(pressed(page, "model")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => solidBox(page)).toBe("30.00,0.00,0.00,50.00,20.00,10.00");
  expect(await contextBox(page)).toBe("60.00,0.00,0.00,100.00,30.00,20.00");
  expect(await placed(page)).toEqual([30, 0, 0, 90]);
  await expect(page.locator("#modelPositionOpen")).toHaveAttribute("aria-label", "Position: X 30 · Turn Z 90°. Its Model numbers are in model space. Opens Place.");
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, "frame-switch-model.png") });

  // The saved file holds what model_place {frame: "model"} writes: no frame key.
  const saved = async () => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
    const doc = JSON.parse(fs.readFileSync((await download.path())!).toString("utf8")) as { objects: { id: string; frame?: string }[] };
    return doc.objects.find((row) => row.id === hook)!;
  };
  expect("frame" in (await saved())).toBe(false);

  // One Place Undo takes the switch back, with the drawing; Redo makes it again. The pose never moved.
  await page.locator("#modelUndo").click();
  await expect(pressed(page, "part")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => solidBox(page)).toBe("0.00,0.00,0.00,20.00,20.00,10.00");
  expect(await placed(page)).toEqual([30, 0, 0, 90]);
  expect((await saved()).frame).toBe("part");
  await page.locator("#modelRedo").click();
  await expect(pressed(page, "model")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => solidBox(page)).toBe("30.00,0.00,0.00,50.00,20.00,10.00");

  // A move after the switch is its own step: Undo takes the move back, and the frame stays model.
  await commit(page, "#modelPlaceZ", 4);
  await expect.poll(() => solidBox(page)).toBe("30.00,0.00,4.00,50.00,20.00,14.00");
  await page.waitForTimeout(500);
  await page.locator("#modelUndo").click();
  await expect.poll(() => solidBox(page)).toBe("30.00,0.00,0.00,50.00,20.00,10.00");
  await expect(pressed(page, "model")).toHaveAttribute("aria-pressed", "true");

  // Back to Part frame by the switch: the hook stands in its own frame again.
  await pressed(page, "part").click();
  await expect.poll(() => solidBox(page)).toBe("0.00,0.00,0.00,20.00,20.00,10.00");
  expect((await saved()).frame).toBe("part");

  // The root has a frame too, and is a member: the switch shows for it, on Model frame.
  await page.locator("#modelCancel").click();
  await page.locator("#tabPrepare").click();
  await page.locator(`[data-plate-select='${body}']`).click();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 24000");
  await openPlace(page);
  await expect(page.locator("#modelPlaceFrame")).toBeVisible();
  await expect(pressed(page, "model")).toHaveAttribute("aria-pressed", "true");
});
