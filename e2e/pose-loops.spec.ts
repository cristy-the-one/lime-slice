import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type MockSolid } from "./model-tree-mock";
import { solveAssembly, type Closure, type Member } from "../src/assembly.ts";
import type { Affine } from "../src/model-space.ts";
import { moveSlide, turnHinge } from "../src/pose.ts";
import { closureGapMm } from "../src/pose-loops.ts";

const shots = path.join("docs", "screenshots", "l3-loops");

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

async function loadCrank(page: Page, theta = 140): Promise<void> {
  const built = crankSlider(theta);
  const assembly = { id: "press", name: "Press", members: built.members, closures: built.closures };
  expect(closureGapMm(assembly, () => undefined)).toBeLessThanOrEqual(1e-4);
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
  await expect(page.locator("#posePanel")).toBeVisible();
}

test("dragging the crank's ring moves the ram, and Ctrl+Z restores both", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
  await loadCrank(page, 140);
  const panel = page.locator("#posePanel");
  await page.locator("[data-pose-view='top']").click();
  await page.screenshot({ path: path.join(shots, "mid-stroke.png") });
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
  await page.screenshot({ path: path.join(shots, "lever-drag.png") });
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

async function openDark(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
}

/** Centres of the posed parts, in page pixels, read while Reach is on. */
async function partCentres(page: Page): Promise<Map<string, [number, number]>> {
  await page.locator("[data-pose-tool='reach']").click();
  const canvas = page.locator("#pose");
  await expect(canvas).toHaveAttribute("data-reach-points", /:/);
  const points = new Map<string, [number, number]>();
  for (const entry of (await canvas.getAttribute("data-reach-points"))!.split(" ")) {
    const [id, xy] = entry.split(":");
    const [x, y] = (xy ?? "").split(",").map(Number);
    if (id && Number.isFinite(x) && Number.isFinite(y)) points.set(id, [x!, y!]);
  }
  await page.locator("[data-pose-tool='joint']").click();
  return points;
}

async function clickUntil(page: Page, at: [number, number], hit: (picked: string | null) => boolean): Promise<boolean> {
  const canvas = page.locator("#pose");
  for (const dy of [0, -12, 12, -24, 24, -40, 40]) {
    for (const dx of [0, -12, 12, -24, 24]) {
      await page.mouse.click(at[0] + dx, at[1] + dy);
      if (hit(await canvas.getAttribute("data-picked"))) return true;
    }
  }
  return false;
}

test("Close a loop stays disabled with the reason, and removing one is one undo step", async ({ page }) => {
  await openDark(page);
  await page.locator("#tabPose").click();
  await page.locator("[data-pose-tool='joint']").click();
  const panel = page.locator("#posePanel");
  const close = panel.locator("[data-pose-action='close-loop']");
  await expect(close).toHaveAttribute("aria-disabled", "true");
  await expect(close).toHaveAttribute("data-tip", /No assembly\./);

  await loadCrank(page);
  await page.locator("[data-pose-tool='joint']").click();
  await panel.locator("[data-object='link']").click();
  const section = panel.locator("[data-pose-loop='section']");
  await expect(section).toContainText("Close a loop");
  await expect(section).toContainText("Pin to Ram");
  await expect(close).toHaveAttribute("data-tip", /One member picked\./);
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, "close-a-loop.png") });

  const centres = await partCentres(page);
  await panel.locator("[data-pose-action='loop-arm'][data-loop-arm='a']").click();
  expect(await clickUntil(page, centres.get("link")!, (picked) => picked === "link")).toBe(true);
  await expect(section).toContainText("On this part:");
  await panel.locator("[data-pose-action='loop-arm'][data-loop-arm='b']").click();
  expect(await clickUntil(page, centres.get("crank")!, (picked) => picked === "crank")).toBe(true);
  await expect(section).toContainText("On Crank:");
  await expect(close).toHaveAttribute("data-tip", /Crank is already Link L's parent: that is a joint, not a loop/);

  await section.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(section).toContainText("No loops on this part.");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+z");
  await expect(section).toContainText("Pin to Ram");
  await page.keyboard.press("Control+y");
  await expect(section).toContainText("No loops on this part.");
});

test("closing a loop between two cylinders is one undo step", async ({ page }) => {
  test.setTimeout(60_000);
  const positions: number[] = [], triangles: number[] = [];
  const add = (face: number, a: number[], b: number[], c: number[]) => { positions.push(...a, ...b, ...c); triangles.push(face); };
  const n = 16;
  for (let i = 0; i < n; i++) {
    const a = 2 * Math.PI * i / n, b = 2 * Math.PI * (i + 1) / n;
    const v = (r: number, t: number, z: number) => [r * Math.cos(t), r * Math.sin(t), z];
    const oa = v(8, a, 0), ob = v(8, b, 0), ot = v(8, a, 50), pt = v(8, b, 50);
    add(0, oa, ob, pt); add(0, oa, pt, ot);
    add(1, oa, v(8, a, 50), v(0, 0, 50)); add(1, oa, v(0, 0, 0), ob);
  }
  const solid: MockSolid = {
    volumeMm3: 10000, positions, triangles,
    faces: [{ id: 0, areaMm2: 2500, surface: "cylinder", radiusMm: 8, axisPoint: [0, 0, 0], axis: [0, 0, 1] }, { id: 1, areaMm2: 400 }],
    edges: [],
  };
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions, seatMm: 0 } }));
  await mockModelTree(page, { open: () => solid });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
  const step = { name: "bore.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;") };
  await page.locator("#plateAddFile").setInputFiles(step);
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  const slider = (await page.locator("#prepare").getAttribute("data-plate-selected"))!;
  await page.locator("#plateAddFile").setInputFiles({ ...step, name: "pin.step" });
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  const anchor = (await page.locator("#prepare").getAttribute("data-plate-selected"))!;
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const [file] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const doc = JSON.parse(fs.readFileSync((await file.path())!, "utf8")) as TestDocument;
  const members: Member[] = [
    { object: "part", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
    { object: slider, parent: "part", offset: [-20, 0, 0], turn: [0, 0, 0], joint: { kind: "slide", pivot: [0, 0, 25], axis: [1, 0, 0], travel: 0, min: -5, max: 40 } },
    { object: anchor, parent: "part", offset: [0, 0, 0], turn: [0, 0, 0] },
  ];
  const assembly = { id: "pair", name: "Pair", members };
  const solved = solveAssembly(assembly, () => undefined).poses;
  for (const object of doc.objects) object.modelPose = solved.get(object.id) ?? object.modelPose;
  doc.assemblies = [assembly];
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "pair.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  await page.locator("#tabPose").click();
  const panel = page.locator("#posePanel");
  await panel.locator(`[data-object='${slider}']`).click();
  await page.locator("[data-pose-tool='joint']").click();
  const canvas = page.locator("#pose");
  // The hole axis is Z, so Front looks at it from the side. The point is the axis centre, not a pixel search.
  const clickHole = async (id: string, arm: string): Promise<void> => {
    await canvas.evaluate((el, spec) => { delete el.dataset.loopPoint; delete el.dataset.jointFace; el.dataset.projectLocal = spec; }, `${id}:0,0,25`);
    await page.locator("[data-pose-view='front']").click();
    await expect(canvas).toHaveAttribute("data-projected", new RegExp(`(?:^| )${id}:`));
    const row = (await canvas.getAttribute("data-projected"))!.split(" ").find((part) => part.startsWith(`${id}:`))!;
    const [x, y] = row.slice(id.length + 1).split(",").map(Number);
    await page.mouse.click(x!, y!);
    await expect(canvas).toHaveAttribute("data-loop-point", `${arm}:${id}`);
  };
  await panel.locator("[data-pose-action='loop-arm'][data-loop-arm='a']").click();
  await clickHole(slider, "a");
  await panel.locator("[data-pose-action='loop-arm'][data-loop-arm='b']").click();
  await clickHole(anchor, "b");
  const close = panel.locator("[data-pose-action='close-loop']");
  await expect(close).not.toHaveAttribute("aria-disabled", "true");
  await close.click();
  await expect(panel.locator("[data-pose-loop='section']")).toContainText("Pin to");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+z");
  await expect(panel.locator("[data-pose-loop='section']")).toContainText("No loops on this part.");
});
