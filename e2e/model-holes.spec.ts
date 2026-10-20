/**
 * Holes from sketch points: three centres on a face become one history group.
 * The volume is the mock's: the box minus one cylinder per hole, π r² depth.
 */
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";

type V = [number, number, number];

/** A box the modeler can pick. Face 0 is −Z, face 1 is +Z. */
function boxSolid(min: V = [0, 0, 0], size: V = [20, 20, 10]): MockSolid {
  const [ox, oy, oz] = min;
  const [sx, sy, sz] = size;
  const c = (x: number, y: number, z: number): V => [ox + x * sx, oy + y * sy, oz + z * sz];
  const quads: V[][] = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  const positions: number[] = [];
  const triangles: number[] = [];
  quads.forEach((q, face) => {
    for (const tri of [[0, 1, 2], [0, 2, 3]]) {
      for (const i of tri) positions.push(...q[i]!);
      triangles.push(face);
    }
  });
  const corners: V[] = [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0), c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const edges = pairs.map(([a, b], id) => {
    const pa = corners[a!]!;
    const pb = corners[b!]!;
    return { id, lengthMm: Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]), points: [...pa, ...pb] };
  });
  const faces = quads.map((_, id) => ({ id, areaMm2: (id < 2 ? sx * sy : id < 4 ? sx * sz : sy * sz) }));
  return { volumeMm3: sx * sy * sz, positions, triangles, faces, edges };
}

/** The box, minus one cylinder for each hole step. The mesh stays the box, so the face can still be picked. */
function drilled(request: Body, parent: MockSolid): MockSolid {
  const op = request.op as { kind?: string; steps?: { kind?: string; radius?: number; depth?: number; through?: boolean }[] };
  const steps = op.kind === "group" && Array.isArray(op.steps) ? op.steps : [];
  const height = 10;
  let removed = 0;
  for (const step of steps) {
    if (step.kind !== "hole" || typeof step.radius !== "number") continue;
    const depth = step.through ? height : Math.abs(step.depth ?? 0);
    removed += Math.PI * step.radius * step.radius * depth;
  }
  return { ...parent, volumeMm3: parent.volumeMm3 - removed };
}

function shownVolume(mm3: number): string {
  const rounded = Math.round(mm3 * 100) / 100;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
  return `Volume ${text} mm³`;
}

async function start(page: Page): Promise<TreeMock> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid().positions, seatMm: 0 } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: (request) => {
      const feature = request.feature as { depth?: number } | undefined;
      const height = feature && typeof feature.depth === "number" ? Math.abs(feature.depth) : 10;
      return boxSolid([0, 0, 0], [20, 20, height]);
    },
    apply: drilled,
    probe: () => ({ ok: true }),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelEmptySketch")).toBeVisible();
  return tree;
}

async function facePoint(page: Page, want: (normal: number[]) => boolean): Promise<{ x: number; y: number }> {
  let found: { x: number; y: number } | null = null;
  await expect.poll(async () => {
    const text = (await page.locator("#model").getAttribute("data-faces")) ?? "";
    const box = await page.locator("#model").boundingBox();
    if (!box) return "";
    for (const item of text.split(" ").filter(Boolean)) {
      const [, xy, normalText] = item.split(":");
      const normal = normalText!.split(",").map(Number);
      if (!want(normal)) continue;
      const [x, y] = xy!.split(",").map(Number);
      const point = { x: box.x + x!, y: box.y + y! };
      if (point.x < box.x || point.y < box.y || point.x > box.x + box.width || point.y > box.y + box.height) continue;
      found = point;
      return "on-screen";
    }
    return "";
  }).toBe("on-screen");
  return found!;
}

async function drawTypedCircle(page: Page, at: { x: number; y: number }, diameter: string) {
  await page.mouse.click(at.x, at.y);
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  await hud.locator("input").nth(0).fill(diameter);
  await hud.locator("input").nth(0).press("Enter");
}

async function toolbarFits(page: Page) {
  return page.locator(".model-tools").evaluate((bar) => bar.scrollWidth <= bar.clientWidth);
}

test("three sketch points become one group of holes, and History Edit changes the depth", async ({ page }) => {
  const tree = await start(page);
  await page.locator("#modelEmptySketch").click();
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await page.locator("[data-sketch-tool=rectangle]").click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").nth(0).fill("12");
  await hud.locator("input").nth(0).press("Tab");
  await hud.locator("input").nth(1).fill("8");
  await hud.locator("input").nth(1).press("Enter");
  await page.keyboard.press("E");
  await expect(hud).toBeVisible();
  await hud.locator("input").first().fill("10");
  await hud.locator("input").first().press("Enter");
  await expect(page.locator("#modelHistoryTree")).toContainText("Extrude");
  await expect(canvas).not.toHaveAttribute("data-sketch", "editing");

  await page.keyboard.press("H");
  await expect(page.locator("#modelToolHole")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelHolePoints")).toBeHidden();
  await expect(page.locator("label[data-hole=single]").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#modelPanel")).toBeHidden();

  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  await page.mouse.click(top.x, top.y);
  await page.locator("#modelContextBar").getByRole("button", { name: "Sketch on face" }).click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-sketch-plane", "face 1");
  await expect(canvas).toHaveAttribute("data-sketch-camera", "locked");
  await expect(page.getByRole("button", { name: "Holes (H)" })).toBeVisible();
  await expect.poll(() => toolbarFits(page)).toBe(true);

  await page.locator("[data-sketch-menu=draw]").click();
  await page.locator(".sketch-menu-list [data-sketch-tool=circle]").click();
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "circle");
  const view = (await canvas.boundingBox())!;
  const spots = [
    { x: view.x + view.width * 0.42, y: view.y + view.height * 0.48 },
    { x: view.x + view.width * 0.55, y: view.y + view.height * 0.55 },
    { x: view.x + view.width * 0.68, y: view.y + view.height * 0.42 },
  ];
  for (const spot of spots) await drawTypedCircle(page, spot, "4");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "circle,circle,circle");

  await page.getByRole("button", { name: "Select", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "select");
  await expect.poll(async () => ((await canvas.getAttribute("data-sketch-hits")) ?? "").split(" ").filter(Boolean).length).toBe(3);
  const hits = ((await canvas.getAttribute("data-sketch-hits")) ?? "").split(" ").filter(Boolean).map((item) => {
    const [, xy] = item.split(":");
    const [x, y] = xy!.split(",").map(Number);
    return { x: x!, y: y! };
  });
  for (let i = 0; i < hits.length; i += 1) {
    if (i > 0) await page.keyboard.down("Shift");
    await page.mouse.click(hits[i]!.x, hits[i]!.y);
    if (i > 0) await page.keyboard.up("Shift");
  }
  await expect.poll(async () => ((await canvas.getAttribute("data-sketch-selected")) ?? "").split(",").filter(Boolean).length).toBe(3);

  await page.keyboard.press("H");
  await expect(page.locator("#modelPanel")).toBeVisible();
  await expect(page.locator("#modelHolePoints")).toHaveText("One hole at each of 3 points.");
  await expect(page.locator("label[data-hole=single]").first()).toBeHidden();
  await expect(canvas).toHaveAttribute("data-sketch-holes", "3");
  await expect.poll(() => toolbarFits(page)).toBe(true);
  // A size that cannot drill is said in the app, and the modeler is not asked.
  const before = tree.calls.length;
  await page.locator("#modelHoleR").fill("0");
  await expect(page.locator("#modelReadout")).toContainText("A hole needs a diameter above 0.");
  await page.waitForTimeout(500);
  expect(tree.calls.slice(before).filter((call) => call.call === "probe")).toHaveLength(0);
  await page.locator("#modelHoleR").fill("2");
  await page.locator("#modelHoleD").fill("8");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();

  await expect(page.locator("#modelHistoryTree")).toContainText("3 holes ⌀4 depth 8");
  const applied = tree.of("apply").at(-1)!.op as { kind?: string; label?: string; steps?: { kind?: string }[]; source?: { kind?: string; points?: number[] } };
  expect(applied.kind).toBe("group");
  expect(applied.label).toBe("3 holes ⌀4 depth 8");
  expect(applied.steps).toHaveLength(3);
  expect(applied.steps?.every((step) => step.kind === "hole")).toBe(true);
  expect(applied.source?.kind).toBe("sketchHoles");
  expect(applied.source?.points).toHaveLength(3);

  // The holes are the sketch's feature: the sketch closes, and Undo takes the holes back, not a circle.
  await expect(canvas).toHaveAttribute("data-sketch", "pinned");
  await expect(page.locator("#modelReadout")).toContainText(shownVolume(4000 - 3 * Math.PI * 4 * 8));
  await page.keyboard.press("Control+z");
  await expect(page.locator("#modelReadout")).toContainText(shownVolume(4000));
  await expect(canvas).toHaveAttribute("data-sketch", "pinned");
  await page.keyboard.press("Control+y");
  await expect(page.locator("#modelReadout")).toContainText(shownVolume(4000 - 3 * Math.PI * 4 * 8));
  for (let guard = 0; guard < 6 && (await canvas.getAttribute("data-sketch")) !== "off"; guard += 1) {
    const discard = page.locator("[data-sketch-discard]");
    if ((await discard.count()) === 0) break;
    await discard.first().click();
  }
  await expect(canvas).toHaveAttribute("data-sketch", "off");
  await expect(page.locator("#modelReadout")).toContainText(shownVolume(4000 - 3 * Math.PI * 4 * 8));

  await page.locator("#modelHistoryTree .mh-row", { hasText: "3 holes ⌀4 depth 8" }).locator(".mh-edit").click();
  await expect(page.locator("#modelHolePoints")).toHaveText("One hole at each of 3 points.");
  await expect(page.locator("#modelApply")).toHaveText("Update");
  await page.locator("#modelHoleD").fill("4");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelHistoryTree")).toContainText("3 holes ⌀4 depth 4");
  await expect(page.locator("#modelReadout")).toContainText(shownVolume(4000 - 3 * Math.PI * 16));
  const edited = tree.of("edit").at(-1)!.op as { kind?: string; label?: string; steps?: { depth?: number }[] };
  expect(edited.kind).toBe("group");
  expect(edited.label).toBe("3 holes ⌀4 depth 4");
  expect(edited.steps?.map((step) => step.depth)).toEqual([4, 4, 4]);
});

test("H on a bed sketch refuses, and the toolbar still fits", async ({ page }) => {
  await start(page);
  await page.locator("#modelEmptySketch").click();
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-sketch-plane", "XY");
  await expect(page.getByRole("button", { name: "Holes (H)" })).toHaveCount(0);
  await page.keyboard.press("H");
  await expect(page.locator("#modelReadout")).toContainText("Sketch on a face to place a hole at each point.");
  await expect(page.locator("#modelPanel")).toBeHidden();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-sketch-holes", "off");
  await expect.poll(() => toolbarFits(page)).toBe(true);
});
