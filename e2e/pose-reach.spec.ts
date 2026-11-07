import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { applyPose, IDENTITY_POSE, type Affine } from "../src/model-space.ts";
import type { Member } from "../src/assembly.ts";

interface TestObject { id: string; name: string; modelPose?: Affine; placement: unknown; [key: string]: unknown }
interface TestDocument { objects: TestObject[]; assemblies: { id: string; name: string; members: Member[] }[]; [key: string]: unknown }
const shots = process.env.LIME_SHOTS ?? path.join("test-results", "pose-reach");
async function save(page: Page): Promise<TestDocument> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const [file] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  return JSON.parse(fs.readFileSync((await file.path())!, "utf8"));
}
function coords(raw: string | null): [number, number] { const values = (raw ?? "").split(",").map(Number); return [values[0]!, values[1]!]; }

test("Reach drags the grabbed surface point on a three-hinge chain, with one undo", async ({ page }) => {
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
  const doc = await save(page);
  const cube = doc.objects.find((part) => part.id === "part")!;
  const other = doc.objects.find((part) => part.id !== "part")!;
  const identity: Affine["m"] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const pose = (x: number): Affine => ({ m: identity, t: [x, 0, 0] });
  doc.objects = [
    { ...structuredClone(cube), id: "body", name: "body.stl", modelPose: pose(-50) },
    { ...structuredClone(cube), id: "hip", name: "hip.stl", modelPose: pose(0) },
    { ...structuredClone(cube), id: "knee", name: "knee.stl", modelPose: pose(30) },
    { ...structuredClone(cube), id: "tip", name: "tip.stl", modelPose: pose(60) },
    { ...structuredClone(other), id: "other", name: "other.stl", modelPose: pose(160) },
  ];
  const hinge = (object: string, parent: string, x: number): Member => ({ object, parent, offset: [x, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1], angle: 0, min: -150, max: 150 } });
  doc.assemblies = [{ members: [
    { object: "body", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
    hinge("hip", "body", 50), hinge("knee", "hip", 30), hinge("tip", "knee", 30),
  ], id: "leg", name: "leg" }];
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "leg.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  await page.locator("#tabPose").click();
  const panel = page.locator("#posePanel"), canvas = page.locator("#pose");
  await panel.locator("[data-object='tip']").click();
  await page.locator("#tabPrepare").click();
  const cubeSlice = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
  await page.route("**/api/slice", (route) => route.fulfill({ json: cubeSlice }));
  await page.locator("#slice").click();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  await page.locator("#tabPose").click();
  await panel.locator("[data-object='other']").click();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  await panel.locator("[data-object='knee']").click();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  await panel.locator("[data-object='tip']").click();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  await page.locator("[data-pose-view='top']").click();
  await page.locator("[data-pose-tool='reach']").click();
  await expect(canvas).toHaveAttribute("data-reach-points", /tip:/);
  const entry = (await canvas.getAttribute("data-reach-points"))!.split(" ").find((row) => row.startsWith("tip:"))!;
  const origin = coords(entry.slice(4));
  const before = await save(page);
  const originalBody = before.objects.find((part) => part.id === "body")!.modelPose ?? IDENTITY_POSE;
  const originalTip = before.objects.find((part) => part.id === "tip")!.modelPose ?? IDENTITY_POSE;
  await page.mouse.move(origin[0] + 3, origin[1] + 3);
  await page.mouse.down();
  await expect(canvas).toHaveAttribute("data-reach-object", "tip");
  const local = JSON.parse((await canvas.getAttribute("data-reach-local"))!) as [number, number, number];
  expect(Math.hypot(...local)).toBeGreaterThan(1); // The picked surface point, not the ankle pivot.
  await page.mouse.move(origin[0] - 15, origin[1] + 35, { steps: 10 });
  await page.mouse.up();
  await expect(canvas).toHaveAttribute("data-reach-anchor", "body");
  const target = JSON.parse((await canvas.getAttribute("data-reach-target"))!) as number[];
  const point = JSON.parse((await canvas.getAttribute("data-reach-point"))!) as number[];
  const startingPoint = applyPose(originalTip, local);
  const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
  expect(distance(point, target)).toBeLessThan(distance(startingPoint, target));
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  const moved = await save(page);
  expect(moved.objects.find((part) => part.id === "body")!.modelPose ?? IDENTITY_POSE).toEqual(originalBody);
  expect(moved.objects.find((part) => part.id === "tip")!.modelPose).not.toEqual(originalTip);
  expect(moved.objects.map((part) => part.placement)).toEqual(before.objects.map((part) => part.placement));
  expect(moved.assemblies[0]!.members.some((member) => member.joint?.kind === "hinge" && Math.abs(member.joint.angle ?? 0) > 0.1)).toBe(true);
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, "reach-leg.png") });
  await panel.getByRole("button", { name: "Undo", exact: true }).click();
  const undone = await save(page);
  expect(undone.objects.find((part) => part.id === "tip")!.modelPose ?? IDENTITY_POSE).toEqual(originalTip);
  await panel.getByRole("button", { name: "Redo", exact: true }).click();
  const redone = await save(page);
  expect(redone.objects.find((part) => part.id === "tip")!.modelPose).toEqual(moved.objects.find((part) => part.id === "tip")!.modelPose);
  // Escape cancels a new gesture and restores the pose at its start.
  await expect(canvas).toHaveAttribute("data-reach-points", /tip:/);
  const nextEntry = (await canvas.getAttribute("data-reach-points"))!.split(" ").find((row) => row.startsWith("tip:"))!;
  const next = coords(nextEntry.slice(4));
  await page.mouse.move(next[0], next[1]); await page.mouse.down();
  await page.mouse.move(next[0] - 15, next[1] - 25, { steps: 6 });
  await page.keyboard.press("Escape"); await page.mouse.up();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  const cancelled = await save(page);
  expect(cancelled.objects.find((part) => part.id === "tip")!.modelPose).toEqual(redone.objects.find((part) => part.id === "tip")!.modelPose);
});
test("Reach turns a cone-limited ball joint", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/"); await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
  await page.locator("#plateAddFile").setInputFiles("samples/overhang_ledge.stl");
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  const doc = await save(page);
  const cube = doc.objects.find((part) => part.id === "part")!;
  const m: Affine["m"] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  doc.objects = [
    { ...structuredClone(cube), id: "root", name: "root.stl", modelPose: { m, t: [-40, 0, 0] } },
    { ...structuredClone(cube), id: "ball", name: "ball.stl", modelPose: { m, t: [40, 0, 0] } },
  ];
  doc.assemblies = [{ id: "ball-assembly", name: "ball", members: [
    { object: "root", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
    { object: "ball", parent: "root", offset: [80, 0, 0], turn: [0, 0, 0], joint: { kind: "ball", pivot: [0, 0, 0], cone: 25, rest: [0, 0, 0, 1] } },
  ] }];
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "ball.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  await page.locator("#tabPose").click();
  await page.locator("#posePanel [data-object='ball']").click();
  await page.locator("[data-pose-view='top']").click();
  await page.locator("[data-pose-tool='reach']").click();
  const canvas = page.locator("#pose");
  await expect(canvas).toHaveAttribute("data-reach-points", /ball:/);
  const entry = (await canvas.getAttribute("data-reach-points"))!.split(" ").find((row) => row.startsWith("ball:"))!;
  const point = coords(entry.slice(5));
  const before = await save(page);
  await page.mouse.move(point[0], point[1]); await page.mouse.down();
  await expect(canvas).toHaveAttribute("data-reach-object", "ball");
  await page.mouse.move(point[0] - 15, point[1] + 30, { steps: 8 }); await page.mouse.up();
  await expect(canvas).toHaveAttribute("data-reach-anchor", "root");
  const after = await save(page);
  expect(after.objects.find((part) => part.id === "ball")!.modelPose).not.toEqual(before.objects.find((part) => part.id === "ball")!.modelPose);
  const joint = after.assemblies[0]!.members.find((member) => member.object === "ball")!.joint;
  expect(joint?.kind === "ball" && joint.cone).toBe(25);
});
