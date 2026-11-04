import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";

// Text with real fonts (docs/plan-text-on-curves-and-fonts.md, milestone 1): the Text card's font picker, styles, text box, live
// preview and thin-letter note, against the mocked engine. The kernel's side is crates/lime-model-occt/tests/lettering.rs.

type V = [number, number, number];

/** A 20 × 20 × 10 box from the origin. Face 1 is the top. */
function boxSolid(volumeMm3 = 4000): MockSolid {
  const c = (x: number, y: number, z: number): V => [x * 20, y * 20, z * 10];
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
  return { volumeMm3, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 400 })), edges: [] };
}

/** The mock's layout: a 5 mm square for every letter, and the letters "i", "e" and "m" too thin for any line. */
function layoutOf(request: Body): Body {
  const text = String(request.text ?? "");
  const letters = [...text].filter((ch) => ch.trim());
  const faces = letters.map((ch, index) => ({
    ch,
    loops: [[[index * 6, 0], [index * 6 + 5, 0], [index * 6 + 5, 5], [index * 6, 5]]],
    thin: "iem".includes(ch),
  }));
  const thin = [...new Set(letters.filter((ch) => "iem".includes(ch)))].map((ch) => ({ ch, lostPct: 40 }));
  const names = thin.map((t) => t.ch);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
  const line = request.lineMm ?? 0.4;
  return {
    ok: true,
    font: request.font,
    faces,
    widths: [letters.length * 6],
    bounds: [0, 0, letters.length * 6, 5],
    inkMm2: letters.length * 25,
    thin,
    thinNote: names.length ? `${list} ${names.length === 1 ? "is" : "are"} thinner than your ${String(line)} mm line. Use a larger size, Bold, or another font.` : null,
  };
}

async function openModel(page: Page): Promise<TreeMock> {
  const root = boxSolid();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: root.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => root,
    apply: (_request: Body, parent: MockSolid) => boxSolid(parent.volumeMm3 + 12),
    probe: () => ({ ok: true }),
    textLayout: layoutOf,
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  return tree;
}

async function pickFace(page: Page) {
  const [x, y, w, h] = ((await page.locator("#model").getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  const box = (await page.locator("#model").boundingBox())!;
  await page.mouse.click(box.x + x! + w! * 0.5, box.y + y! + h! * 0.5);
}

async function openText(page: Page) {
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelFeatureMenu [data-tool=text]").click();
  await expect(page.locator("#modelToolFeatures")).toHaveAttribute("data-tool", "text");
  await pickFace(page);
  await expect(page.locator("#modelApply")).toBeEnabled();
}

/** Type into the text box, replacing what is there. */
async function typeText(page: Page, text: string) {
  await page.locator("#modelFeatText").fill(text);
  await page.locator("#modelFeatText").dispatchEvent("input");
}

test("the Text card starts in Sans Bold, and the picker draws each font's name in that font", async ({ page }) => {
  await openModel(page);
  await openText(page);
  const buttons = page.locator("#modelTextFont [data-font]");
  await expect(buttons).toHaveCount(5);
  await expect(buttons.nth(0)).toHaveText("Stroke");
  await expect(buttons.nth(1)).toHaveText("Inter");
  expect(await buttons.evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.font))).toEqual(["stroke", "sans@4.0", "mono@1", "serif@1", "stencil@1"]);
  expect(await buttons.evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).fontFamily.replace(/["']/g, "").split(",")[0]))).toEqual([
    expect.any(String), "Lime Model Sans", "Lime Model Mono", "Lime Model Serif", "Lime Model Stencil",
  ]);
  // D4: a new text starts in Sans Bold.
  await expect(page.locator("#modelTextFont [data-font='sans@4.0']")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelTextStyle [data-style=bold]")).toHaveAttribute("aria-pressed", "true");
  // The sample line is the person's own text, in the font and weight chosen.
  await typeText(page, "Lime Slice");
  const sample = page.locator("#modelTextSample");
  await expect(sample).toHaveText("Lime Slice");
  expect(await sample.evaluate((n) => [getComputedStyle(n).fontFamily.replace(/["']/g, "").split(",")[0], getComputedStyle(n).fontWeight, getComputedStyle(n).fontStyle])).toEqual(["Lime Model Sans", "700", "normal"]);
  await page.locator("#modelTextStyle [data-style=italic]").click();
  expect(await sample.evaluate((n) => [getComputedStyle(n).fontWeight, getComputedStyle(n).fontStyle])).toEqual(["400", "italic"]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "test-results/text-fonts/card-sans.png" });
});

test("a font with no bold greys Bold and says why, and the stroke font has its own fields", async ({ page }) => {
  await openModel(page);
  await openText(page);
  await page.locator("#modelTextFont [data-font='stencil@1']").click();
  await expect(page.locator("#modelTextStyle [data-style=bold]")).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator("#modelTextStyle [data-style=bold-italic]")).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator("#modelTextStyle [data-style=bold]")).toHaveAttribute("data-tip", "Allerta Stencil has no bold. Pick Regular, or another font.");
  await expect(page.locator("#modelTextStyle [data-style=italic]")).toHaveAttribute("data-tip", /slanted 12°/);
  // The bold it had goes back to Regular, not to a refusal.
  await expect(page.locator("#modelTextStyle [data-style=regular]")).toHaveAttribute("aria-pressed", "true");
  // Clicking the greyed one changes nothing and says why.
  await page.locator("#modelTextStyle [data-style=bold]").click({ force: true });
  await expect(page.locator("#modelTextStyle [data-style=regular]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Allerta Stencil has no bold. Pick Regular, or another font.")).toBeVisible();
  await expect(page.locator("#modelNote")).not.toContainText("no bold");

  await expect(page.locator("#modelTextTrack")).toBeVisible();
  await expect(page.locator("#modelTextLines")).toBeVisible();
  await expect(page.locator("#modelTextStroke")).toBeHidden();
  await page.locator("#modelTextFont [data-font=stroke]").click();
  await expect(page.locator("#modelTextStroke")).toBeVisible();
  await expect(page.locator("#modelTextSpace")).toBeVisible();
  await expect(page.locator("#modelTextTrack")).toBeHidden();
  await expect(page.locator("#modelTextLines")).toBeHidden();
  await expect(page.locator("#modelTextStyle")).toBeHidden();
  await expect(page.locator("#modelTextAlign [data-align=right]")).toBeHidden();
});

test("two lines in a font are one lettering step, one history row, and Edit reopens the card", async ({ page }) => {
  const tree = await openModel(page);
  await openText(page);
  await page.locator("#modelTextFont [data-font='mono@1']").click();
  await page.locator("#modelTextAlign [data-align=right]").click();
  await page.locator("#modelTextTrack").fill("0.3");
  await page.locator("#modelTextTrack").dispatchEvent("input");
  // Enter in the text box is a new line; it does not apply.
  await page.locator("#modelFeatText").click();
  await page.locator("#modelFeatText").selectText();
  await page.keyboard.type("LOT 42");
  await page.keyboard.press("Enter");
  await page.keyboard.type("SN 7");
  await expect(page.locator("#modelFeatText")).toHaveValue("LOT 42\nSN 7");
  expect(tree.of("apply").length, "Enter did not apply").toBe(0);
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.keyboard.press("Control+Enter");
  await expect(page.locator("#modelReadout")).toContainText("Volume 4012 mm³");
  await expect(page.locator("#modelHistoryTree [role=treeitem]")).toHaveCount(2);
  await expect(page.locator("#modelHistoryTree [role=treeitem]").nth(1)).toContainText("Text LOT 42");

  const op = tree.of("apply").at(-1)!.op as { kind: string; steps: Body[]; source: Body };
  expect(op.kind).toBe("group");
  expect(op.steps, "one step, not a box per stroke").toHaveLength(1);
  expect(op.steps[0]).toMatchObject({ kind: "lettering", op: "fuse", text: "LOT 42\nSN 7", font: "mono@1", spacing: 0.3, align: "right", height: 6 });
  expect(op.steps[0]!.origin, "on the picked face's plane").toHaveLength(3);
  expect(op.steps[0]).toMatchObject({ style: "bold" });
  expect(op.source).toMatchObject({ kind: "text", font: "mono@1", style: "bold", align: "right", spacing: 0.3 });
  expect(op.source.strokeWidth, "no stroke fields for an outline font").toBeUndefined();

  await page.keyboard.press("Shift+E");
  await expect(page.locator("#modelApply")).toHaveText("Update");
  await expect(page.locator("#modelTextFont [data-font='mono@1']")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelTextAlign [data-align=right]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelFeatText")).toHaveValue("LOT 42\nSN 7");
  await expect(page.locator("#modelTextTrack")).toHaveValue("0.3");
  await expect(page.locator("#modelTextStyle [data-style=bold]")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#modelTextFont [data-font='sans@4.0']").click();
  await page.locator("#modelTextStyle [data-style=italic]").click();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect.poll(() => tree.of("edit").length).toBe(1);
  const edited = tree.of("edit").at(-1)!.op as { steps: Body[] };
  expect(edited.steps[0]).toMatchObject({ kind: "lettering", font: "sans@4.0", style: "italic" });
});

test("the card names the letters too thin for the nozzle and draws the preview", async ({ page }) => {
  const tree = await openModel(page);
  await openText(page);
  await typeText(page, "HOT 2026");
  await expect(page.locator("#modelTextThin")).toBeHidden();
  await typeText(page, "Lime Slice");
  await expect(page.locator("#modelTextThin")).toHaveText("i, m and e are thinner than your 0.4 mm line. Use a larger size, Bold, or another font.");
  const asked = tree.of("textLayout").at(-1)!;
  expect(asked).toMatchObject({ text: "Lime Slice", font: "sans@4.0", style: "bold", height: 6, lineMm: 0.4 });
  // The ghost: letters as a prism on the face, the thin ones apart.
  await expect(page.locator("#model")).toHaveAttribute("data-ghost-tone", "add");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "test-results/text-fonts/card-thin.png" });
  // Engraved, the same text is the cut's colour; a font that lacks a letter is the engine's sentence.
  await page.locator("#modelTextOp [data-op=cut]").click();
  await expect(page.locator("#model")).toHaveAttribute("data-ghost-tone", "cut");
  await expect(page.locator("#modelApply")).toBeEnabled();
});

test("the stroke font still builds the boxes it always did, from the same card", async ({ page }) => {
  const tree = await openModel(page);
  await openText(page);
  await page.locator("#modelTextFont [data-font=stroke]").click();
  await typeText(page, "LIME");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelHistoryTree [role=treeitem]")).toHaveCount(2);
  const op = tree.of("apply").at(-1)!.op as { steps: Body[]; source: Body };
  expect(op.steps.length).toBeGreaterThan(8);
  expect(op.steps.every((step) => step.kind === "boolean" && step.primitive === "box")).toBe(true);
  expect(op.source.font, "an old text step has no font").toBeUndefined();
  expect(op.source.strokeWidth).toBe(0.9);
});
