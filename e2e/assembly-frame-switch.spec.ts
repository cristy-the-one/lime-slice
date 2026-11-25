import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { linkInPose } from "./link-in-pose";
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
const placed = async (page: Page) => Promise.all(["#poseMoveX", "#poseMoveY", "#poseMoveZ", "#poseMoveRz"].map((id) => field(page, id)));
const solidBox = async (page: Page) => (await canvas(page).getAttribute("data-solid")) ?? "";
const contextBox = async (page: Page) => (((await canvas(page).getAttribute("data-context")) ?? "").split(" ")[0] ?? "").split(":")[1] ?? "";
const pressed = (page: Page, frame: "part" | "model") => page.locator(`#poseMoveFrame [data-place-frame='${frame}']`);

async function openMove(page: Page) {
  await page.locator("#tabPose").click();
  await page.keyboard.press("M");
  await expect(page.locator("#poseMoveX")).toBeVisible();
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
  await openMove(page);
  await expect(page.locator("#poseMoveFrame")).toHaveCount(0);

  // Attached, the hook is a member in the part frame (D2): the switch shows, on Part frame.
  await page.locator("#tabPrepare").click();
  const body = (await page.locator("[data-plate-select]").first().getAttribute("data-plate-select"))!;
  await page.locator(`[data-plate-select='${body}']`).click();
  await linkInPose(page, hook, body);
  await expect(page.locator("[data-assembly-head]")).toContainText("2 parts");
  await page.locator(`[data-plate-select='${hook}']`).click();
  await openMove(page);
  await expect(page.locator("#poseMoveFrame")).toBeVisible();
  await expect(pressed(page, "part")).toHaveAttribute("aria-pressed", "true");
  await expect(pressed(page, "model")).toHaveAttribute("aria-pressed", "false");

  // Turned a quarter and moved, the hook stands in its own frame (M10): drawn unturned, the body turned around it.
  await commit(page, "#poseMoveRz", 90);
  await commit(page, "#poseMoveX", 30);
  expect(await placed(page)).toEqual([30, 0, 0, 90]);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000");
  await expect.poll(() => contextBox(page)).toBe("0.00,-50.00,0.00,30.00,-10.00,20.00");
  expect(await solidBox(page)).toBe("0.00,0.00,0.00,20.00,20.00,10.00");
  await expect(page.locator("#modelPositionOpen")).toHaveAttribute("aria-label", "Position: X 30 · Turn Z 90°. Its Model numbers are in its own frame. Opens Move.");
  await page.waitForTimeout(500);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: path.join(shots, "frame-switch-part.png") });

  // Model frame: the hook is drawn where the assembly puts it, and the Move numbers stay.
  await openMove(page);
  await pressed(page, "model").click();
  await expect(pressed(page, "model")).toHaveAttribute("aria-pressed", "true");
  expect(await placed(page)).toEqual([30, 0, 0, 90]);
  await page.locator("#tabModel").click();
  await expect.poll(() => solidBox(page)).toBe("30.00,0.00,0.00,50.00,20.00,10.00");
  expect(await contextBox(page)).toBe("60.00,0.00,0.00,100.00,30.00,20.00");
  await expect(page.locator("#modelPositionOpen")).toHaveAttribute("aria-label", "Position: X 30 · Turn Z 90°. Its Model numbers are in model space. Opens Move.");
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, "frame-switch-model.png") });

  // The saved file holds what model_place {frame: "model"} writes: no frame key.
  const saved = async () => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
    const doc = JSON.parse(fs.readFileSync((await download.path())!).toString("utf8")) as { objects: { id: string; frame?: string }[] };
    return doc.objects.find((row) => row.id === hook)!;
  };
  expect("frame" in (await saved())).toBe(false);

  // One Move Undo takes the switch back, with the drawing; Redo makes it again. The pose never moved.
  await openMove(page);
  await page.keyboard.press("Control+z");
  await expect(pressed(page, "part")).toHaveAttribute("aria-pressed", "true");
  expect(await placed(page)).toEqual([30, 0, 0, 90]);
  expect((await saved()).frame).toBe("part");
  await page.locator("#tabModel").click();
  await expect.poll(() => solidBox(page)).toBe("0.00,0.00,0.00,20.00,20.00,10.00");
  await openMove(page);
  await page.keyboard.press("Control+y");
  await expect(pressed(page, "model")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#tabModel").click();
  await expect.poll(() => solidBox(page)).toBe("30.00,0.00,0.00,50.00,20.00,10.00");

  // A move after the switch is its own step: Undo takes the move back, and the frame stays model.
  await openMove(page);
  await commit(page, "#poseMoveZ", 4);
  await page.locator("#tabModel").click();
  await expect.poll(() => solidBox(page)).toBe("30.00,0.00,4.00,50.00,20.00,14.00");
  await page.waitForTimeout(500);
  await openMove(page);
  await page.keyboard.press("Control+z");
  await expect(pressed(page, "model")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#tabModel").click();
  await expect.poll(() => solidBox(page)).toBe("30.00,0.00,0.00,50.00,20.00,10.00");

  // Back to Part frame by the switch: the hook stands in its own frame again.
  await openMove(page);
  await pressed(page, "part").click();
  expect((await saved()).frame).toBe("part");
  await page.locator("#tabModel").click();
  await expect.poll(() => solidBox(page)).toBe("0.00,0.00,0.00,20.00,20.00,10.00");

  // The root has a frame too, and is a member: the switch shows for it, on Model frame.
  await page.locator("#tabPrepare").click();
  await page.locator(`[data-plate-select='${body}']`).click();
  await openMove(page);
  await expect(page.locator("#poseMoveFrame")).toBeVisible();
  await expect(pressed(page, "model")).toHaveAttribute("aria-pressed", "true");
});
