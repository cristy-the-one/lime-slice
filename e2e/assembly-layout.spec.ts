import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type MockSolid } from "./model-tree-mock";

/**
 * Assemblies M9 (docs/plan-assemblies.md). Lay out on an assembly's header lays out only its parts for print, around
 * the other objects, and leaves their assembled poses alone; Undo puts them back. STEP saves one file of the assembly:
 * each part a named solid at its pose in model space. The engine is mocked for the STEP test.
 */

const shots = process.env.LIME_SHOTS ?? path.join("test-results", "assembly");

async function commit(page: Page, id: "#placeX" | "#placeY", value: number) {
  await page.locator(id).fill(String(value));
  await page.locator(id).press("Tab");
}

async function assembledBoxes(page: Page): Promise<string> {
  return (await page.locator("#prepare").getAttribute("data-assembled")) ?? "";
}

async function start(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("lime-slice-theme", "dark");
    localStorage.setItem("lime-slice-closed-groups", "[]");
  });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
}

test("Lay out lays out one assembly's parts for print, around the others, and keeps their assembled poses", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  await start(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
  await commit(page, "#placeX", 100);
  await commit(page, "#placeY", 100);
  await page.locator("#plateAddFile").setInputFiles("samples/overhang_ledge.stl");
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await commit(page, "#placeX", 100);
  await commit(page, "#placeY", 100);
  const ledge = (await page.locator("#prepare").getAttribute("data-plate-selected"))!;
  await page.locator("#plateAddFile").setInputFiles("samples/calibration_cube_20mm.stl");
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  const free = (await page.locator("#prepare").getAttribute("data-plate-selected"))!;
  await commit(page, "#placeX", 40);
  await commit(page, "#placeY", 40);

  await page.locator("[data-plate-select='part']").click();
  await page.locator(`[data-plate-attach='${ledge}']`).click();
  await expect(page.locator("[data-assembly-head]")).toContainText("2 parts");
  await expect(page.locator("#plateOverlap"), "the cube and the ledge share a spot of the bed").toBeVisible();
  await page.locator("[data-assembly-view='assembly']").click();
  const assembled = await assembledBoxes(page);
  await page.locator("[data-assembly-view='print']").click();
  await page.evaluate(() => document.querySelector("#toasts")?.replaceChildren());
  await page.screenshot({ path: path.join(shots, "layout-before.png") });

  await page.locator("[data-assembly-layout]").click();
  await expect(page.locator("#plateOverlap"), "laid out, the parts no longer share a spot").toHaveCount(0);
  await page.locator(`[data-plate-select='${free}']`).click();
  await expect(page.locator("#placeX"), "the object outside the assembly stays where it was").toHaveValue(/^40(\.0+)?$/);
  await expect(page.locator("#placeY")).toHaveValue(/^40(\.0+)?$/);
  await page.locator("[data-assembly-view='assembly']").click();
  expect(await assembledBoxes(page), "the assembled poses do not move").toBe(assembled);
  await page.locator("[data-assembly-view='print']").click();
  await page.evaluate(() => document.querySelector("#toasts")?.replaceChildren());
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, "layout-after.png") });

  // The first Undo takes back the selection, the second the lay out.
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#plateOverlap"), "Undo puts the parts back on their shared spot").toBeVisible();

  // These parts are meshes: a STEP assembly holds solids only, and says so.
  await page.locator("[data-assembly-step]").click();
  await expect(page.locator("#toasts")).toContainText("a STEP assembly holds solids only");
});

type V = [number, number, number];

function boxSolid(): MockSolid {
  const c = (x: number, y: number, z: number): V => [x * 10, y * 10, z * 10];
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
  return { volumeMm3: 1000, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 100 })), edges: [] };
}

test("STEP saves the assembly as named solids at their assembled poses", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  await start(page);
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid().positions } }));
  const tree = await mockModelTree(page, { open: () => boxSolid(), probe: () => ({ ok: true }) });
  await page.goto("/");
  await autoSliceOff(page);
  const step = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
  await page.locator("#file").setInputFiles({ name: "body.step", mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await page.locator("#plateAddFile").setInputFiles({ name: "hook.step", mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  const ids = await page.locator("#objectList [data-plate-select]").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.plateSelect!));
  await page.locator(`[data-plate-select='${ids[0]}']`).click();
  await page.locator(`[data-plate-attach='${ids[1]}']`).click();
  await expect(page.locator("[data-assembly-head]")).toContainText("2 parts");

  // The hook sits 0.5 mm higher than the body in the assembly.
  await page.locator(`[data-plate-select='${ids[1]}']`).click();
  await page.locator("[data-assembly-view='assembly']").click();
  await page.locator('#toolRail [data-tool="move"]').click();
  for (let i = 0; i < 5; i += 1) await page.getByRole("button", { name: "Nudge Z +0.1 mm" }).click();
  await page.locator("[data-assembly-view='print']").click();

  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("[data-assembly-step]").click()]);
  expect(download.suggestedFilename()).toBe("body.step");
  const asked = tree.of("export").at(-1) as { format?: string; pieces?: { key: string }[]; names?: string[]; poses?: { m: number[]; t: number[] }[] };
  expect(asked.format).toBe("step");
  expect(asked.names, "each solid is named after its part, the root first").toEqual(["body", "hook 2"]);
  expect(asked.pieces).toHaveLength(1);
  expect(asked.poses).toHaveLength(2);
  expect(asked.poses![1]!.t[2]! - asked.poses![0]!.t[2]!, "each solid goes at its assembled pose").toBeCloseTo(0.5, 3);
  await expect(page.locator("#toasts")).toContainText("Saved body.step: 2 parts at their assembled poses");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, "layout-step-saved.png") });
});
