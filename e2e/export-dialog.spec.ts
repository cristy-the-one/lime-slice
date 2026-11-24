/**
 * One Export dialog (docs/plan-export-and-linking.md X1).
 * Two free parts export as STL each, OBJ and STEP. An assembly is the default scope.
 * File → Export… with nothing selected offers Plate, assembled. The palette finds Export…,
 * Ctrl+Shift+E opens it, and Pose's Export… opens it on the assembly.
 */
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";
import { autoSliceOff } from "./auto-slice";
import { linkInPose } from "./link-in-pose";

const shots = path.join("docs", "screenshots", "x1-export");
const FAKE_STEP = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";

test("one Export dialog covers scope, format, the old entries and the key", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/model/tree", async (route) => {
    const req = route.request().postDataJSON() as Record<string, unknown>;
    if (req.call === "export") {
      const b64 = Buffer.from(FAKE_STEP, "utf8").toString("base64");
      await route.fulfill({ json: { ok: true, bytesBase64: b64, byteLength: FAKE_STEP.length, solids: 2 } });
      return;
    }
    if (req.call === "open") {
      await route.fulfill({
        json: {
          ok: true,
          id: 0,
          editable: true,
          positions: [0, 0, 0, 10, 0, 0, 0, 10, 0],
          triangles: [0],
          faces: [],
          edges: [],
          bounds: { min: [0, 0, 0], max: [10, 10, 10] },
          volumeMm3: 1000,
          openEdges: 0,
          nonManifoldEdges: 0,
        },
      });
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);

  await page.locator("#fileMenu > summary").click();
  const empty = page.locator("#exportModel");
  await expect(empty).toBeVisible();
  await expect(empty).toHaveAttribute("aria-disabled", "true");
  await expect(empty).toHaveAttribute("data-tip", "The plate is empty.");
  await empty.hover();
  await expect(page.locator(".lime-tip")).toHaveAttribute("data-open", "true");
  await expect(page.locator(".lime-tip")).toContainText("The plate is empty.");
  await page.screenshot({ path: path.join(shots, "disabled-empty.png") });
  await page.locator("#fileMenu > summary").click();

  await page.locator("#file").setInputFiles("samples/calibration_cube_20mm.stl");
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
  await page.locator("#plateAddFile").setInputFiles("samples/overhang_ledge.stl");
  await expect(page.locator("#objectList .obj")).toHaveCount(2);

  const openExport = async () => {
    await page.keyboard.press("Control+Shift+E");
    const dlg = page.locator("[data-export-dialog]");
    await expect(dlg).toBeVisible();
    return dlg;
  };

  const dlg = await openExport();
  await expect(dlg.locator("[data-export='scope']")).toHaveValue("part");
  expect(await dlg.locator("[data-export='scope'] option[value='assembly']").getAttribute("disabled")).not.toBeNull();
  await page.screenshot({ path: path.join(shots, "scope-part.png") });
  await dlg.locator("[data-export='scope']").selectOption("plate-assembled");
  await page.screenshot({ path: path.join(shots, "scope-plate-assembled.png") });
  await dlg.locator("[data-export='scope']").selectOption("plate-print");
  await expect(dlg.locator("[data-pose-export='format']")).toHaveValue("3mf");
  await page.screenshot({ path: path.join(shots, "scope-plate-print.png") });

  await dlg.locator("[data-export='scope']").selectOption("plate-assembled");
  await dlg.locator("[data-pose-export='format']").selectOption("stl");
  await dlg.locator("[data-pose-export='stl']").selectOption("each");
  const [zip] = await Promise.all([
    page.waitForEvent("download"),
    dlg.locator("[data-pose-export-action='submit']").click(),
  ]);
  expect(zip.suggestedFilename().endsWith(".zip")).toBe(true);
  const packed = unzipSync(new Uint8Array(readFileSync((await zip.path())!)));
  expect(Object.keys(packed)).toHaveLength(2);
  for (const name of Object.keys(packed)) expect(name.endsWith(".stl")).toBe(true);

  const again = await openExport();
  await again.locator("[data-export='scope']").selectOption("plate-assembled");
  await again.locator("[data-pose-export='format']").selectOption("obj");
  const objFiles: string[] = [];
  const onDownload = (download: { suggestedFilename(): string }) => objFiles.push(download.suggestedFilename());
  page.on("download", onDownload);
  await again.locator("[data-pose-export-action='submit']").click();
  await expect.poll(() => objFiles.length).toBe(2);
  page.off("download", onDownload);
  expect(objFiles.some((name) => name.endsWith(".obj"))).toBe(true);
  expect(objFiles.some((name) => name.endsWith(".mtl"))).toBe(true);

  const [saved] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const doc = JSON.parse(readFileSync((await saved.path())!, "utf8"));
  for (const obj of doc.objects) {
    obj.modelTree = {
      rootPrimitive: { primitive: "box", origin: [0, 0, 0], size: [20, 20, 20], radius: 10, height: 20, turn: [0, 0, 0] },
      nodes: [{ id: 0, parent: null, op: null, fingerprint: null }],
      current: 0,
      committed: 0,
      nextId: 1,
    };
  }
  await page.reload();
  await page.locator("#projectFile").setInputFiles({
    name: "two.lime",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  const stepDialog = await openExport();
  await stepDialog.locator("[data-export='scope']").selectOption("plate-assembled");
  await stepDialog.locator("[data-pose-export='format']").selectOption("step");
  const [step] = await Promise.all([
    page.waitForEvent("download"),
    stepDialog.locator("[data-pose-export-action='submit']").click(),
  ]);
  expect(step.suggestedFilename().endsWith(".step")).toBe(true);
  expect(readFileSync((await step.path())!, "utf8")).toContain("AP242");

  const ids = await page.locator("#objectList [data-plate-select]").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.plateSelect!));
  await page.locator(`[data-plate-select='${ids[0]}']`).click();
  await linkInPose(page, ids[1]!, ids[0]!);
  await expect(page.locator("[data-assembly-head]")).toBeVisible();
  await page.locator(`[data-plate-select='${ids[1]}']`).click();
  const onAssembly = await openExport();
  await expect(onAssembly.locator("[data-export='scope']")).toHaveValue("assembly");
  await page.screenshot({ path: path.join(shots, "scope-assembly.png") });
  await onAssembly.locator("[data-pose-export-action='cancel']").click();

  await page.locator("#objectList").evaluate((el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.locator("#fileMenu > summary").click();
  await page.locator("#exportModel").click();
  const plate = page.locator("[data-export-dialog]");
  await expect(plate).toBeVisible();
  await expect(plate.locator("[data-export='scope']")).toHaveValue("plate-assembled");
  await plate.locator("[data-pose-export-action='cancel']").click();

  await page.keyboard.press("Control+k");
  await page.locator("#paletteInput").fill("Export");
  await expect(page.locator("#paletteList [data-id='export-model']")).toContainText("Export…");
  await page.keyboard.press("Escape");

  await page.locator("#tabPose").click();
  await expect(page.locator("[data-pose-action='pose-export']").first()).toBeVisible();
  await page.locator("[data-pose-action='pose-export']").first().click();
  const pose = page.locator("[data-export-dialog]");
  await expect(pose).toBeVisible();
  await expect(pose.locator("[data-export='scope']")).toHaveValue("assembly");
  await expect(pose.locator("[data-pose-export='format']")).toHaveValue("step");
  await pose.locator("[data-pose-export-action='cancel']").click();
});
