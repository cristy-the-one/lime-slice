import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";
import type { LoftSection } from "../src/model-tree.ts";

/**
 * --- Sketch for people, milestone 4 (docs/plan-sketch-for-people.md, S3, H1 and V1). A sweep route's sharp corner is
 * rounded in the same Apply, Holes starts from any sketch and drills every circle after one Yes, and a revolve's axis
 * is a button. ---
 */

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
  const faces = quads.map((_, id) => ({ id, areaMm2: id < 2 ? sx * sy : id < 4 ? sx * sz : sy * sz }));
  return { volumeMm3: sx * sy * sz, positions, triangles, faces, edges: [] };
}

/** The box, minus one cylinder for each hole step. */
function drilled(request: Body, parent: MockSolid): MockSolid {
  const op = request.op as { kind?: string; steps?: { kind?: string; radius?: number; depth?: number }[] };
  const steps = op.kind === "group" && Array.isArray(op.steps) ? op.steps : [];
  const removed = steps.reduce((sum, step) => sum + (step.kind === "hole" && typeof step.radius === "number" ? Math.PI * step.radius * step.radius * Math.abs(step.depth ?? 0) : 0), 0);
  return { ...parent, volumeMm3: parent.volumeMm3 - removed };
}

async function start(page: Page): Promise<TreeMock> {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid().positions, seatMm: 0 } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => boxSolid(),
    apply: drilled,
    probe: () => ({ ok: true }),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelEmptySketch")).toBeVisible();
  return tree;
}

async function newSketch(page: Page) {
  await page.locator("#modelEmptySketch").click();
  await expect(page.locator("#model")).toHaveAttribute("data-sketch", "editing");
}

/** A chain of lines from `at`, each typed as a length and an angle. */
async function drawChain(page: Page, at: { x: number; y: number }, legs: [string, string][]) {
  const canvas = page.locator("#model");
  await page.locator("[data-sketch-tool=line]").click();
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "line");
  await page.mouse.click(at.x, at.y);
  await page.mouse.move(at.x + 30, at.y);
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  for (const [length, angle] of legs) {
    await hud.locator("input").nth(0).fill(length);
    await hud.locator("input").nth(0).press("Tab");
    await hud.locator("input").nth(1).fill(angle);
    await hud.locator("input").nth(1).press("Enter");
  }
  await page.keyboard.press("Escape");
}

async function drawCircle(page: Page, at: { x: number; y: number }, diameter: string) {
  await page.mouse.click(at.x, at.y);
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  await hud.locator("input").nth(0).fill(diameter);
  await hud.locator("input").nth(0).press("Enter");
}

async function facePoint(page: Page, want: (normal: number[]) => boolean): Promise<{ x: number; y: number }> {
  let found: { x: number; y: number } | null = null;
  await expect.poll(async () => {
    const text = (await page.locator("#model").getAttribute("data-faces")) ?? "";
    const box = await page.locator("#model").boundingBox();
    if (!box) return "";
    for (const item of text.split(" ").filter(Boolean)) {
      const [, xy, normalText] = item.split(":");
      if (!want(normalText!.split(",").map(Number))) continue;
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

const shots = process.env.LIME_SHOTS;

test("S3: an L-shaped route sweeps in one Apply, its corner rounded at the circle's radius", async ({ page }) => {
  const tree = await start(page);
  await newSketch(page);
  const canvas = page.locator("#model");
  const box = (await canvas.boundingBox())!;
  await page.locator("[data-sketch-tool=circle]").click();
  await drawCircle(page, { x: box.x + box.width * 0.3, y: box.y + box.height * 0.5 }, "6");
  await drawChain(page, { x: box.x + box.width * 0.38, y: box.y + box.height * 0.5 }, [["30", "0"], ["20", "90"]]);
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "circle,line,line");

  await page.keyboard.press("W");
  await expect(canvas).toHaveAttribute("data-sweep-made", "up");
  await expect(canvas, "Round corners is on, at the circle's 3 mm radius").toHaveAttribute("data-sweep-round", "3");
  const round = page.locator("button[data-sketch-round]");
  await expect(round).toHaveText("Round corners");
  await expect(round).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("input[data-sketch-round-radius]")).toHaveValue("3");
  await expect(page.locator("button[data-sketch-apply]")).toHaveAttribute("aria-disabled", "false");
  await expect(canvas, "the rounded route has no sharp corner to mark").not.toHaveAttribute("data-sketch-marks-kind", "sharp");
  if (shots) await page.screenshot({ path: `${shots}/s3-round-corners.png` });

  // Off, the sharp corner is refused again, with its red dot and a reason that points back to the button.
  await round.click();
  await expect(canvas).toHaveAttribute("data-sweep-round", "off");
  await expect(canvas).toHaveAttribute("data-sketch-marks-kind", "sharp");
  await expect(page.locator("#modelReadout")).toContainText("Click Round corners");
  if (shots) await page.screenshot({ path: `${shots}/s3-round-off.png` });
  await page.locator("button[data-sketch-round]").click();
  await expect(canvas).toHaveAttribute("data-sweep-round", "3");

  // A wider bend is typed; the smallest comes back when the field is cleared. Enter in the field applies what it says.
  const radius = page.locator("input[data-sketch-round-radius]");
  // Typed key by key, as a person types: the size box doesn't take the keys from the field.
  await radius.press("Control+a");
  await radius.pressSequentially("6");
  await expect(canvas).toHaveAttribute("data-sweep-round", "6");
  await expect(radius).toBeFocused();
  await radius.fill("");
  await expect(canvas).toHaveAttribute("data-sweep-round", "3");
  await radius.pressSequentially("5");
  await expect(canvas).toHaveAttribute("data-sweep-round", "5");
  await radius.press("Enter");
  await expect(page.locator("#objectList .obj").first()).toContainText("Sweep 1");
  const feature = tree.of("open").at(-1)!.feature as { kind?: string; sections?: LoftSection[] };
  expect(feature.kind).toBe("loft");
  expect((feature.sections?.length ?? 0) >= 4, "sections along the line, the arc and the second line").toBe(true);

  // The sketch keeps the arc Round corners added, as Fillet corner would have.
  await expect(canvas).toHaveAttribute("data-sketch", "pinned");
  await page.locator("[data-sketch-open]").first().click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "circle,line,line,arc");
});

test("S3: a pipe along an L rounds at its radius, and a wider pipe rounds wider", async ({ page }) => {
  const tree = await start(page);
  await newSketch(page);
  const canvas = page.locator("#model");
  const box = (await canvas.boundingBox())!;
  await drawChain(page, { x: box.x + box.width * 0.4, y: box.y + box.height * 0.55 }, [["30", "0"], ["25", "90"]]);
  await page.keyboard.press("W");
  await expect(canvas).toHaveAttribute("data-sweep-made", "pipe");
  await expect(canvas, "the default 5 mm pipe rounds at 2.5").toHaveAttribute("data-sweep-round", "2.5");
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").nth(0).fill("8");
  await expect(canvas, "an 8 mm pipe rounds at 4").toHaveAttribute("data-sweep-round", "4");
  await hud.locator("input").nth(0).press("Enter");
  await expect(page.locator("#objectList .obj").first()).toContainText("Sweep 1");
  const feature = tree.of("open").at(-1)!.feature as { kind?: string };
  expect(feature.kind).toBe("loft");
});

test("H1: Start on a face from a bed sketch, then H with nothing selected drills all three circles after one Yes", async ({ page }) => {
  const tree = await start(page);
  await newSketch(page);
  const canvas = page.locator("#model");
  await page.locator("[data-sketch-tool=rectangle]").click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").nth(0).fill("12");
  await hud.locator("input").nth(0).press("Tab");
  await hud.locator("input").nth(1).fill("8");
  await hud.locator("input").nth(1).press("Enter");
  await page.keyboard.press("E");
  await hud.locator("input").first().fill("10");
  await hud.locator("input").first().press("Enter");
  await expect(page.locator("#modelHistoryTree")).toContainText("Extrude");

  // Where the top face is on screen: leaving the bed sketch for a face puts this view back.
  const top = await facePoint(page, (normal) => normal[2]! > 0.5);

  // A sketch on the bed: Holes is greyed with the reason, and Start on a face sits beside it.
  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=XY]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  const holes = page.getByRole("button", { name: "Holes (H)" });
  await expect(holes).toHaveAttribute("aria-disabled", "true");
  await expect(holes).toHaveAttribute("data-reason", "Holes go into a face. Click Start on a face, then draw points or circles where the holes go.");
  const startOnFace = page.locator("button[data-sketch-face-start]");
  await expect(startOnFace).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/h1-start-on-face.png` });
  await startOnFace.click();
  await expect(canvas).toHaveAttribute("data-sketch", "choosing");
  await expect(page.locator("#sketchCards")).toContainText("Click a face of the part to draw the holes on.");
  await expect(page.locator("#modelReadout")).toContainText("Click a face of the part to draw the holes on.");
  await expect(canvas).toHaveAttribute("data-sketch-camera", "free");
  await page.mouse.click(top.x, top.y);
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-sketch-plane", "face 1");

  await page.locator("[data-sketch-tool=circle]").click();
  const view = (await canvas.boundingBox())!;
  for (const spot of [[0.42, 0.48], [0.55, 0.55], [0.68, 0.42]] as const) await drawCircle(page, { x: view.x + view.width * spot[0], y: view.y + view.height * spot[1] }, "4");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "circle,circle,circle");
  await expect(holes, "with nothing selected Holes asks, so it isn't greyed").toHaveAttribute("aria-disabled", "false");

  await page.keyboard.press("H");
  const ask = page.locator("[data-sketch-section=drill]");
  await expect(ask).toContainText("Drill at every point and circle centre in this sketch?");
  const yes = page.locator("button[data-sketch-drill-yes]");
  await expect(yes).toHaveText("Yes, drill 3 holes");
  await expect(yes).toBeFocused();
  const sideways = await page.locator("#sketchCards").evaluate((node) => {
    let total = 0;
    // The card and the docks around it: none wider than it shows, and none scrolled.
    for (let at: HTMLElement | null = node as HTMLElement; at && at !== document.body; at = at.parentElement) total += at.scrollLeft + Math.max(0, at.scrollWidth - at.clientWidth - 1);
    return total;
  });
  expect(sideways, "the question fits the card: nothing scrolls sideways").toBe(0);
  if (shots) await page.screenshot({ path: `${shots}/h1-drill-every.png` });
  await yes.click();
  await expect(page.locator("#modelPanel")).toBeVisible();
  await expect(page.locator("#modelHolePoints")).toHaveText("One hole at each of 3 points.");
  await expect(canvas).toHaveAttribute("data-sketch-holes", "3");
  await page.locator("#modelHoleR").fill("4");
  await page.locator("#modelHoleD").fill("8");
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelHistoryTree")).toContainText("3 holes ⌀4 depth 8");
  const applied = tree.of("apply").at(-1)!.op as { kind?: string; steps?: { kind?: string }[] };
  expect(applied.kind).toBe("group");
  expect(applied.steps).toHaveLength(3);
});

test("H1: No keeps the sketch and says how to pick the holes", async ({ page }) => {
  await start(page);
  await newSketch(page);
  const canvas = page.locator("#model");
  await page.locator("[data-sketch-tool=rectangle]").click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").nth(0).fill("12");
  await hud.locator("input").nth(0).press("Tab");
  await hud.locator("input").nth(1).fill("8");
  await hud.locator("input").nth(1).press("Enter");
  await page.keyboard.press("E");
  await hud.locator("input").first().fill("10");
  await hud.locator("input").first().press("Enter");
  const top = await facePoint(page, (normal) => normal[2]! > 0.5);
  await page.mouse.click(top.x, top.y);
  await page.locator("#modelContextBar").getByRole("button", { name: "Sketch on face" }).click();
  await expect(canvas).toHaveAttribute("data-sketch-plane", "face 1");
  await page.locator("[data-sketch-tool=circle]").click();
  const view = (await canvas.boundingBox())!;
  await drawCircle(page, { x: view.x + view.width * 0.5, y: view.y + view.height * 0.5 }, "4");
  await page.keyboard.press("H");
  await expect(page.locator("button[data-sketch-drill-yes]")).toHaveText("Yes, drill 1 hole");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-sketch-section=drill]")).toHaveCount(0);
  await expect(page.locator("#modelReadout")).toContainText("Select the points or circles where the holes go.");
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(page.locator("#modelPanel")).toBeHidden();
});

test("V1: a revolve is made with no hover, by clicking a listed axis", async ({ page }) => {
  const tree = await start(page);
  await newSketch(page);
  const canvas = page.locator("#model");
  const box = (await canvas.boundingBox())!;
  await page.locator("[data-sketch-tool=rectangle]").click();
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.45);
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").nth(0).fill("10");
  await hud.locator("input").nth(0).press("Tab");
  await hud.locator("input").nth(1).fill("6");
  await hud.locator("input").nth(1).press("Enter");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "4");

  await page.locator("button[data-sketch-revolve]").click();
  await expect(canvas).toHaveAttribute("data-revolve", "aim");
  const axes = page.locator("[role=group][aria-label='Spin around']");
  await expect(axes).toContainText("Spin around:");
  const labels = await axes.locator("button").allTextContents();
  expect(labels.slice(0, 4), "the shape's sides, then the plane's axes").toEqual(["the shape's left side", "the shape's right side", "the shape's bottom", "the shape's top"]);
  expect(labels).toContain("the vertical axis (Y)");

  await axes.getByRole("button", { name: "the shape's left side" }).click();
  await expect(axes.getByRole("button", { name: "the shape's left side" })).toHaveAttribute("aria-pressed", "true");
  if (shots) {
    // Off the buttons, on the dock's empty part, so no tip covers the list.
    await page.mouse.move(190, 940);
    await page.screenshot({ path: `${shots}/v1-axis-buttons.png` });
  }
  await expect(canvas).toHaveAttribute("data-revolve-axis", "line");
  await page.locator("button[data-sketch-apply]").click();
  await expect(page.locator("#objectList .obj").first()).toContainText("Revolve 1");
  const feature = tree.of("open").at(-1)!.feature as { kind?: string; axisDir?: number[]; axisOrigin?: number[] };
  expect(feature.kind).toBe("revolve");
  expect(Math.abs(feature.axisDir?.[0] ?? 1), "a vertical axis").toBeLessThan(1e-6);
  expect(feature.axisOrigin?.[0] ?? 0, "on the shape's left side, right of the origin").toBeGreaterThan(0);
});
