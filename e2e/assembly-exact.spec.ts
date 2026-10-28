import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid } from "./model-tree-mock";

/**
 * Assemblies M7 (docs/plan-assemblies.md, section 6, D5 and D11). Two solids assembled on one spot share volume by the mesh;
 * Measure asks the kernel for their common volume and the row says it. A common volume under 0.01 mm³ is a touch: the
 * row and the tint go. The engine is mocked: its dry run of a join `common` answers the volume the test sets.
 */

const shots = process.env.LIME_SHOTS ?? path.join("test-results", "assembly");

type V = [number, number, number];

function boxSolid(volumeMm3: number): MockSolid {
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
  return { volumeMm3, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 100 })), edges: [] };
}

test("Measure gives a crossing pair its common volume, and a sliver reads as a touch", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  let common = 14.2;
  await page.addInitScript(() => {
    localStorage.setItem("lime-slice-theme", "dark");
    localStorage.setItem("lime-slice-closed-groups", "[]");
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid(1000).positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => boxSolid(1000),
    probe: () => ({ ok: true }),
    preview: (request: Body) => {
      const op = request.op as { kind?: string; op?: string } | undefined;
      return op?.kind === "join" && op.op === "common" ? boxSolid(common) : null;
    },
  });
  await page.goto("/");
  await autoSliceOff(page);
  const step = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
  await page.locator("#file").setInputFiles({ name: "body.step", mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await page.locator("#plateAddFile").setInputFiles({ name: "pin.step", mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(2);

  const ids = await page.locator("#objectList [data-plate-select]").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.plateSelect!));
  await page.locator(`[data-plate-select='${ids[0]}']`).click();
  await page.locator(`[data-plate-attach='${ids[1]}']`).click();
  await page.locator("[data-assembly-view='assembly']").click();
  const row = page.locator("#assemblyInterference");
  await expect(row, "two solids on one spot share volume by the mesh").toContainText("one sits inside the other");
  await expect(page.locator("#prepare")).toHaveAttribute("data-clashing", [...ids].sort().join(" "));

  await row.locator("[data-assembly-measure]").click();
  await expect(row).toContainText("14.2 mm³");
  await expect(row.locator("[data-assembly-measure]"), "a measured pair needs no second Measure").toHaveCount(0);
  const asked = tree.of("probe").map((call) => call.op as { kind?: string; op?: string; keepTool?: boolean });
  expect(asked.some((op) => op.kind === "join" && op.op === "common" && op.keepTool === true), "the kernel was asked for a join common, nothing applied").toBe(true);
  expect(tree.of("apply"), "Measure applies nothing").toHaveLength(0);
  await page.evaluate(() => document.querySelector("#toasts")?.replaceChildren());
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, "assembly-measured.png") });

  // Moved by 0.1 mm the pair is measured afresh; the kernel now finds a sliver, so it is a touch.
  common = 0.004;
  await page.locator(`[data-plate-select='${ids[1]}']`).click();
  await page.locator('#toolRail [data-tool="move"]').click();
  await page.getByRole("button", { name: "Nudge X +0.1 mm" }).click();
  await expect(row.locator("[data-assembly-measure]")).toBeVisible();
  await row.locator("[data-assembly-measure]").click();
  await expect(row, "a sliver under 0.01 mm³ is a touch").toHaveCount(0);
  await expect(page.locator("#prepare")).toHaveAttribute("data-clashing", "");
});
