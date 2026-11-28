import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { solveAssembly, type Closure, type Member } from "../src/assembly.ts";
import type { Affine } from "../src/model-space.ts";
import { moveSlide, turnHinge } from "../src/pose.ts";
import { closureGapMm } from "../src/pose-loops.ts";

interface TestObject { id: string; name: string; modelPose?: Affine; placement: unknown; [key: string]: unknown }
interface TestDocument { objects: TestObject[]; assemblies: { id: string; name: string; members: Member[]; closures?: Closure[] }[]; [key: string]: unknown }

const RAD = Math.PI / 180;

/** A crank-slider in the plate's top view: the crank turns about Z and the ram slides on Y. */
function crankSlider(theta: number): { members: Member[]; closures: Closure[] } {
  const r = 20, L = 55;
  const travel = r * Math.sin(theta * RAD) - Math.sqrt(L * L - (r * Math.cos(theta * RAD)) ** 2);
  const hinge = { kind: "hinge" as const, pivot: [0, 0, 0] as [number, number, number], axis: [0, 0, 1] as [number, number, number], angle: 0, min: -360, max: 360 };
  const frame: Member = { object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] };
  const crank = turnHinge({ object: "crank", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: hinge }, theta);
  if ("reason" in crank) throw new Error(crank.reason);
  const pose = solveAssembly({ id: "b", name: "b", members: [frame, crank] }, () => undefined).poses.get("crank")!;
  const p = [-pose.t[0], travel - pose.t[1], -pose.t[2]];
  const m = pose.m;
  const inv = [m[0] * p[0] + m[3] * p[1] + m[6] * p[2], m[1] * p[0] + m[4] * p[1] + m[7] * p[2], m[2] * p[0] + m[5] * p[1] + m[8] * p[2]];
  const alpha = Math.atan2(inv[1], inv[0] - r) * 180 / Math.PI;
  const link = turnHinge({ object: "link", parent: "crank", offset: [r, 0, 0], turn: [0, 0, 0], joint: hinge }, alpha);
  if ("reason" in link) throw new Error(link.reason);
  const ram = moveSlide({ object: "ram", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "slide", pivot: [0, 0, 0], axis: [0, 1, 0], travel: 0, min: -120, max: 40 } }, travel);
  if ("reason" in ram) throw new Error(ram.reason);
  return {
    members: [frame, crank, link, ram],
    closures: [{ id: "loop_1", kind: "pin", a: { member: "link", at: [L, 0, 0] }, b: { member: "ram", at: [0, 0, 0] } }],
  };
}

function boxOf(raw: string | null, id: string): number[] {
  const row = (raw ?? "").split(" ").find((part) => part.startsWith(`${id}:`));
  if (!row) throw new Error(`no posed box for ${id}`);
  return row.slice(id.length + 1).split(",").map(Number);
}

function numbers(raw: string | null): [number, number] {
  const row = (raw ?? "").split(",").map(Number);
  return [row[0]!, row[1]!];
}

test("dragging the crank's ring moves the ram, and Ctrl+Z restores both", async ({ page }) => {
  const built = crankSlider(140);
  const assembly = { id: "press", name: "Press", members: built.members, closures: built.closures };
  const gap = closureGapMm(assembly, () => undefined);
  expect(gap).toBeLessThanOrEqual(1e-4);

  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const [file] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const doc = JSON.parse(fs.readFileSync((await file.path())!, "utf8")) as TestDocument;
  const cube = doc.objects.find((part) => part.id === "part")!;
  const solved = solveAssembly(assembly, () => undefined).poses;
  const copy = (id: string, name: string): TestObject => ({ ...structuredClone(cube), id, name, modelPose: solved.get(id) ?? cube.modelPose });
  doc.objects = [copy("frame", "Frame"), copy("crank", "Crank"), copy("link", "Link L"), copy("ram", "Ram")];
  doc.assemblies = [assembly];
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "press.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  await page.locator("#tabPose").click();
  const panel = page.locator("#posePanel");
  await expect(panel).toBeVisible();
  await panel.locator("[data-object='crank']").click();
  await page.locator("[data-pose-tool='turn']").click();
  await page.locator("[data-pose-view='top']").click();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const canvas = page.locator("#pose");
  await expect(canvas).toHaveAttribute("data-turn-handles", /0:/);
  const posed = () => canvas.getAttribute("data-posed");
  const ramBefore = boxOf(await posed(), "ram");
  const crankBefore = boxOf(await posed(), "crank");
  const angleBefore = Number(await panel.getByLabel("Angle °").inputValue());
  const handle = numbers((await canvas.getAttribute("data-turn-handles"))!.split(":")[1] ?? "");
  const centre = numbers(await canvas.getAttribute("data-turn-center"));
  const x = handle[0] - centre[0], y = handle[1] - centre[1];
  const theta = Math.PI / 8;
  await page.mouse.move(handle[0], handle[1]);
  await page.mouse.down();
  await page.mouse.move(centre[0] + x * Math.cos(theta) - y * Math.sin(theta), centre[1] + x * Math.sin(theta) + y * Math.cos(theta), { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs(Number(await panel.getByLabel("Angle °").inputValue()) - angleBefore)).toBeGreaterThan(2);
  const ramAfter = boxOf(await posed(), "ram");
  expect(Math.abs(ramAfter[1]! - ramBefore[1]!)).toBeGreaterThan(0.5);
  expect(Math.hypot(ramAfter[1]! - ramBefore[1]!, ramAfter[4]! - ramBefore[4]!)).toBeGreaterThan(0.5);
  const angleAfter = Number(await panel.getByLabel("Angle °").inputValue());
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+z");
  await expect.poll(async () => Number(await panel.getByLabel("Angle °").inputValue())).toBeCloseTo(angleBefore, 1);
  const ramRestored = boxOf(await posed(), "ram");
  const crankRestored = boxOf(await posed(), "crank");
  expect(Math.abs(ramRestored[1]! - ramBefore[1]!)).toBeLessThan(0.05);
  expect(Math.abs(crankRestored[0]! - crankBefore[0]!)).toBeLessThan(0.05);
  expect(Math.abs(angleAfter - angleBefore)).toBeGreaterThan(2);
});
