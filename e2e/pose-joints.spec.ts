import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { memberPose, type Member } from "../src/assembly.ts";
import { applyPose, type Affine } from "../src/model-space.ts";

interface TestObject { id: string; name: string; modelPose?: Affine; placement: unknown; [key: string]: unknown }
interface TestDocument { objects: TestObject[]; assemblies: { members: Member[] }[]; [key: string]: unknown }

const shots = process.env.LIME_SHOTS ?? path.join("test-results", "pose-joints");
async function downloadProject(page: Page): Promise<TestDocument> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const [file] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  return JSON.parse(fs.readFileSync((await file.path())!, "utf8"));
}
async function setup(page: Page): Promise<{ knee: string; tip: string }> {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
  await page.locator("#plateAddFile").setInputFiles("samples/overhang_ledge.stl");
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  const knee = (await page.locator("#prepare").getAttribute("data-plate-selected"))!;
  await page.locator("[data-plate-select='part']").click();
  await page.locator(`[data-plate-attach='${knee}']`).click();
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  const doc = await downloadProject(page);
  const source = doc.objects.find((row) => row.id === knee)!;
  const tip = "pose-tip";
  const identity: Affine["m"] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  source.modelPose = { m: identity, t: [70, 0, 0] };
  doc.objects.push({ ...structuredClone(source), id: tip, name: "tip.stl", modelPose: { m: identity, t: [140, 0, 0] } });
  doc.assemblies[0]!.members = [
    { object: "part", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
    { object: knee, parent: "part", offset: [70, 0, 0], turn: [0, 0, 0] },
    { object: tip, parent: "part", offset: [140, 0, 0], turn: [0, 0, 0] },
  ];
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "joints.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  await page.locator("#tabPose").click();
  return { knee, tip };
}

function numbers(raw: string | null): [number, number] { const row = (raw ?? "").split(",").map(Number); return [row[0]!, row[1]!]; }

test("Link, type a hinge, turn its ring, undo and save the assembled pose", async ({ page }) => {
  const { knee, tip } = await setup(page);
  const panel = page.locator("#posePanel");
  await expect(panel).toBeVisible();
  await page.locator("[data-pose-tool='link']").click();
  await panel.locator(`[data-object='${knee}']`).click();
  await panel.locator(`[data-object='${tip}']`).click();
  await expect(panel).toContainText("Parent: overhang_ledge");
  await panel.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(panel).toContainText("Parent: calibration_cube");
  await panel.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(panel).toContainText("Parent: overhang_ledge");
  await panel.locator(`[data-object='${tip}']`).click();
  await panel.locator(`[data-object='${knee}']`).click();
  await expect(panel).toContainText("loop");
  await page.locator("[data-pose-tool='joint']").click();
  await panel.locator(`[data-object='${knee}']`).click();
  await panel.getByLabel("Joint kind").selectOption("hinge");
  await panel.getByLabel("Pivot X mm").fill("1");
  await panel.getByLabel("Pivot X mm").press("Tab");
  await panel.getByLabel("Minimum °").fill("-20");
  await panel.getByLabel("Minimum °").press("Tab");
  await panel.getByLabel("Maximum °").fill("40");
  await panel.getByLabel("Maximum °").press("Tab");
  const before = await downloadProject(page);
  const oldKnee = before.assemblies[0]!.members.find((row) => row.object === knee)!;
  const oldTip = before.objects.find((row) => row.id === tip)!.modelPose!;
  const oldPivot = applyPose(memberPose(oldKnee), oldKnee.joint!.pivot);
  const printBefore = before.objects.map((row) => row.placement);
  await page.locator("[data-pose-tool='turn']").click();
  await page.locator("[data-pose-view='top']").click();
  const canvas = page.locator("#pose");
  await expect(canvas).toHaveAttribute("data-turn-handles", /0:/);
  const handle = numbers((await canvas.getAttribute("data-turn-handles"))!.split(":")[1] ?? "");
  const centre = numbers(await canvas.getAttribute("data-turn-center"));
  const x = handle[0] - centre[0], y = handle[1] - centre[1];
  await page.mouse.move(...handle);
  await page.mouse.down();
  await page.mouse.move(centre[0] - y, centre[1] + x, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs(Number(await panel.getByLabel("Angle °").inputValue()))).toBeGreaterThan(5);
  const angle = Number(await panel.getByLabel("Angle °").inputValue());
  expect(angle).toBeGreaterThanOrEqual(-20.001);
  expect(angle).toBeLessThanOrEqual(40.001);
  const after = await downloadProject(page);
  const newKnee = after.assemblies[0]!.members.find((row) => row.object === knee)!;
  const newTip = after.objects.find((row) => row.id === tip)!.modelPose!;
  const newPivot = applyPose(memberPose(newKnee), newKnee.joint!.pivot);
  newPivot.forEach((v, i) => expect(v).toBeCloseTo(oldPivot[i]!, 6));
  expect(newTip.t).not.toEqual(oldTip.t);
  expect(after.objects.map((row) => row.placement)).toEqual(printBefore);
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, "turn-joint.png") });
  await panel.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(panel.getByLabel("Angle °")).toHaveValue("0");
  await panel.getByRole("button", { name: "Redo", exact: true }).click();
  await expect.poll(async () => Math.abs(Number(await panel.getByLabel("Angle °").inputValue()))).toBeGreaterThan(5);
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "posed.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(after)) });
  await page.locator("#tabPose").click();
  await page.locator(`#posePanel [data-object='${knee}']`).click();
  await expect.poll(async () => Math.abs(Number(await page.locator("#posePanel").getByLabel("Angle °").inputValue()))).toBeGreaterThan(5);
});


test("Make rest preserves the pose and shifts limits; ball joints offer three rings", async ({ page }) => {
  const { knee } = await setup(page);
  const panel = page.locator("#posePanel");
  await panel.locator(`[data-object='${knee}']`).click();
  await page.locator("[data-pose-tool='joint']").click();
  await panel.getByLabel("Joint kind").selectOption("hinge");
  await panel.getByLabel("Minimum °").fill("-50"); await panel.getByLabel("Minimum °").press("Tab");
  await panel.getByLabel("Maximum °").fill("60"); await panel.getByLabel("Maximum °").press("Tab");
  await panel.getByLabel("Angle °").fill("30"); await panel.getByLabel("Angle °").press("Tab");
  const before = await downloadProject(page);
  await panel.getByRole("button", { name: "Make rest" }).click();
  await expect(panel.getByLabel("Angle °")).toHaveValue("0");
  await expect(panel.getByLabel("Minimum °")).toHaveValue("-80");
  await expect(panel.getByLabel("Maximum °")).toHaveValue("30");
  const after = await downloadProject(page);
  expect(after.objects.find((row) => row.id === knee)!.modelPose).toEqual(before.objects.find((row) => row.id === knee)!.modelPose);
  await panel.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(panel.getByLabel("Angle °")).toHaveValue("30");
  await panel.getByRole("button", { name: "Rest", exact: true }).click();
  await expect(panel.getByLabel("Angle °")).toHaveValue("0");
  await panel.getByLabel("Joint kind").selectOption("ball");
  await panel.getByLabel("Cone °").fill("45"); await panel.getByLabel("Cone °").press("Tab");
  await page.locator("[data-pose-tool='turn']").click();
  await expect(page.locator("#pose")).toHaveAttribute("data-turn-handles", /0:.* 1:.* 2:/);
});


test("ball ring turns in its cone and Shift snaps a hinge", async ({ page }) => {
  const { knee } = await setup(page);
  const panel = page.locator("#posePanel");
  await panel.locator(`[data-object='${knee}']`).click();
  await panel.getByLabel("Joint kind").selectOption("hinge");
  await page.locator("[data-pose-tool='turn']").click();
  await page.locator("[data-pose-view='top']").click();
  const canvas = page.locator("#pose");
  await expect(canvas).toHaveAttribute("data-turn-handles", /0:/);
  let handle = numbers((await canvas.getAttribute("data-turn-handles"))!.split(":")[1] ?? "");
  let centre = numbers(await canvas.getAttribute("data-turn-center"));
  let x = handle[0] - centre[0], y = handle[1] - centre[1];
  const theta = Math.PI / 10;
  await page.mouse.move(...handle); await page.mouse.down(); await page.keyboard.down("Shift");
  await page.mouse.move(centre[0] + x * Math.cos(theta) - y * Math.sin(theta), centre[1] + x * Math.sin(theta) + y * Math.cos(theta), { steps: 8 });
  await page.mouse.up(); await page.keyboard.up("Shift");
  const angle = Number(await panel.getByLabel("Angle °").inputValue());
  expect(Math.abs(angle)).toBeGreaterThan(5);
  expect(angle / 5).toBeCloseTo(Math.round(angle / 5), 6);
  await panel.getByLabel("Joint kind").selectOption("ball");
  await panel.getByLabel("Cone °").fill("25"); await panel.getByLabel("Cone °").press("Tab");
  await expect(canvas).toHaveAttribute("data-turn-handles", /0:.* 1:.* 2:/);
  const handles = (await canvas.getAttribute("data-turn-handles"))!.split(" ");
  handle = numbers(handles.find((entry) => entry.startsWith("2:"))!.slice(2));
  centre = numbers(await canvas.getAttribute("data-turn-center"));
  x = handle[0] - centre[0]; y = handle[1] - centre[1];
  // Start away from the crossings with the other two rings.
  const qx = (x - y) / Math.sqrt(2), qy = (x + y) / Math.sqrt(2);
  const before = await downloadProject(page);
  await page.mouse.move(centre[0] + qx, centre[1] + qy); await page.mouse.down();
  await page.mouse.move(centre[0] - qy, centre[1] + qx, { steps: 12 }); await page.mouse.up();
  const after = await downloadProject(page);
  expect(after.objects.find((row) => row.id === knee)!.modelPose).not.toEqual(before.objects.find((row) => row.id === knee)!.modelPose);
  const joint = after.assemblies[0]!.members.find((row) => row.object === knee)?.joint;
  expect(joint?.kind).toBe("ball");
  expect(joint?.kind === "ball" ? joint.cone : undefined).toBe(25);
});


test("posing and undo leave a current slice current", async ({ page }) => {
  const { knee } = await setup(page);
  await page.locator(`#posePanel [data-object='${knee}']`).click();
  await page.locator("#tabPrepare").click();
  const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
  await page.route("**/api/slice", (route) => route.fulfill({ json: cube }));
  await page.locator("#slice").click();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  await page.locator("#tabPose").click();
  const panel = page.locator("#posePanel");
  await panel.getByLabel("Joint kind").selectOption("hinge");
  await panel.getByLabel("Angle °").fill("30"); await panel.getByLabel("Angle °").press("Tab");
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  await panel.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
});
