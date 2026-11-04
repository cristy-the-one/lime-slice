import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";

// Text on a cylinder and a cone (docs/plan-text-on-curves-and-fonts.md, milestone 2): the Text card on a round face (Direction, Flip,
// the point the text sits on, the live preview on the surface, the refusals) against the mocked engine. The kernel's side is
// crates/lime-model-occt/tests/lettering_curved.rs, the mapping's is crates/lime-model-occt/src/text/wrap/tests.rs.

type V = [number, number, number];

/** A cylinder R 20, z 0 to 40, about Z, in 32 columns. Face 0 is its wall, 1 its top, 2 its bottom. */
function cylinderSolid(volumeMm3 = 50265): MockSolid {
  const sides = 32;
  const positions: number[] = [];
  const triangles: number[] = [];
  const at = (k: number, z: number): V => [20 * Math.cos((k / sides) * Math.PI * 2), 20 * Math.sin((k / sides) * Math.PI * 2), z];
  for (let k = 0; k < sides; k += 1) {
    for (const tri of [[at(k, 0), at(k + 1, 0), at(k + 1, 40)], [at(k, 0), at(k + 1, 40), at(k, 40)]]) {
      for (const p of tri) positions.push(...p);
      triangles.push(0);
    }
    for (const p of [[0, 0, 40], at(k, 40), at(k + 1, 40)] as V[]) positions.push(...p);
    triangles.push(1);
    for (const p of [[0, 0, 0], at(k + 1, 0), at(k, 0)] as V[]) positions.push(...p);
    triangles.push(2);
  }
  return {
    volumeMm3,
    positions,
    triangles,
    faces: [
      { id: 0, areaMm2: 5026, normal: [-1, 0, 0], surface: "cylinder", radiusMm: 20, axisPoint: [0, 0, 0], axis: [0, 0, 1] },
      { id: 1, areaMm2: 1256, normal: [0, 0, 1] },
      { id: 2, areaMm2: 1256, normal: [0, 0, -1] },
    ],
    edges: [],
  };
}

const LONG = "The text is longer than the way round this cylinder (125.7 mm). Make it smaller or use two lines.";

/** The mock's layout on the wall: a 5 mm square for every letter, wrapped at true size along the baseline's direction. */
function curvedOf(request: Body): Body {
  const text = String(request.text ?? "");
  if ([...text].length > 30) return { error: LONG };
  const [px, py, pz] = request.point as V;
  const theta = Math.atan2(py, px);
  const sign = request.flip === true ? -1 : 1;
  const axis = request.along === "axis";
  const lift = request.cut === true ? -(request.depth as number) : (request.depth as number);
  const letters = [...text].filter((ch) => ch.trim());
  const place = (x: number, y: number, r: number): V => {
    const a = axis ? theta - (sign * y) / 20 : theta + (sign * x) / 20;
    const z = axis ? pz + sign * x : pz + sign * y;
    return [r * Math.cos(a), r * Math.sin(a), z];
  };
  const faces = letters.map((ch, index) => {
    const x0 = (index - letters.length / 2) * 6;
    const uv: [number, number][] = [[x0, -2.5], [x0 + 5, -2.5], [x0 + 5, 2.5], [x0, 2.5]];
    return {
      ch,
      thin: "iem".includes(ch),
      loops: [{ uv, base: uv.map(([x, y]) => place(x, y, 20)), top: uv.map(([x, y]) => place(x, y, 20 + lift)) }],
    };
  });
  return { ok: true, font: request.font, surface: "cylinder", faces, thin: [], thinNote: null, crossesSeam: false, wayRoundMm: 125.664 };
}

async function openModel(page: Page, refuse = false): Promise<TreeMock> {
  const root = cylinderSolid();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: root.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => root,
    apply: (_request: Body, parent: MockSolid) => cylinderSolid(parent.volumeMm3 + 12),
    // The engine's probe refuses a text longer than the way round, as the kernel does before building.
    probe: (request) => {
      const step = ((request.op as { steps?: Body[] }).steps ?? [])[0];
      return step && [...String(step.text ?? "")].length > 30 ? { ok: false, error: LONG } : { ok: true };
    },
    textCurved: curvedOf,
  });
  void refuse;
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "can.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 50265 mm³");
  return tree;
}

/** A click on the solid, `fx` and `fy` of the way across its box on screen. */
async function click(page: Page, fx = 0.5, fy = 0.5) {
  const [x, y, w, h] = ((await page.locator("#model").getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  const box = (await page.locator("#model").boundingBox())!;
  await page.mouse.click(box.x + x! + w! * fx, box.y + y! + h! * fy);
}

async function openText(page: Page, pick = true) {
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelFeatureMenu [data-tool=text]").click();
  await expect(page.locator("#modelToolFeatures")).toHaveAttribute("data-tool", "text");
  if (pick) {
    await click(page);
    await expect(page.locator("#modelApply")).toBeEnabled();
  }
}

async function typeText(page: Page, text: string) {
  await page.locator("#modelFeatText").fill(text);
  await page.locator("#modelFeatText").dispatchEvent("input");
}

const near = (point: unknown, radius = 20) => {
  const [x, y] = point as V;
  return Math.abs(Math.hypot(x, y) - radius) < 0.6;
};

test("a cylinder's wall gives the card Direction, Flip and the point the text sits on, and takes away U and V", async ({ page }) => {
  const tree = await openModel(page);
  await openText(page, false);
  // Nothing picked: text says to pick one face, not one flat face.
  await expect(page.locator("#modelNote")).toContainText("Pick one face.");
  await expect(page.locator("#modelNote")).not.toContainText("flat");
  await click(page);
  await expect(page.locator("#modelApply")).toBeEnabled();
  await expect(page.locator("#modelTextWay")).toBeVisible();
  await expect(page.locator("#modelTextWay [data-way=around]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelTextFlip")).toBeVisible();
  await expect(page.locator("#modelTextAnchor")).toBeVisible();
  await expect(page.locator("#modelTextAnchorText")).toContainText("Placed where you clicked");
  await expect(page.locator("#modelFeatU")).toBeHidden();
  await expect(page.locator("#modelFeatV")).toBeHidden();
  await expect(page.locator("#modelTextAngle")).toBeVisible();
  // The preview is the engine's layout on the face under the point that was clicked.
  await expect.poll(() => tree.of("textCurved").length).toBeGreaterThan(0);
  const first = tree.of("textCurved").at(-1)!;
  expect(near(first.point), "the clicked point is on the wall").toBe(true);
  expect(first).toMatchObject({ text: "A", font: "sans@4.0", style: "bold", height: 6, depth: 2, cut: false });
  expect(first.along).toBeUndefined();
  await expect(page.locator("#model")).toHaveAttribute("data-ghost-tone", "add");
  await typeText(page, "Lime 42");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(() => tree.of("textCurved").at(-1)!.text).toBe("Lime 42");
  await page.screenshot({ path: "test-results/text-curves/card-around.png" });

  // Along runs it up the part; flip turns it; engraved is the cut's colour.
  await page.locator("#modelTextWay [data-way=axis]").click();
  await expect.poll(() => tree.of("textCurved").at(-1)!.along).toBe("axis");
  await page.locator("#modelTextFlip").check();
  await expect.poll(() => tree.of("textCurved").at(-1)!.flip).toBe(true);
  await page.locator("#modelTextOp [data-op=cut]").click();
  await expect(page.locator("#model")).toHaveAttribute("data-ghost-tone", "cut");
  await expect.poll(() => tree.of("textCurved").at(-1)!.cut).toBe(true);
  await page.screenshot({ path: "test-results/text-curves/card-along-engraved.png" });

  // One lettering step, anchored where the click was, with the direction and the flip.
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelHistoryTree [role=treeitem]")).toHaveCount(2);
  await expect(page.locator("#modelHistoryTree [role=treeitem]").nth(1)).toContainText("Text Lime 42");
  const op = tree.of("apply").at(-1)!.op as { kind: string; steps: Body[]; source: Body };
  expect(op.steps).toHaveLength(1);
  expect(op.steps[0]).toMatchObject({ kind: "lettering", op: "cut", text: "Lime 42", font: "sans@4.0", style: "bold", along: "axis", flip: true, depth: 2, height: 6 });
  expect(near(op.steps[0]!.origin), "anchored on the wall").toBe(true);
  expect(op.steps[0]!.origin).toEqual(first.point);
  expect(op.source).toMatchObject({ kind: "text", along: "axis", flip: true });
  // The step keeps six decimals; the typed source keeps what was clicked.
  (op.source.point as V).forEach((value, i) => expect(value).toBeCloseTo((first.point as V)[i]!, 5));
  expect(op.source.at, "a round face has no U and V").toBeDefined();

  // Edit reopens with the direction, the flip and the point.
  await page.keyboard.press("Shift+E");
  await expect(page.locator("#modelApply")).toHaveText("Update");
  await expect(page.locator("#modelTextWay [data-way=axis]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelTextFlip")).toBeChecked();
  await expect(page.locator("#modelTextAnchorText")).toContainText("Placed where you clicked");
  await expect.poll(() => (tree.of("textCurved").at(-1)!.point as V).every((value, i) => Math.abs(value - (first.point as V)[i]!) < 1e-5)).toBe(true);
});

test("a second click moves the text, and Centre on the face puts it back in the middle", async ({ page }) => {
  const tree = await openModel(page);
  await openText(page);
  await expect.poll(() => tree.of("textCurved").length).toBeGreaterThan(0);
  const first = tree.of("textCurved").at(-1)!.point as V;
  await click(page, 0.3, 0.7);
  await expect.poll(() => JSON.stringify(tree.of("textCurved").at(-1)!.point)).not.toBe(JSON.stringify(first));
  const moved = tree.of("textCurved").at(-1)!.point as V;
  expect(near(moved), "the new point is on the wall too").toBe(true);
  await page.locator("#modelTextCentre").click();
  await expect(page.locator("#modelTextAnchorText")).toContainText("In the middle of the face");
  await expect.poll(() => tree.of("textCurved").length).toBeGreaterThan(2);
  // Across from the seam, which is +X: the middle is at -X.
  const middle = tree.of("textCurved").at(-1)!.point as V;
  expect(middle[0], "across from the seam").toBeLessThan(-18);
  expect(Math.abs(middle[1])).toBeLessThan(3.5);
});

test("a text longer than the way round is refused under Apply, with the length, and no ghost is drawn", async ({ page }) => {
  const tree = await openModel(page);
  await openText(page);
  await typeText(page, "LIME SLICE 2026 LIME SLICE 2026 LIME SLICE");
  await expect(page.locator("#modelNote")).toContainText(LONG);
  await expect(page.locator("#modelApply")).toBeDisabled();
  await expect.poll(() => tree.of("textCurved").at(-1)!.text).toContain("LIME SLICE 2026");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "test-results/text-curves/refusal-too-long.png" });
  await typeText(page, "LIME");
  await expect(page.locator("#modelApply")).toBeEnabled();
});

test("only Text goes on a curved face: Pocket still says flat, and a flat face has no Direction", async ({ page }) => {
  await openModel(page);
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelFeatureMenu [data-tool=pocket]").click();
  await click(page);
  await expect(page.locator("#modelNote")).toContainText("Pick one flat face.");
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelFeatureMenu [data-tool=text]").click();
  await expect(page.locator("#modelTextWay")).toBeVisible();
  // The top is flat: Direction, Flip and the anchor go, and U and V come back.
  await click(page, 0.5, 0.05);
  await expect(page.locator("#modelTextWay")).toBeHidden();
  await expect(page.locator("#modelTextFlip")).toBeHidden();
  await expect(page.locator("#modelFeatU")).toBeVisible();
});
