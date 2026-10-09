import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
// The engine's reply for the same cube on a 45° belt: layer z is the belt
// position, 40 mm at the top. Regenerate with the ignored test in
// crates/lime-slice-core/tests/e2e_fixtures.rs.
const beltCube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-belt.json"), "utf8"));

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
}

async function share(page: Page, selector: string) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height, viewW: window.innerWidth, viewH: window.innerHeight };
  }, selector);
  expect(box, selector).not.toBeNull();
  return canvasShare({ width: box!.width, height: box!.height }, { width: box!.viewW, height: box!.viewH });
}

test("a belt printer sends belt settings and a cartesian printer does not", async ({ page }) => {
  await quiet(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/slice", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    await route.fulfill({ json: body.belt ? beltCube : cube });
  });
  await page.goto("/");
  await page.locator("#machineKind").selectOption("belt");
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt", "1");
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt-plane", "1");
  await expect(page.locator("#beltAngle")).toHaveValue("45");
  await expect(page.locator("#beltFields")).toBeVisible();
  await expect(page.locator("#beltSeam")).not.toBeChecked();
  await expect(page.locator("#beltFloor")).toHaveCount(0);
  await expect(page.locator("#beltRaft")).not.toBeChecked();
  await expect(page.locator("#beltRaftLayers")).toBeDisabled();
  // Before any slice, so a toggle back to a sliced recipe cannot refresh it by itself.
  await page.locator("#supports").check();
  await expect(page.locator("#beltRaft")).toBeDisabled();
  await expect(page.locator("label:has(#beltRaft)")).toHaveAttribute("data-tip", /Smart supports are on/);
  await page.locator("#supports").uncheck();
  await expect(page.locator("#beltRaft")).toBeEnabled();
  await expect(page.locator("label:has(#beltRaft)")).not.toHaveAttribute("data-tip");
  await expect(page.getByText("Mock only")).toHaveCount(0);
  await page.locator("#beltCopies").fill("3");
  await page.locator("#beltCopies").blur();
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt-copies", "3");

  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  const belt = bodies[0].belt as Record<string, unknown>;
  expect(belt.angleDeg).toBe(45);
  expect(belt.axis).toBe("z");
  expect(belt.direction).toBe(1);
  expect(belt.copies).toBe(3);
  expect(belt).not.toHaveProperty("maxLengthMm");
  expect(belt).not.toHaveProperty("seamOnEdge");
  expect(belt).not.toHaveProperty("raftLayers");
  expect(belt).not.toHaveProperty("floorSupports");
  expect(bodies[0].printer).not.toHaveProperty("belt");
  await expect(page.locator("#banner")).not.toContainText("Mock");
  await expect(page.locator("#export")).toBeEnabled();
  await expect(page.locator("#sendPrinter")).toBeDisabled();
  await expect(page.locator("#sendPrinter")).toHaveAttribute("data-tip", /Prusa Link/);
  await page.locator("#tabPreview").click();
  await expect(page.locator("#beltMockTag")).toHaveCount(0);
  await expect(page.locator("#readHigh")).toHaveText(`Z ${beltCube.layers.at(-1).z.toFixed(2)}`);
  await expect(page.locator("#readHigh")).toHaveText("Z 40.00");

  await page.locator("#tabPrepare").click();
  await page.locator("#supports").check();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(2);
  expect((bodies[1].belt as Record<string, unknown>).floorSupports).toBe(true);
  await page.locator("#supports").uncheck();
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[2].belt).not.toHaveProperty("floorSupports");
  await expect(page.locator("#export")).toBeEnabled();
  await page.locator("#beltRaft").check();
  await expect(page.locator("#supports")).toBeDisabled();
  await expect(page.locator("label:has(#supports)")).toHaveAttribute("data-tip", /raft holds the part/);
  await expect(page.locator("#beltRaftLayers")).toBeEnabled();
  await page.locator("#beltRaftLayers").fill("2");
  await page.locator("#beltRaftLayers").blur();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(4);
  const rafted = bodies[3].belt as Record<string, unknown>;
  expect(rafted.raftLayers).toBe(2);
  expect(rafted).not.toHaveProperty("floorSupports");
  await page.locator("#machineKind").selectOption("cartesian");
  await expect(page.locator("#beltFields")).toBeHidden();
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt", "0");
  await expect(page.locator("#supports")).toBeEnabled();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(5);
  expect(bodies[4]).not.toHaveProperty("belt");
  await expect(page.locator("#export")).toBeEnabled();
});

test("a belt raft that is on can be unticked even with Smart supports on", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await page.locator("#machineKind").selectOption("belt");
  await page.locator("#beltRaft").check();
  // Smart supports are a cartesian setting until the printer is a belt again.
  await page.locator("#machineKind").selectOption("cartesian");
  await page.locator("#supports").check();
  await page.locator("#machineKind").selectOption("belt");
  await expect(page.locator("#beltRaft")).toBeChecked();
  await expect(page.locator("#beltRaft")).toBeEnabled();
  await page.locator("#beltRaft").uncheck();
  await expect(page.locator("#supports")).toBeEnabled();
});

test("the generic belt printer is one pick in the printer list", async ({ page }) => {
  await quiet(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/slice", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    await route.fulfill({ json: body.belt ? beltCube : cube });
  });
  await page.goto("/");
  await expect(page.locator("#beltFields")).toBeHidden();
  await page.locator("#machinePrinter").selectOption({ label: "Generic belt 45°" });
  await expect(page.locator("#machineKind")).toHaveValue("belt");
  await expect(page.locator("#beltFields")).toBeVisible();
  await expect(page.locator("#beltAngle")).toHaveValue("45");
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt", "1");

  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect((bodies[0].belt as Record<string, unknown>).angleDeg).toBe(45);

  await page.locator("#machinePrinter").selectOption("lime-220");
  await expect(page.locator("#beltFields")).toBeHidden();
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt", "0");
});

test("a belt edit is one undo step", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await page.locator("#machineKind").selectOption("belt");
  await expect(page.locator("#beltAngle")).toHaveValue("45");
  await page.locator("#beltAngle").fill("35");
  await page.locator("#beltAngle").blur();
  await page.waitForTimeout(400);
  await expect(page.locator("#undoEdit")).toBeEnabled();
  await page.locator("#undoEdit").click();
  await expect(page.locator("#beltAngle")).toHaveValue("45");
  await page.locator("#redoEdit").click();
  await expect(page.locator("#beltAngle")).toHaveValue("35");
});

test.describe("belt fields stay in the sheet", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a belt printer keeps the prepare canvas", async ({ page }) => {
    await quiet(page);
    await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    const before = await share(page, "#prepare");
    expect(before).toBeGreaterThanOrEqual(0.7);

    await page.locator("#compactTabs [data-tab=settings]").click();
    await page.locator("#machineKind").selectOption("belt");
    await expect(page.locator("#beltFields")).toBeVisible();
    await page.locator("#compactTabs [data-tab=prepare]").click();
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    await page.waitForTimeout(250);
    await expect(page.locator("#prepare")).toHaveAttribute("data-belt", "1");
    await expect(page.locator("#prepare")).toHaveAttribute("data-belt-plane", "1");
    const after = await share(page, "#prepare");
    expect(after, `prepare share ${after}`).toBeGreaterThanOrEqual(0.7);
  });
});

// overhang_ledge on a 45° belt with floor supports. The skeleton is in the reply frame and
// `ls` names the preview layer each knot prints on; site ids stay in the slice frame.
const beltLedge = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/ledge-belt-skeleton.json"), "utf8"));

test("a belt printer's supports can be picked and pruned", async ({ page }) => {
  await quiet(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/slice", async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ json: beltLedge });
  });
  await page.goto("/");
  await page.locator("#machineKind").selectOption("belt");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="overhang_ledge.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#supports").check();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect((bodies[0].belt as Record<string, unknown>).floorSupports).toBe(true);
  expect(bodies[0].includeSkeleton).toBe(true);
  await page.locator("#tabPreview").click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await expect(page.locator("#readHigh")).toHaveText(`Z ${beltLedge.layers.at(-1).z.toFixed(2)}`);

  await page.keyboard.press("e");
  const readout = page.locator("#supportReadout");
  await expect(readout).toHaveText("Click a support. Shift-click takes the whole tree.");
  await page.locator('#supportEditbar [data-scope="tree"]').click();
  await expect(page.locator("#pane3d")).toHaveAttribute("data-gaps", "0");
  await expect(page.locator("#supportEdits")).not.toContainText("isn't available on a belt printer");

  // Hide everything below belt z 12. Limb 1's top knot prints on layer 14.99 but sits at lab height 11.35,
  // so only a test of the knot's layer keeps it in view.
  const low = beltLedge.layers.findIndex((layer: { z: number }) => layer.z >= 12);
  await page.locator("#rangeLow").evaluate((el: HTMLInputElement, value: number) => {
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, low);

  // Sweep the view with pointer moves until the one-tip tree (limb 1) is under the pointer.
  const at = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#view3d")!;
    const label = document.querySelector("#supportReadout")!;
    const box = canvas.getBoundingClientRect();
    for (let y = box.top + 2; y < box.bottom; y += 4) {
      for (let x = box.left + 2; x < box.right; x += 4) {
        canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, buttons: 0, bubbles: true }));
        if (label.textContent === "Tree · 1 tip") return { x, y };
      }
    }
    return null;
  });
  expect(at, "a support under the pointer somewhere in the view").not.toBeNull();
  await page.mouse.click(at!.x, at!.y);
  await expect(readout).toHaveText("Tree · 1 tip");
  await expect(page.getByRole("button", { name: "Delete tree" })).toBeEnabled();

  await page.getByRole("button", { name: "Delete tree" }).click();
  await expect.poll(() => bodies.length).toBe(2);
  const s = beltLedge.skeleton;
  expect(bodies[1].supportEdits).toEqual([{ kind: "prune", sites: [{ xy: [s.siteX[0], s.siteY[0]], z: s.siteZ[0] }] }]);
  await expect(page.locator("#supportEdits li[data-edit]")).toHaveCount(1);
});

// The same ledge after a prune of its largest tree, which leaves a gap. `z`, `min`, `max`, and `outline` are in the
// slice frame, where a regrow runs; `tilted` is where the preview draws it. Regenerate with the ignored test in
// crates/lime-slice-core/tests/e2e_fixtures.rs.
const beltLedgePruned = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/ledge-belt-pruned.json"), "utf8"));

test("a belt printer draws the gap a prune left and regrows it by the slice-frame region", async ({ page }) => {
  await quiet(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const gap = beltLedgePruned.supportEdits[0].floating[0];
  expect(gap.tilted, "the fixture's gap says where the preview draws it").toBeTruthy();
  // The tree the fixture pruned: the one with the most tips.
  const s = beltLedge.skeleton;
  const live = (root: number) => s.tree.filter((t: number, k: number) => t === root && s.live[k] === 1).length;
  const root = [...s.tree].sort((a: number, b: number) => live(b) - live(a))[0];
  const tips = live(root);
  expect(tips).toBeGreaterThan(1);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/slice", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    const edits = (body.supportEdits ?? []) as { kind: string }[];
    if (edits.some((edit) => edit.kind === "regrow")) {
      const held = { status: "applied", changedLayers: 3, newlyFloatingMm2: -gap.areaMm2, floating: [] };
      return route.fulfill({ json: { ...beltLedgePruned, coverage: [], supportEdits: [beltLedgePruned.supportEdits[0], held] } });
    }
    await route.fulfill({ json: edits.length ? beltLedgePruned : beltLedge });
  });
  await page.goto("/");
  await page.locator("#machineKind").selectOption("belt");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="overhang_ledge.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#supports").check();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  await page.locator("#tabPreview").click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await expect(page.locator("#readHigh")).toHaveText(`Z ${beltLedge.layers.at(-1).z.toFixed(2)}`);

  await page.keyboard.press("e");
  await page.locator('#supportEditbar [data-scope="tree"]').click();
  await expect(page.locator("#pane3d")).toHaveAttribute("data-gaps", "0");
  const readout = page.locator("#supportReadout");
  // The sweep moves the pointer over the view until the readout names what is under it.
  const sweep = (label: string) =>
    page.evaluate((want) => {
      const canvas = document.querySelector<HTMLCanvasElement>("#view3d")!;
      const text = document.querySelector("#supportReadout")!;
      const box = canvas.getBoundingClientRect();
      for (let y = box.top + 2; y < box.bottom; y += 3) {
        for (let x = box.left + 2; x < box.right; x += 3) {
          canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, buttons: 0, bubbles: true }));
          if (text.textContent?.startsWith(want)) return { x, y };
        }
      }
      return null;
    }, label);
  const tree = await sweep(`Tree · ${tips} tips`);
  expect(tree, "the largest tree under the pointer somewhere in the view").not.toBeNull();
  await page.mouse.click(tree!.x, tree!.y);
  await page.getByRole("button", { name: "Delete tree" }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1].supportEdits).toHaveLength(1);

  // The gap is listed by its layers' belt positions, which the layer slider shows, not by the nozzle plane's height.
  await expect(page.locator("#pane3d")).toHaveAttribute("data-gaps", "1");
  const row = page.locator("#supportEdits li.se-gap");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(`Z ${gap.tilted.ls[0].toFixed(2)}–${gap.tilted.ls[1].toFixed(2)}`);
  await expect(page.locator("#supportEdits")).not.toContainText("isn't available on a belt printer");
  await expect(row.getByRole("button", { name: "Regrow" })).toBeEnabled();

  // Above the gap's top layer the slider hides it, and nothing is under the pointer.
  const above = beltLedgePruned.layers.findIndex((layer: { z: number }) => layer.z > gap.tilted.ls[1] + 0.01);
  await page.locator("#rangeLow").evaluate((el: HTMLInputElement, value: number) => {
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, above);
  expect(await sweep("Unheld"), "a gap whose top layer is under the slider").toBeNull();
  await page.locator("#rangeLow").evaluate((el: HTMLInputElement) => {
    el.value = "0";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // It is drawn on the tilted layer: the pointer finds it where the preview shows it.
  const found = await sweep("Unheld");
  expect(found, "the gap under the pointer somewhere in the view").not.toBeNull();
  await page.mouse.click(found!.x, found!.y);
  await expect(readout).toHaveText(new RegExp(`^Unheld · ${gap.areaMm2.toFixed(1)} mm² · Z ${gap.tilted.ls[0].toFixed(2)}`));

  // Regrow sends the slice-frame region and z, as they came, after the prune.
  await page.getByRole("button", { name: "Regrow here" }).click();
  await expect.poll(() => bodies.length).toBe(3);
  const edits = bodies[2].supportEdits as Record<string, unknown>[];
  expect(edits).toHaveLength(2);
  expect(edits[0].kind).toBe("prune");
  const [x0, y0] = gap.min;
  const [x1, y1] = gap.max;
  expect(edits[1]).toEqual({ kind: "regrow", region: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]], z: gap.z });
  expect(Math.abs(gap.z[1] - gap.tilted.ls[1])).toBeGreaterThan(1);
  await expect(page.locator("#pane3d")).toHaveAttribute("data-gaps", "0");
  await expect(page.locator("#supportEdits li[data-edit]")).toHaveCount(2);
  await expect(page.locator("#supportEdits li[data-edit]").nth(1)).toContainText(`Regrow · ${gap.areaMm2.toFixed(1)} mm²`);
});

// The same ledge printed twice, back to back. The skeleton and the gaps are the first copy's planned part, and
// `beltCopies` says how far the second copy sits along the belt, in y and in belt position. Regenerate with the ignored
// tests in crates/lime-slice-core/tests/e2e_fixtures.rs.
const beltCopies = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/ledge-belt-copies.json"), "utf8"));
const beltCopiesPruned = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/ledge-belt-copies-pruned.json"), "utf8"));

/** Moves the pointer over the 3D view until the support readout starts with `label`. */
function sweep(page: Page, label: string) {
  return page.evaluate((want) => {
    const canvas = document.querySelector<HTMLCanvasElement>("#view3d")!;
    const text = document.querySelector("#supportReadout")!;
    const box = canvas.getBoundingClientRect();
    for (let y = box.top + 2; y < box.bottom; y += 3) {
      for (let x = box.left + 2; x < box.right; x += 3) {
        canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, buttons: 0, bubbles: true }));
        if (text.textContent?.startsWith(want)) return { x, y };
      }
    }
    return null;
  }, label);
}

/** Puts the layer slider's low end on layer `index`. */
function lowLayer(page: Page, index: number) {
  return page.locator("#rangeLow").evaluate((el: HTMLInputElement, value: number) => {
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, index);
}

async function openTwoCopies(page: Page, replies: (edits: { kind: string }[]) => unknown) {
  await quiet(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/slice", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    await route.fulfill({ json: replies((body.supportEdits ?? []) as { kind: string }[]) });
  });
  await page.goto("/");
  await page.locator("#machineKind").selectOption("belt");
  await page.locator("#beltCopies").fill("2");
  await page.locator("#beltCopies").blur();
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="overhang_ledge.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#supports").check();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect((bodies[0].belt as Record<string, unknown>).copies).toBe(2);
  await page.locator("#tabPreview").click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await expect(page.locator("#readHigh")).toHaveText(`Z ${beltCopies.layers.at(-1).z.toFixed(2)}`);
  await page.keyboard.press("e");
  await page.locator('#supportEditbar [data-scope="tree"]').click();
  return bodies;
}

test("a belt printer's second copy has its supports drawn and picked like the first", async ({ page }) => {
  const bodies = await openTwoCopies(page, () => beltCopies);
  const s = beltCopies.skeleton;
  expect(beltCopies.beltCopies.count).toBe(2);
  expect(beltCopies.layers.length % 2).toBe(0);
  const second = beltCopies.layers.length / 2;
  // Copy 1 prints on the same layers, a whole shift further along the belt.
  expect(beltCopies.layers[second].z - beltCopies.layers[0].z).toBeCloseTo(beltCopies.beltCopies.shiftMm, 6);
  const pane = page.locator("#pane3d");
  await expect(pane).toHaveAttribute("data-copies", "2");

  // Hide the first copy by the layer slider, so what the pointer finds is on the second.
  await lowLayer(page, second);
  const at = await sweep(page, "Tree · 1 tip");
  expect(at, "a support of the second copy under the pointer somewhere in the view").not.toBeNull();
  await page.mouse.click(at!.x, at!.y);
  const readout = page.locator("#supportReadout");
  await expect(readout).toHaveText("Tree · 1 tip");
  await expect(page.getByRole("button", { name: "Delete tree" })).toBeEnabled();

  // The selection is drawn on every copy in view. Limb 1 is the one-tip tree: its knot pairs are its capsules.
  const pairs = s.start[1] - s.start[0] - 1;
  await expect(pane).toHaveAttribute("data-capsules", String(pairs));
  await lowLayer(page, 0);
  await expect(pane).toHaveAttribute("data-capsules", String(2 * pairs));

  // The edit is the planned part's: the first copy's sites, so every copy changes together.
  await page.getByRole("button", { name: "Delete tree" }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1].supportEdits).toEqual([{ kind: "prune", sites: [{ xy: [s.siteX[0], s.siteY[0]], z: s.siteZ[0] }] }]);
});

test("a belt printer's second copy shows the gap a prune left and regrows it", async ({ page }) => {
  const gap = beltCopiesPruned.supportEdits[0].floating[0];
  const bodies = await openTwoCopies(page, (edits) => (edits.length ? beltCopiesPruned : beltCopies));
  const pane = page.locator("#pane3d");
  const second = beltCopies.layers.length / 2;
  // Prune the largest tree, with both copies in view.
  const tree = await sweep(page, "Tree · 2 tips");
  expect(tree, "the two-tip tree under the pointer somewhere in the view").not.toBeNull();
  await page.mouse.click(tree!.x, tree!.y);
  await page.getByRole("button", { name: "Delete tree" }).click();
  await expect.poll(() => bodies.length).toBe(2);
  await expect(pane).toHaveAttribute("data-gaps", "1");
  await expect(pane).toHaveAttribute("data-gaps-drawn", "2");

  // The first copy's layers are hidden, so a gap under the pointer is the second copy's.
  await lowLayer(page, second);
  await expect(pane).toHaveAttribute("data-gaps-drawn", "1");
  const found = await sweep(page, "Unheld");
  expect(found, "the second copy's gap under the pointer somewhere in the view").not.toBeNull();
  await page.mouse.click(found!.x, found!.y);
  await expect(page.locator("#supportReadout")).toHaveText(new RegExp(`^Unheld · ${gap.areaMm2.toFixed(1)} mm²`));

  // Regrow sends the slice-frame region and z of the one planned gap.
  await page.getByRole("button", { name: "Regrow here" }).click();
  await expect.poll(() => bodies.length).toBe(3);
  const edits = bodies[2].supportEdits as Record<string, unknown>[];
  const [x0, y0] = gap.min;
  const [x1, y1] = gap.max;
  expect(edits[1]).toEqual({ kind: "regrow", region: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]], z: gap.z });
});
