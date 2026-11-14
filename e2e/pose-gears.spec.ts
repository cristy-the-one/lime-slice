import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import type { Affine } from "../src/model-space.ts";

/**
 * Gear coupling in Pose (docs/plan-gear-coupling.md), with no script and no agent in the loop: the project holds a
 * pinion (12), a wheel (24), a third gear (18) on from the wheel, and a compound stage, a small gear (12) seated on the
 * wheel's shaft driving "out" (24). Built by the MCP session on the fake engine (e2e/gear-train-project.ts). Couple gears
 * finds the meshes; a drag on the pinion's hinge ring turns every gear at its tooth ratio; the Angle field, Undo and a
 * turn from the far end do too; and after a save and reopen the train is still coupled and turns by hand again.
 */
interface Doc { objects: { id: string; modelPose?: Affine }[]; assemblies: { couplings?: { driver: string; driven: string; ratio: number }[]; members: { object: string; joint?: { angle?: number } }[] }[] }
type Ids = { frame: string; pinion: string; wheel: string; third: string; small: string; out: string };

const shots = process.env.LIME_SHOTS ?? path.join("test-results", "pose-gears");

async function downloadProject(page: Page): Promise<{ doc: Doc; text: string }> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const [file] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const text = fs.readFileSync((await file.path())!, "utf8");
  return { doc: JSON.parse(text) as Doc, text };
}

/** Every gear's hinge angle against the pinion's, at the tooth ratios: wheel -12/24, third (-12/24)(-24/18), out (-12/24)(-12/24). */
function expectRatios(doc: Doc, ids: Ids, label: string): number {
  const angle = (id: string) => doc.assemblies[0]!.members.find((row) => row.object === id)?.joint?.angle ?? NaN;
  const p = angle(ids.pinion);
  expect(Math.abs(p), `${label}: the pinion turned`).toBeGreaterThan(5);
  expect(angle(ids.wheel), `${label}: wheel at -p/2 for pinion ${p}`).toBeCloseTo(-p / 2, 9);
  expect(angle(ids.third), `${label}: third at +2p/3`).toBeCloseTo((2 * p) / 3, 9);
  expect(angle(ids.out), `${label}: out at +p/4, through the shared shaft`).toBeCloseTo(p / 4, 9);
  // The small gear has no hinge of its own: seated on the wheel, its pose turns with the wheel's.
  const pose = (id: string) => doc.objects.find((row) => row.id === id)!.modelPose!;
  const wheelTurn = Math.atan2(pose(ids.wheel).m[3]!, pose(ids.wheel).m[0]!), smallTurn = Math.atan2(pose(ids.small).m[3]!, pose(ids.small).m[0]!);
  expect(smallTurn, `${label}: the small gear turned with its shaft`).toBeCloseTo(wheelTurn, 9);
  expect(wheelTurn).toBeCloseTo((-p / 2) * (Math.PI / 180), 9);
  return p;
}

/** Drag the selected part's hinge ring a quarter turn in the top view, as a person does. */
async function dragRing(page: Page): Promise<void> {
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
}

async function openProject(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await page.locator("#projectFile").setInputFiles(file);
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  await page.locator("#tabPose").click();
  await expect(page.locator("#posePanel")).toBeVisible();
}

test("Couple a three-gear train with a compound stage; turning the pinion by hand turns every gear, before and after reopening", async ({ page }, info) => {
  test.setTimeout(120_000);
  const file = info.outputPath("pose-gears.lime");
  const printed = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "e2e/gear-train-project.ts", file], { encoding: "utf8" });
  const ids = JSON.parse(printed.trim().split("\n").at(-1)!) as Ids;

  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await openProject(page, file);
  const panel = page.locator("#posePanel");
  const gears = panel.locator("[data-pose-gears]");

  await panel.locator(`[data-object='${ids.pinion}']`).click();
  await expect(panel.getByRole("heading", { name: "Gears" }), "an assembly with gears offers coupling").toBeVisible();
  await panel.getByRole("button", { name: "Couple gears" }).click();
  await expect(gears).toContainText("pinion drives wheel, ×−0.5.");
  await expect(gears).toContainText("wheel drives third, ×−1.333.");
  await expect(gears).toContainText("small drives out, ×−0.5.");
  await expect(gears, "nothing was refused and nothing is locked").not.toContainText("not coupled");

  // By hand: the pinion's ring.
  await dragRing(page);
  await expect.poll(async () => Math.abs(Number(await panel.getByLabel("Angle °").inputValue()))).toBeGreaterThan(5);
  const first = await downloadProject(page);
  expect(first.doc.assemblies[0]!.couplings?.length, "three meshes, saved with the assembly").toBe(3);
  const dragged = expectRatios(first.doc, ids, "ring drag");
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, "ring-drag.png") });

  // The Angle field, from the far end of the train: the third gear to 20 brings the pinion to 30.
  await panel.locator(`[data-object='${ids.third}']`).click();
  await panel.getByLabel("Angle °").fill("20");
  await panel.getByLabel("Angle °").press("Tab");
  const typed = await downloadProject(page);
  expect(expectRatios(typed.doc, ids, "third typed 20")).toBeCloseTo(30, 9);
  // One Undo takes the whole train back to where the drag left it. A selection is a step of its own, so the third
  // gear stays selected.
  await panel.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(panel.getByLabel("Angle °")).toHaveValue(String(Math.round(((2 * dragged) / 3) * 10000) / 10000));
  expect(expectRatios((await downloadProject(page)).doc, ids, "undone")).toBeCloseTo(dragged, 9);

  // Save and reopen: the train is still coupled, from the file alone, and turns by hand again.
  const saved = await downloadProject(page);
  await page.reload();
  await autoSliceOff(page);
  await openProject(page, { name: "pose-gears.lime", mimeType: "application/json", buffer: Buffer.from(saved.text) });
  await panel.locator(`[data-object='${ids.pinion}']`).click();
  await expect(gears, "reopened, the couplings are read from the file").toContainText("pinion drives wheel, ×−0.5.");
  await expect(gears).toContainText("small drives out, ×−0.5.");
  await panel.getByLabel("Angle °").fill("0");
  await panel.getByLabel("Angle °").press("Tab");
  await dragRing(page);
  await expect.poll(async () => Math.abs(Number(await panel.getByLabel("Angle °").inputValue()))).toBeGreaterThan(5);
  expectRatios((await downloadProject(page)).doc, ids, "after reopening");
  await page.screenshot({ path: path.join(shots, "reopened-drag.png") });

  await panel.getByRole("button", { name: "Uncouple" }).click();
  await expect(gears).not.toContainText("drives");
});
