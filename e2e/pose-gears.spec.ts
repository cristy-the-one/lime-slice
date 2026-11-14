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

async function openProject(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }, parts: number, last: string): Promise<void> {
  await openOnPose(page, file, parts, last);
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
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
  await openProject(page, file, 6, ids.out);
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
  await openProject(page, { name: "pose-gears.lime", mimeType: "application/json", buffer: Buffer.from(saved.text) }, 6, ids.out);
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

/**
 * Stage 1 of docs/plan-gear-kinds.md, by hand: three gears a person made in Model and put at mesh, with no frame, no
 * hinge and no assembly. Couple gears on the pinion gives each gear a hinge about its own axis and makes the train; the
 * pinion's ring turns it (the pinion is the root and turns on the plate), the wheel's Angle field and the third gear's
 * ring do too, every gear stays on its pin, one Undo takes the whole Couple gears back, and after a save and reopen the
 * train turns again.
 */
type FreeIds = { pinion: string; wheel: string; third: string };
interface FreeDoc { objects: { id: string; modelPose?: Affine }[]; assemblies?: { name: string; couplings?: unknown[]; members: { object: string; parent: string | null; joint?: { kind: string; angle?: number } }[] }[] }

function expectFreeRatios(doc: FreeDoc, ids: FreeIds, label: string): number {
  const members = doc.assemblies?.[0]?.members ?? [];
  const angle = (id: string) => members.find((row) => row.object === id)?.joint?.angle ?? NaN;
  const p = angle(ids.pinion);
  expect(Math.abs(p), `${label}: the train turned`).toBeGreaterThan(5);
  expect(angle(ids.wheel), `${label}: wheel at -p/2 for pinion ${p}`).toBeCloseTo(-p / 2, 9);
  expect(angle(ids.third), `${label}: third at +2p/3`).toBeCloseTo((2 * p) / 3, 9);
  const pose = (id: string): Affine => doc.objects.find((row) => row.id === id)?.modelPose ?? { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  // Each gear turned about its own centre: its pin did not move, and its pose turned by its hinge's angle.
  for (const [id, x] of [[ids.pinion, 0], [ids.wheel, 36], [ids.third, 78]] as const) {
    const at = pose(id);
    expect(at.t[0], `${label}: ${id} on its pin`).toBeCloseTo(x, 6);
    expect(at.t[1], `${label}: ${id} on its pin`).toBeCloseTo(0, 6);
    expect(Math.atan2(at.m[3]!, at.m[0]!), `${label}: ${id} turned by its angle`).toBeCloseTo(Math.atan2(Math.sin((angle(id) * Math.PI) / 180), Math.cos((angle(id) * Math.PI) / 180)), 9);
  }
  return p;
}

async function openFree(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }, ids: FreeIds): Promise<void> {
  await openOnPose(page, file, 3, ids.third);
}

test("Three free gears at mesh, no hinges and no frame: Couple gears makes the train, and turning any gear by hand turns it", async ({ page }, info) => {
  test.setTimeout(120_000);
  const file = info.outputPath("pose-gears-free.lime");
  const printed = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "e2e/gear-train-project.ts", file, "--free"], { encoding: "utf8" });
  const ids = JSON.parse(printed.trim().split("\n").at(-1)!) as FreeIds;

  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await openFree(page, file, ids);
  const panel = page.locator("#posePanel");
  const gears = panel.locator("[data-pose-gears]");

  // A free gear offers Couple gears; nothing else was made by hand.
  await panel.locator(`[data-object='${ids.pinion}']`).click();
  await expect(panel.getByRole("heading", { name: "Gears" }), "a free gear offers coupling").toBeVisible();
  await panel.getByRole("button", { name: "Couple gears" }).click();
  await expect(gears).toContainText("Gave pinion, wheel and third a hinge about their axes.");
  await expect(gears).toContainText("They stand in a new assembly, Gear train. pinion turns on the plate.");
  await expect(gears).toContainText("pinion drives wheel, ×−0.5.");
  await expect(gears).toContainText("wheel drives third, ×−1.333.");
  await expect(gears, "nothing was refused and nothing is locked").not.toContainText("not coupled");
  await expect(gears).not.toContainText("locked");
  await expect(panel).toContainText("Assembly root (turns on the plate)");
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, "free-coupled.png") });

  // One Undo takes the whole Couple gears back: no assembly, no hinge.
  await panel.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Couple gears" })).toBeVisible();
  const undone = await downloadProject(page);
  expect(((undone.doc as unknown as FreeDoc).assemblies ?? []).length, "one Undo: no assembly left").toBe(0);
  await panel.getByRole("button", { name: "Couple gears" }).click();
  await expect(gears).toContainText("pinion drives wheel, ×−0.5.");

  // By hand: the pinion's ring. It is the root, and it turns on the plate.
  await dragRing(page);
  await expect.poll(async () => Math.abs(Number(await panel.getByLabel("Angle °").inputValue()))).toBeGreaterThan(5);
  expectFreeRatios((await downloadProject(page)).doc as unknown as FreeDoc, ids, "pinion ring");
  await page.screenshot({ path: path.join(shots, "free-ring-drag.png") });

  // The wheel's Angle field drives the root back to 0.
  await panel.locator(`[data-object='${ids.wheel}']`).click();
  await panel.getByLabel("Angle °").fill("0");
  await panel.getByLabel("Angle °").press("Tab");
  const zeroed = (await downloadProject(page)).doc as unknown as FreeDoc;
  expect(zeroed.assemblies![0]!.members.map((row) => row.joint?.angle ?? NaN).map((v) => Math.abs(v) < 1e-9), "the wheel to 0 brings the whole train to 0").toEqual([true, true, true]);

  // The third gear's ring, at the far end of the train.
  await panel.locator(`[data-object='${ids.third}']`).click();
  await dragRing(page);
  await expect.poll(async () => Math.abs(Number(await panel.getByLabel("Angle °").inputValue()))).toBeGreaterThan(5);
  const fromEnd = await downloadProject(page);
  expectFreeRatios(fromEnd.doc as unknown as FreeDoc, ids, "third ring");

  // Save and reopen: the hinges, the couplings and the turned root come from the file, and the train turns again.
  await page.reload();
  await autoSliceOff(page);
  await openFree(page, { name: "pose-gears-free.lime", mimeType: "application/json", buffer: Buffer.from(fromEnd.text) }, ids);
  await panel.locator(`[data-object='${ids.pinion}']`).click();
  await expect(gears, "reopened, the couplings are read from the file").toContainText("pinion drives wheel, ×−0.5.");
  await expect(panel).toContainText("Assembly root (turns on the plate)");
  await panel.getByLabel("Angle °").fill("0");
  await panel.getByLabel("Angle °").press("Tab");
  await dragRing(page);
  await expect.poll(async () => Math.abs(Number(await panel.getByLabel("Angle °").inputValue()))).toBeGreaterThan(5);
  expectFreeRatios((await downloadProject(page)).doc as unknown as FreeDoc, ids, "after reopening");
  await page.screenshot({ path: path.join(shots, "free-reopened-drag.png") });
});

/**
 * Stage 2 of docs/plan-gear-kinds.md, by hand: a planetary stage a person attached together and nothing more. The ring
 * (36, internal) is the root and the housing; the sun (12) and a carrier sit on it; three planets (12) sit on the
 * carrier. Couple gears gives the carrier, the sun and the planets their hinges and couples six meshes through the
 * carrier; a drag on the sun's ring turns the carrier a quarter as far and each planet -3/4 on it; the carrier's Angle
 * field drives the sun; and after a save and reopen the stage turns again.
 */
type PlanetIds = { ring: string; sun: string; carrier: string; planets: string[] };

function expectPlanetary(doc: FreeDoc, ids: PlanetIds, label: string): number {
  const members = doc.assemblies?.[0]?.members ?? [];
  const angle = (id: string) => members.find((row) => row.object === id)?.joint?.angle ?? NaN;
  const s = angle(ids.sun);
  expect(Math.abs(s), `${label}: the sun turned`).toBeGreaterThan(5);
  expect(angle(ids.carrier), `${label}: carrier at s/4 for sun ${s}`).toBeCloseTo(s / 4, 9);
  for (const planet of ids.planets) expect(angle(planet), `${label}: each planet at -3s/4 on the carrier`).toBeCloseTo((-3 * s) / 4, 9);
  expect(members.find((row) => row.object === ids.ring)?.joint, `${label}: the ring is the housing`).toBeUndefined();
  // The planets orbit with the carrier: planet 1 stands s/4 round, still 12 mm out.
  const t = doc.objects.find((row) => row.id === ids.planets[0])!.modelPose!.t;
  expect(Math.hypot(t[0], t[1])).toBeCloseTo(12, 6);
  expect((Math.atan2(t[1], t[0]) * 180) / Math.PI).toBeCloseTo(s / 4, 6);
  return s;
}

test("A planetary stage attached by hand: Couple gears hinges the carrier, sun and planets, and the sun turns the carrier a quarter as far", async ({ page }, info) => {
  test.setTimeout(120_000);
  const file = info.outputPath("pose-gears-planetary.lime");
  const printed = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "e2e/gear-train-project.ts", file, "--planetary"], { encoding: "utf8" });
  const ids = JSON.parse(printed.trim().split("\n").at(-1)!) as PlanetIds;

  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await openProject(page, file, 6, ids.planets[2]!);
  const panel = page.locator("#posePanel");
  const gears = panel.locator("[data-pose-gears]");

  await panel.locator(`[data-object='${ids.sun}']`).click();
  await panel.getByRole("button", { name: "Couple gears" }).click();
  await expect(gears).toContainText("Gave carrier, sun, planet 1, planet 2 and planet 3 a hinge about their axes.");
  await expect(gears).toContainText("sun drives planet 1 on carrier, ×−1.");
  await expect(gears).toContainText("planet 3 drives ring on carrier, ×0.333.");
  await expect(gears, "nothing refused, locked or out of mesh over a turn").not.toContainText(/not coupled|locked|do not mesh|more than one way/);
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, "planetary-coupled.png") });

  await dragRing(page);
  await expect.poll(async () => Math.abs(Number(await panel.getByLabel("Angle °").inputValue()))).toBeGreaterThan(5);
  expectPlanetary((await downloadProject(page)).doc as unknown as FreeDoc, ids, "sun ring");
  await page.screenshot({ path: path.join(shots, "planetary-drag.png") });

  // The carrier's Angle field: carrier 10 brings the sun to 40.
  await panel.locator(`[data-object='${ids.carrier}']`).click();
  await panel.getByLabel("Angle °").fill("10");
  await panel.getByLabel("Angle °").press("Tab");
  const typed = await downloadProject(page);
  expect(expectPlanetary(typed.doc as unknown as FreeDoc, ids, "carrier typed 10")).toBeCloseTo(40, 9);

  await page.reload();
  await autoSliceOff(page);
  await openProject(page, { name: "pose-gears-planetary.lime", mimeType: "application/json", buffer: Buffer.from(typed.text) }, 6, ids.planets[2]!);
  await panel.locator(`[data-object='${ids.sun}']`).click();
  await expect(gears, "reopened, the couplings are read from the file").toContainText("sun drives planet 1 on carrier, ×−1.");
  await panel.getByLabel("Angle °").fill("0");
  await panel.getByLabel("Angle °").press("Tab");
  await dragRing(page);
  await expect.poll(async () => Math.abs(Number(await panel.getByLabel("Angle °").inputValue()))).toBeGreaterThan(5);
  expectPlanetary((await downloadProject(page)).doc as unknown as FreeDoc, ids, "after reopening");
});
