/**
 * Close a loop on the can press (L3b). The geometry is the recipe in mcp/fixtures/can-press/can_press.rs,
 * exported by e2e/fixtures/can-press/export-press.ts. The plate meshes and the solids are that build;
 * the owner's can-press files are not used. The saved assembly has no loops, so closing them is the Joint tool's pick.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type MockSolid } from "./model-tree-mock";
import { solveAssembly, type Member } from "../src/assembly.ts";
import type { Affine } from "../src/model-space.ts";

interface WireFace {
  id: number;
  areaMm2: number;
  normal?: [number, number, number];
  surface?: "cylinder" | "cone" | "sphere";
  radiusMm?: number;
  axisPoint?: [number, number, number];
  axis?: [number, number, number];
}
interface WireSolid {
  volumeMm3: number;
  positionsB64: string;
  trianglesB64: string;
  faces: WireFace[];
  edges: { id: number; lengthMm: number; pointsB64: string }[];
}
interface WirePart { name: string; seatMm: number; positionsB64: string; solid?: WireSolid }
interface WirePick {
  link: string;
  holeAt: [number, number, number];
  holeLook: [number, number, number];
  holeRay: [number, number, number];
  holeStatus: string;
  pinAt: [number, number, number];
  pinLook: [number, number, number];
  pinRay: [number, number, number];
  pinStatus: string;
}
interface PressFixture { parts: WirePart[]; members: Member[]; picks: WirePick[] }
interface SavedObject { id: string; name: string; fileName?: string; mesh?: { name?: string }; modelPose?: Affine; [key: string]: unknown }
interface SavedDocument { objects: SavedObject[]; assemblies: unknown[]; [key: string]: unknown }

const fixture = JSON.parse(fs.readFileSync(path.join("e2e", "fixtures", "can-press", "press.json"), "utf8")) as PressFixture;
const shots = path.join("docs", "screenshots", "l3b-loop-picks");

function floats(encoded: string): number[] {
  const bytes = Buffer.from(encoded, "base64");
  return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
}
function ints(encoded: string): number[] {
  const bytes = Buffer.from(encoded, "base64");
  return Array.from(new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
}
function solidOf(wire: WireSolid): MockSolid {
  return {
    volumeMm3: wire.volumeMm3,
    positions: floats(wire.positionsB64),
    triangles: ints(wire.trianglesB64),
    faces: wire.faces,
    edges: wire.edges.map((edge) => ({ id: edge.id, lengthMm: edge.lengthMm, points: floats(edge.pointsB64) })),
  };
}

const meshOf = new Map(fixture.parts.map((part) => [part.name, floats(part.positionsB64)]));
const solidByName = new Map(fixture.parts.flatMap((part) => part.solid ? [[part.name, solidOf(part.solid)] as const] : []));

test("hole snap and a coaxial pin close both can-press loops, and the lever drag keeps them", async ({ page }) => {
  test.setTimeout(180_000);
  fs.mkdirSync(shots, { recursive: true });
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/mesh", async (route) => {
    const body = route.request().postDataJSON() as { filename?: string };
    const name = (body.filename ?? "").replace(/\.step$/i, "");
    const part = fixture.parts.find((row) => row.name === name);
    const raw = part ? meshOf.get(name) : undefined;
    if (!part || !raw) {
      await route.fulfill({ status: 404, json: { error: `no mesh for ${name}` } });
      return;
    }
    // The plate mesh is seated for the bed. Lift it back to the CAD frame the solid and the picks use, and store no seat.
    const positions = raw.slice();
    if (part.seatMm) for (let i = 2; i < positions.length; i += 3) positions[i] = (positions[i] ?? 0) + part.seatMm;
    await route.fulfill({ json: { positions, seatMm: 0 } });
  });
  await mockModelTree(page, {
    open: (request) => {
      const name = String(request.filename ?? "").replace(/\.step$/i, "");
      return solidByName.get(name) ?? { error: `${name} is not a loop pick.` };
    },
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);

  const step = (name: string) => ({ name: `${name}.step`, mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;") });
  for (const part of fixture.parts) {
    const before = await page.locator("#objectList .obj").count();
    await page.locator("#plateAddFile").setInputFiles(step(part.name));
    await expect(page.locator("#objectList .obj")).toHaveCount(before + 1, { timeout: 30_000 });
  }

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const [file] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const doc = JSON.parse(fs.readFileSync((await file.path())!, "utf8")) as SavedDocument;
  const idOf = new Map<string, string>();
  for (const object of doc.objects) {
    const fromFile = (object.mesh?.name ?? object.fileName)?.replace(/\.step$/i, "");
    const part = fixture.parts.find((row) => row.name === object.name || row.name === fromFile);
    if (!part) continue;
    object.name = part.name;
    idOf.set(part.name, object.id);
  }
  for (const name of ["Frame", "Lever", "Ram", "Link L", "Link R"]) expect(idOf.get(name), name).toBeTruthy();
  const members: Member[] = fixture.members.map((member) => ({
    ...member,
    object: idOf.get(String(member.object)) ?? String(member.object),
    parent: member.parent ? (idOf.get(String(member.parent)) ?? String(member.parent)) : null,
  }));
  const assembly = { id: "press", name: "Can press", members };
  const solved = solveAssembly(assembly, () => undefined).poses;
  for (const object of doc.objects) {
    const pose = solved.get(object.id);
    if (pose) object.modelPose = pose;
  }
  doc.assemblies = [assembly];
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "can-press.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  await page.locator("#tabPose").click();
  const panel = page.locator("#posePanel");
  const canvas = page.locator("#pose");

  const clickLocal = async (id: string, at: readonly number[], ray: readonly number[]): Promise<void> => {
    const echoed = ray.map(Number).join(",");
    // The whole press frames this face thinner than a pixel. Sit close, on the ray that meets it.
    await canvas.evaluate((el, spec) => {
      delete el.dataset.loopPoint;
      delete el.dataset.loopStatus;
      delete el.dataset.cameraFrom;
      el.dataset.lookDist = "36";
      el.dataset.lookLocal = spec.point;
      el.dataset.projectLocal = spec.point;
      el.dataset.lookFrom = spec.look;
    }, { point: `${id}:${at.join(",")}`, look: echoed });
    await expect(canvas).toHaveAttribute("data-camera-from", echoed);
    // The orbit control eases onto the new view. Read the point again once it has stopped, or the click lands on whatever drifted under the pixel.
    await page.waitForTimeout(700);
    await canvas.evaluate((el, point) => { delete el.dataset.projected; el.dataset.projectLocal = point; }, `${id}:${at.join(",")}`);
    await expect(canvas).toHaveAttribute("data-projected", new RegExp(`(?:^| )${id}:`));
    const row = (await canvas.getAttribute("data-projected"))!.split(" ").find((part) => part.startsWith(`${id}:`))!;
    const [x, y] = row.slice(id.length + 1).split(",").map(Number);
    await page.mouse.click(x!, y!);
  };

  const gaps: { link: string; holeStatus: string; pinStatus: string; gapMm: number }[] = [];
  for (const pick of fixture.picks) {
    const linkId = idOf.get(pick.link)!;
    const ramId = idOf.get("Ram")!;
    await panel.locator(`[data-object='${linkId}']`).click();
    await page.locator("[data-pose-tool='joint']").click();
    const section = panel.locator("[data-pose-loop='section']");
    await expect(section).toContainText("Close a loop");
    await panel.locator("[data-pose-action='loop-arm'][data-loop-arm='a']").click();
    await clickLocal(linkId, pick.holeAt, pick.holeRay);
    await expect(canvas).toHaveAttribute("data-loop-point", `a:${linkId}`);
    await expect(canvas).toHaveAttribute("data-loop-status", pick.holeStatus);
    await expect(panel).toContainText(pick.holeStatus);
    await panel.locator("[data-pose-action='loop-arm'][data-loop-arm='b']").click();
    await clickLocal(ramId, pick.pinAt, pick.pinRay);
    await expect(canvas).toHaveAttribute("data-loop-point", `b:${ramId}`);
    await expect(canvas).toHaveAttribute("data-loop-status", pick.pinStatus);
    await expect(panel).toContainText(pick.pinStatus);
    const close = panel.locator("[data-pose-action='close-loop']");
    await expect(close).not.toHaveAttribute("aria-disabled", "true");
    await close.click();
    await expect(section).toContainText("Pin to Ram");
    await expect.poll(async () => Number(await canvas.getAttribute("data-loop-gap"))).toBeLessThanOrEqual(0.01);
    const gapMm = Number(await canvas.getAttribute("data-loop-gap"));
    gaps.push({ link: pick.link, holeStatus: pick.holeStatus, pinStatus: pick.pinStatus, gapMm });
    console.log(`PROOF ${pick.link} hole="${pick.holeStatus}" pin="${pick.pinStatus}" closureMm=${gapMm}`);
  }

  await page.locator("[data-pose-view='iso']").click();
  await page.screenshot({ path: path.join(shots, "loops-closed.png") });

  const leverId = idOf.get("Lever")!;
  const ramId = idOf.get("Ram")!;
  const linkL = idOf.get("Link L")!;
  await panel.locator(`[data-object='${leverId}']`).click();
  await page.locator("[data-pose-tool='turn']").click();
  await canvas.evaluate((el) => {
    delete el.dataset.cameraFrom;
    delete el.dataset.lookLocal;
    delete el.dataset.lookDist;
    el.dataset.lookFrom = "0,1,0";
  });
  await expect(canvas).toHaveAttribute("data-camera-from", "0,1,0");
  await expect(canvas).toHaveAttribute("data-turn-handles", /0:/);
  const posed = () => canvas.getAttribute("data-posed");
  const box = async (id: string): Promise<number[]> => {
    const row = (await posed())?.split(" ").find((part) => part.startsWith(`${id}:`));
    return row ? row.slice(id.length + 1).split(",").map(Number) : [];
  };
  const ramBefore = await box(ramId);
  const linkBefore = await box(linkL);
  const handle = (await canvas.getAttribute("data-turn-handles"))!.split(" ").find((part) => part.startsWith("0:"))!.slice(2).split(",").map(Number);
  const centre = (await canvas.getAttribute("data-turn-center"))!.split(",").map(Number);
  const ox = handle[0]! - centre[0]!;
  const oy = handle[1]! - centre[1]!;
  let worst = Number(await canvas.getAttribute("data-loop-gap"));
  const steps = 8;
  await page.mouse.move(handle[0]!, handle[1]!);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    const theta = (70 * Math.PI / 180) * (i / steps);
    await page.mouse.move(centre[0]! + ox * Math.cos(theta) - oy * Math.sin(theta), centre[1]! + ox * Math.sin(theta) + oy * Math.cos(theta));
    const gap = Number(await canvas.getAttribute("data-loop-gap"));
    if (Number.isFinite(gap)) worst = Math.max(worst, gap);
  }
  await page.mouse.up();
  const endGap = Number(await canvas.getAttribute("data-loop-gap"));
  if (Number.isFinite(endGap)) worst = Math.max(worst, endGap);
  const ramAfter = await box(ramId);
  const linkAfter = await box(linkL);
  const ramMoved = Math.hypot((ramAfter[2] ?? 0) - (ramBefore[2] ?? 0), (ramAfter[5] ?? 0) - (ramBefore[5] ?? 0));
  const linkMoved = Math.hypot((linkAfter[0] ?? 0) - (linkBefore[0] ?? 0), (linkAfter[3] ?? 0) - (linkBefore[3] ?? 0), (linkAfter[2] ?? 0) - (linkBefore[2] ?? 0), (linkAfter[5] ?? 0) - (linkBefore[5] ?? 0));
  console.log(`PROOF lever-drag worstPinMm=${worst} ramMovedMm=${ramMoved} linkLMovedMm=${linkMoved} steps=${steps}`);
  expect(ramMoved).toBeGreaterThan(0.5);
  expect(linkMoved).toBeGreaterThan(0.5);
  expect(worst).toBeLessThanOrEqual(0.01);
  expect(gaps).toHaveLength(2);

  await page.locator("[data-pose-view='iso']").click();
  await page.screenshot({ path: path.join(shots, "mid-stroke.png") });
});
