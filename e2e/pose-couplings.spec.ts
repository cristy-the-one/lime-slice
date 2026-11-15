import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import type { Affine } from "../src/model-space.ts";

/**
 * Declared couplings in Pose (docs/plan-coupling-kinds.md), with no script and no agent in the loop. The project holds
 * parts on hinges and a slide and nothing coupled (e2e/gear-train-project.ts --couplings). In the Couplings section a
 * person couples the centre arbor to a wheel at a ratio and to a hand through a clutch, a drum to a weight (a winch) and
 * a ratchet wheel to the frame with its click; then turns each by hand (the hinge ring, or the Angle field) and the file
 * shows every joint where the coupling says. Removing one and Undo, and a save and reopen, keep what was coupled.
 */
interface Click { phase: number; zero: number }
interface Doc {
  objects: { id: string; modelPose?: Affine }[];
  assemblies: { couplings?: { kind?: string; driver: string; driven: string; ratio: number; click?: Click }[]; members: { object: string; joint?: { kind: string; angle?: number; travel?: number } }[] }[];
}
type Ids = { frame: string; centre: string; wheel: string; hand: string; drum: string; weight: string; cord: string; ratchet: string; click: string };

const shots = process.env.LIME_SHOTS ?? path.join("test-results", "couplings");

async function downloadProject(page: Page): Promise<Doc> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const [file] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  return JSON.parse(fs.readFileSync((await file.path())!, "utf8")) as Doc;
}
const jointAt = (doc: Doc, id: string) => {
  const joint = doc.assemblies[0]!.members.find((row) => row.object === id)?.joint;
  return joint?.kind === "slide" ? joint.travel ?? 0 : joint?.angle ?? 0;
};

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
  await page.locator("[data-pose-tool='select']").click();
}

/**
 * Open a project and show Pose. Opening a project switches the app to Prepare when its load finishes, so a click on Pose
 * made before then is undone: wait until the plate holds the project's `parts`, then click Pose until the Pose panel
 * lists `last` (a click that a late load undid is made again).
 */
async function openOnPose(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }, parts: number, last: string): Promise<void> {
  await page.locator("#projectFile").setInputFiles(file);
  await expect(page.locator("[data-plate-select]")).toHaveCount(parts, { timeout: 30_000 });
  await expect(async () => {
    if ((await page.locator("#tabPose").getAttribute("aria-selected")) !== "true") await page.locator("#tabPose").click();
    await expect(page.locator(`#posePanel [data-object='${last}']`)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

test("Couple a ratio, a clutch, a winch and a ratchet with its click in Pose, and turn each by hand", async ({ page }, info) => {
  test.setTimeout(180_000);
  const file = info.outputPath("pose-couplings.lime");
  const printed = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "e2e/gear-train-project.ts", file, "--couplings"], { encoding: "utf8" });
  const ids = JSON.parse(printed.trim().split("\n").at(-1)!) as Ids;
  fs.mkdirSync(shots, { recursive: true });

  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await openOnPose(page, file, 9, ids.click);
  const panel = page.locator("#posePanel");
  const couplings = panel.locator("[data-pose-couplings]");
  const note = panel.locator("[data-pose-couple-note]");
  const couple = async (other: string, kind: string, fields: Record<string, string> = {}, choices: Record<string, string> = {}) => {
    await couplings.getByLabel("Other part").selectOption({ label: other });
    await couplings.getByLabel("Kind", { exact: true }).selectOption(kind);
    for (const [label, value] of Object.entries(choices)) await couplings.getByLabel(label, { exact: true }).selectOption({ label: value });
    for (const [label, value] of Object.entries(fields)) await couplings.getByLabel(label, { exact: true }).fill(value);
    await couplings.getByRole("button", { name: "Couple", exact: true }).click();
  };

  // Stage 1 and stage 4: the centre arbor drives the wheel at 3, and the hand through a clutch.
  await panel.locator(`[data-object='${ids.centre}']`).click();
  await expect(panel.getByRole("heading", { name: "Couplings" })).toBeVisible();
  await couple("Wheel", "ratio", { Ratio: "3" });
  await expect(note).toHaveText("Coupled: Centre drives Wheel, ×3.");
  await couple("Hand", "clutch");
  await expect(couplings).toContainText("Centre drives Hand through a clutch, ×1. No torque is computed: it slips only when Hand is held, stuck or turned by itself.");
  await page.screenshot({ path: path.join(shots, "couplings-form.png") });
  await dragRing(page);
  await expect.poll(async () => Math.abs(Number(await panel.getByLabel("Angle °").inputValue()))).toBeGreaterThan(5);
  let doc = await downloadProject(page);
  const c = jointAt(doc, ids.centre);
  expect(jointAt(doc, ids.wheel), "the wheel at 3 times the centre").toBeCloseTo(3 * c, 9);
  expect(jointAt(doc, ids.hand), "the hand carried by the clutch").toBeCloseTo(c, 9);
  await page.screenshot({ path: path.join(shots, "ratio-clutch-drag.png") });

  // Setting the hand by its Angle field: the clutch slips, the centre and the wheel stay.
  await panel.locator(`[data-object='${ids.hand}']`).click();
  await panel.getByLabel("Angle °").fill("100");
  await panel.getByLabel("Angle °").press("Tab");
  await expect(panel).toContainText("Centre stays: the clutch slips when Hand is turned on its own.");
  doc = await downloadProject(page);
  expect(jointAt(doc, ids.hand)).toBeCloseTo(100, 9);
  expect(jointAt(doc, ids.centre), "the train did not move").toBeCloseTo(c, 9);
  expect(jointAt(doc, ids.wheel)).toBeCloseTo(3 * c, 9);
  await page.screenshot({ path: path.join(shots, "clutch-slips.png") });

  // Stage 2: the drum winds the weight; its ring draws the weight 2 pi r / 360 mm a degree, the cord with it.
  await panel.locator(`[data-object='${ids.drum}']`).click();
  await couple("Weight", "winch", { "Drum radius mm": "12" });
  await expect(note).toHaveText("Coupled: Drum winds in Weight as it turns forward: 12 mm drum, 0.209 mm a degree.");
  await dragRing(page);
  await expect.poll(async () => Math.abs(Number(await panel.getByLabel("Angle °").inputValue()))).toBeGreaterThan(5);
  doc = await downloadProject(page);
  const d = jointAt(doc, ids.drum);
  expect(jointAt(doc, ids.weight), "the weight follows the drum").toBeCloseTo((d * 2 * Math.PI * 12) / 360, 9);
  const y = (id: string) => doc.objects.find((row) => row.id === id)!.modelPose!.t[1];
  expect(y(ids.cord) - y(ids.weight), "the cord rides on the weight").toBeCloseTo(25, 6);
  await page.screenshot({ path: path.join(shots, "winch-drag.png") });

  // Stage 3: the ratchet on the frame, its click on the frame: forward only, the click lifting over each tooth.
  await panel.locator(`[data-object='${ids.ratchet}']`).click();
  await couple("Frame", "ratchet", { Teeth: "20", "Tip radius mm": "12", "Root radius mm": "10.2" }, { "Runs free turning": "forward", Click: "Click" });
  await expect(note).toContainText("Coupled: Ratchet turns forward only under Click (20 teeth, lift 9.");
  await panel.getByLabel("Angle °").fill("9");
  await panel.getByLabel("Angle °").press("Tab");
  doc = await downloadProject(page);
  const ratchet = () => doc.assemblies[0]!.couplings!.find((row) => row.kind === "ratchet")!;
  expect(ratchet().click!.phase).toBeCloseTo(9, 9);
  expect(Math.abs(jointAt(doc, ids.click)), "half a pitch on, the click stands lifted").toBeGreaterThan(1);
  await page.screenshot({ path: path.join(shots, "ratchet-click-lifted.png") });
  await panel.getByLabel("Angle °").fill("30");
  await panel.getByLabel("Angle °").press("Tab");
  await panel.getByLabel("Angle °").fill("-5");
  await panel.getByLabel("Angle °").press("Tab");
  await expect(panel).toContainText("Stopped: Ratchet turns only forward: its click on Frame holds it the other way.");
  doc = await downloadProject(page);
  expect(jointAt(doc, ids.ratchet), "turned back, it rode its click down to the seat at 18 and stopped").toBeCloseTo(18, 9);
  expect(jointAt(doc, ids.click)).toBeCloseTo(0, 9);
  await page.screenshot({ path: path.join(shots, "ratchet-stopped.png") });
  // By its ring: a quarter turn either way. Forward it runs free; back it is held where it stands.
  await dragRing(page);
  doc = await downloadProject(page);
  expect(jointAt(doc, ids.ratchet), "the ring never turns it back past its click").toBeGreaterThanOrEqual(18 - 1e-9);

  // Remove the clutch, then Undo brings it back.
  await panel.locator(`[data-object='${ids.centre}']`).click();
  await couplings.getByRole("button", { name: "Remove: Centre and Hand" }).click();
  const clutchLine = couplings.locator(".pose-coupling", { hasText: "through a clutch" });
  await expect(clutchLine).toHaveCount(0);
  await expect(panel.locator("[data-pose-couple-note]")).toContainText("Removed: Centre drives Hand through a clutch");
  await panel.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(clutchLine).toHaveCount(1);

  // Save and reopen: the four couplings come from the file, and the train turns again by hand.
  const text = JSON.stringify(await downloadProject(page));
  await page.reload();
  await autoSliceOff(page);
  await openOnPose(page, { name: "pose-couplings.lime", mimeType: "application/json", buffer: Buffer.from(text) }, 9, ids.click);
  await panel.locator(`[data-object='${ids.centre}']`).click();
  await expect(couplings.locator(".pose-coupling")).toHaveCount(4);
  await panel.getByLabel("Angle °").fill("12");
  await panel.getByLabel("Angle °").press("Tab");
  doc = await downloadProject(page);
  expect(jointAt(doc, ids.wheel)).toBeCloseTo(36, 9);
  expect(jointAt(doc, ids.hand), "the clutch carries the hand on from where it was set").toBeCloseTo(100 + 12 - c, 9);
  await page.screenshot({ path: path.join(shots, "reopened.png") });
});
