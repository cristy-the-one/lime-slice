import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

type V = [number, number, number];

/** A box the modeler reports as a solid, in its own CAD frame. */
function boxSolid(size: V) {
  const [sx, sy, sz] = size;
  const c = (x: number, y: number, z: number): V => [x * sx, y * sy, z * sz];
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
  return { id: 1, volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [] };
}

const SOLIDS: Record<string, ReturnType<typeof boxSolid>> = {
  "big.step": boxSolid([40, 30, 20]),
  "small.step": boxSolid([20, 20, 10]),
};

async function commit(page: Page, id: "#placeX" | "#placeY", value: number) {
  await page.locator(id).fill(String(value));
  await page.locator(id).press("Tab");
}

/** Two objects on the plate: big centred at (100, 100), small at (160, 100). The small one is selected. */
async function twoObjects(page: Page) {
  const named = (route: { request(): { postDataJSON(): { filename?: string } } }) => SOLIDS[route.request().postDataJSON().filename ?? ""]!;
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/model/probe", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: named(route).positions } }));
  await page.route("**/api/model", (route) => route.fulfill({ json: named(route) }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  const step = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
  await page.locator("#file").setInputFiles({ name: "big.step", mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await page.locator("#tabPrepare").click();
  await commit(page, "#placeX", 100);
  await commit(page, "#placeY", 100);
  await page.locator("#plateAddFile").setInputFiles({ name: "small.step", mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await commit(page, "#placeX", 160);
  await commit(page, "#placeY", 100);
}

async function openModel(page: Page, which: "big" | "small") {
  await page.locator("#tabPrepare").click();
  await page.locator("[data-plate-select]").nth(which === "big" ? 0 : 1).click();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
}

/** Every context part's world box from the canvas, as `{ id: [minX, minY, minZ, maxX, maxY, maxZ] }`. */
async function contextBoxes(page: Page): Promise<Record<string, number[]>> {
  const raw = (await page.locator("#model").getAttribute("data-context")) ?? "";
  return Object.fromEntries(raw.split(" ").filter(Boolean).map((entry) => {
    const [id, numbers] = entry.split(":");
    return [id!, numbers!.split(",").map(Number)];
  }));
}

/** What a click at each point of a grid over the canvas picks, as the readout words it. */
async function clickGrid(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#model")!;
    const readout = document.querySelector("#modelReadout")!;
    const rect = canvas.getBoundingClientRect();
    const out: string[] = [];
    for (let y = rect.top + 8; y < rect.bottom; y += 36) {
      for (let x = rect.left + 8; x < rect.right; x += 36) {
        const init = { button: 0, clientX: x, clientY: y, pointerId: 1, bubbles: true };
        canvas.dispatchEvent(new PointerEvent("pointerdown", init));
        canvas.dispatchEvent(new PointerEvent("pointerup", init));
        out.push(readout.textContent ?? "");
      }
    }
    return out;
  });
}

test("model mode draws the other plate object where it sits, and swaps with the open one", async ({ page }) => {
  await twoObjects(page);
  await openModel(page, "small");
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-context-count", "1");
  expect(await contextBoxes(page)).toEqual({ part: [-70, -5, 0, -30, 25, 20] });

  await openModel(page, "big");
  await expect(canvas).toHaveAttribute("data-context-count", "1");
  const [id] = Object.keys(await contextBoxes(page));
  expect(id).not.toBe("part");
  expect((await contextBoxes(page))[id!]).toEqual([70, 5, 0, 90, 25, 10]);
});

test("the grey object is not picked, framed, or counted in the bed and size readout", async ({ page }) => {
  await twoObjects(page);
  await openModel(page, "small");
  await expect(page.locator("#model")).toHaveAttribute("data-context-count", "1");
  const withContext = {
    picks: await clickGrid(page),
    origin: await page.locator("#model").getAttribute("data-bed-origin"),
    fit: await page.locator("#modelFit").textContent(),
    shot: await page.locator("#model").screenshot(),
  };

  await page.locator("#tabPrepare").click();
  await page.locator("[data-plate-remove]").first().click();
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await page.locator("#tabModel").click();
  await expect(page.locator("#model")).toHaveAttribute("data-context-count", "0");
  await expect(page.locator("#model")).not.toHaveAttribute("data-context", /.+/);
  const alone = {
    picks: await clickGrid(page),
    origin: await page.locator("#model").getAttribute("data-bed-origin"),
    fit: await page.locator("#modelFit").textContent(),
    shot: await page.locator("#model").screenshot(),
  };

  expect(withContext.picks.some((line) => line.startsWith("Face"))).toBe(true);
  expect(withContext.picks).toEqual(alone.picks);
  expect(withContext.origin).toBe(alone.origin);
  expect(withContext.fit).toBe(alone.fit);
  expect(withContext.shot.equals(alone.shot)).toBe(false);
});

test("the grey object follows the plate while Model stays open", async ({ page }) => {
  await twoObjects(page);
  await openModel(page, "small");
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-context", "part:-70.00,-5.00,0.00,-30.00,25.00,20.00");

  await commit(page, "#placeX", 170);
  await expect(canvas).toHaveAttribute("data-context", "part:-80.00,-5.00,0.00,-40.00,25.00,20.00");

  await page.locator("[data-plate-remove]").first().click();
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await expect(canvas).toHaveAttribute("data-context-count", "0");
});

test("a plate of one object has nothing to draw", async ({ page }) => {
  await twoObjects(page);
  await page.locator("#tabPrepare").click();
  await page.locator("[data-plate-remove]").nth(1).click();
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  await expect(page.locator("#model")).toHaveAttribute("data-context-count", "0");
});
