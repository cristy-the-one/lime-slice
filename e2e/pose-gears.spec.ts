import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import type { Affine } from "../src/model-space.ts";

/**
 * Gear coupling in Pose (docs/plan-gear-coupling.md): a pinion and a wheel at their centre distance, each on a hinge,
 * built by the MCP session on the fake engine (e2e/gear-train-project.ts). Couple gears finds the pair, the pinion's
 * Angle turns the wheel by -z1/z2, Undo takes the turn back, and the saved project keeps the coupling and the pose.
 */
interface Doc { objects: { id: string; modelPose?: Affine }[]; assemblies: { couplings?: { driver: string; driven: string; ratio: number }[]; members: { object: string; joint?: { angle?: number } }[] }[] }

const shots = process.env.LIME_SHOTS ?? path.join("test-results", "pose-gears");

async function downloadProject(page: Page): Promise<Doc> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const [file] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  return JSON.parse(fs.readFileSync((await file.path())!, "utf8"));
}

test("Couple gears, then turning the pinion turns the wheel at the tooth ratio", async ({ page }, info) => {
  const file = info.outputPath("pose-gears.lime");
  const printed = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "e2e/gear-train-project.ts", file], { encoding: "utf8" });
  const ids = JSON.parse(printed.trim().split("\n").at(-1)!) as { frame: string; pinion: string; wheel: string };

  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#projectFile").setInputFiles(file);
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  await page.locator("#tabPose").click();
  const panel = page.locator("#posePanel");
  await expect(panel).toBeVisible();

  await panel.locator(`[data-object='${ids.pinion}']`).click();
  await expect(panel.getByRole("heading", { name: "Gears" }), "an assembly with two gears offers coupling").toBeVisible();
  await panel.getByRole("button", { name: "Couple gears" }).click();
  await expect(panel.locator("[data-pose-gears]")).toContainText("pinion drives wheel, ×−0.5.");

  await panel.getByLabel("Angle °").fill("30");
  await panel.getByLabel("Angle °").press("Tab");
  await panel.locator(`[data-object='${ids.wheel}']`).click();
  await expect(panel.getByLabel("Angle °"), "the wheel followed the pinion at -12/24").toHaveValue("-15");
  await page.screenshot({ path: path.join(shots, "pinion-30.png") });

  const doc = await downloadProject(page);
  const assembly = doc.assemblies[0]!;
  expect(assembly.couplings?.map((row) => [row.driver, row.driven, row.ratio])).toEqual([[ids.pinion, ids.wheel, -0.5]]);
  expect(assembly.members.find((row) => row.object === ids.wheel)?.joint?.angle).toBeCloseTo(-15, 9);
  const wheelPose = doc.objects.find((row) => row.id === ids.wheel)!.modelPose!;
  expect(wheelPose.m[0], "the wheel's saved pose is turned -15° about Z").toBeCloseTo(Math.cos((-15 * Math.PI) / 180), 9);
  expect(wheelPose.m[3]).toBeCloseTo(Math.sin((-15 * Math.PI) / 180), 9);
  expect(wheelPose.t.slice(0, 2), "about its own axis, so its centre stays").toEqual([36, 0]);

  // Turning the wheel drives the pinion back; Undo takes that turn back for both. A selection is a step of its own in
  // the app's history, so the wheel stays selected and the pinion is read from the saved file.
  await panel.getByLabel("Angle °").fill("0");
  await panel.getByLabel("Angle °").press("Tab");
  const back = await downloadProject(page);
  expect(back.assemblies[0]!.members.find((row) => row.object === ids.pinion)?.joint?.angle, "the wheel back at 0 brings the pinion to 0").toBeCloseTo(0, 9);
  await panel.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(panel.getByLabel("Angle °")).toHaveValue("-15");
  const undone = await downloadProject(page);
  expect(undone.assemblies[0]!.members.find((row) => row.object === ids.pinion)?.joint?.angle, "one Undo restores the pinion too").toBeCloseTo(30, 9);

  // The hinge ring: a drag on the pinion turns the wheel with it, at the same ratio, whatever angle the drag ends on.
  await panel.locator(`[data-object='${ids.pinion}']`).click();
  await page.locator("[data-pose-tool='turn']").click();
  await page.locator("[data-pose-view='top']").click();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const canvas = page.locator("#pose");
  await expect(canvas).toHaveAttribute("data-turn-handles", /0:/);
  const xy = (raw: string | null) => (raw ?? "").split(",").map(Number) as [number, number];
  const handle = xy((await canvas.getAttribute("data-turn-handles"))!.split(":")[1] ?? "");
  const centre = xy(await canvas.getAttribute("data-turn-center"));
  await page.mouse.move(...handle);
  await page.mouse.down();
  await page.mouse.move(centre[0] - (handle[1] - centre[1]), centre[1] + (handle[0] - centre[0]), { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs(Number(await panel.getByLabel("Angle °").inputValue()) - 30)).toBeGreaterThan(5);
  const dragged = await downloadProject(page);
  const angle = (id: string) => dragged.assemblies[0]!.members.find((row) => row.object === id)?.joint?.angle ?? NaN;
  expect(angle(ids.wheel), `the ring turned the pinion to ${angle(ids.pinion)}`).toBeCloseTo(-angle(ids.pinion) / 2, 9);
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, "ring-drag.png") });

  await panel.getByRole("button", { name: "Uncouple" }).click();
  await expect(panel.locator("[data-pose-gears]")).not.toContainText("drives");
});
