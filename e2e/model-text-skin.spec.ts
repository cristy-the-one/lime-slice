import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";

// Text on a sphere, a torus and a freeform face (docs/plan-text-on-curves-and-fonts.md, milestone 3): the Text card on those faces
// (U or V, Wrap or Project, Flip, the point the text sits on, the live preview, the refusals) against the mocked engine. The kernel's
// side is crates/lime-model-occt/tests/lettering_skin.rs, the mapping's is crates/lime-model-occt/src/text/skin/tests.rs.

type V = [number, number, number];

/** A ball R 20 about the origin, 24 columns by 12 rows. Face 0 is the whole sphere. */
function ballSolid(volumeMm3 = 33510): MockSolid {
  const cols = 24;
  const rows = 12;
  const positions: number[] = [];
  const triangles: number[] = [];
  const at = (i: number, j: number): V => {
    const lon = (i / cols) * Math.PI * 2;
    const lat = (j / rows) * Math.PI - Math.PI / 2;
    return [20 * Math.cos(lat) * Math.cos(lon), 20 * Math.cos(lat) * Math.sin(lon), 20 * Math.sin(lat)];
  };
  for (let i = 0; i < cols; i += 1) {
    for (let j = 0; j < rows; j += 1) {
      for (const tri of [[at(i, j), at(i + 1, j), at(i + 1, j + 1)], [at(i, j), at(i + 1, j + 1), at(i, j + 1)]]) {
        for (const p of tri) positions.push(...p);
        triangles.push(0);
      }
    }
  }
  return {
    volumeMm3,
    positions,
    triangles,
    faces: [{ id: 0, areaMm2: 5027, normal: [-1, 0, 0], surface: "sphere", radiusMm: 20 }],
    edges: [],
  };
}

/** A wavy sheet z = 2 sin(x / 6) cos(y / 6) over 60 x 60 on a 10 mm slab. Face 0 is the wavy top (a freeform face), 1 the flat bottom. */
function sheetSolid(volumeMm3 = 36000): MockSolid {
  const n = 20;
  const positions: number[] = [];
  const triangles: number[] = [];
  const top = (i: number, j: number): V => {
    const x = -30 + (60 * i) / n;
    const y = -30 + (60 * j) / n;
    return [x, y, 2 * Math.sin(x / 6) * Math.cos(y / 6)];
  };
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      for (const tri of [[top(i, j), top(i + 1, j), top(i + 1, j + 1)], [top(i, j), top(i + 1, j + 1), top(i, j + 1)]]) {
        for (const p of tri) positions.push(...p);
        triangles.push(0);
      }
    }
  }
  for (const p of [[-30, -30, -10], [-30, 30, -10], [30, 30, -10], [-30, -30, -10], [30, 30, -10], [30, -30, -10]]) positions.push(...p);
  triangles.push(1, 1);
  return {
    volumeMm3,
    positions,
    triangles,
    faces: [
      { id: 0, areaMm2: 3700, normal: [0, 0, 1] },
      { id: 1, areaMm2: 3600, normal: [0, 0, -1] },
    ],
    edges: [],
  };
}

const POLE = "The text crosses the pole of this sphere. Move it away from the pole, or make it smaller.";
const PINCH = "The text crosses a point where this face pinches or folds. Move it, or make it smaller.";

/** The mock's layout on the surface: a 5 mm square for every letter, walked out along the tangent. The kernel's is the real map. */
function layoutOn(request: Body, kind: "sphere" | "freeform"): Body {
  const text = String(request.text ?? "");
  if (text.includes("POLE")) return { error: kind === "sphere" ? POLE : PINCH };
  const anchor = request.point as V;
  const lift = request.cut === true ? -(request.depth as number) : (request.depth as number);
  const letters = [...text].filter((ch) => ch.trim());
  const norm = (v: V): V => {
    const l = Math.hypot(...v) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const normal = kind === "sphere" ? norm(anchor) : ([0, 0, 1] as V);
  const east = norm([-normal[1], normal[0], 0].every((v) => v === 0) ? [1, 0, 0] : [-normal[1], normal[0], 0]);
  const north: V = [normal[1] * east[2] - normal[2] * east[1], normal[2] * east[0] - normal[0] * east[2], normal[0] * east[1] - normal[1] * east[0]];
  const way = request.along === "v" ? north : east;
  const across = request.along === "v" ? ([-east[0], -east[1], -east[2]] as V) : north;
  const sign = request.flip === true ? -1 : 1;
  const place = (x: number, y: number, up: number): V => {
    const p: V = [anchor[0] + sign * (way[0] * x + across[0] * y), anchor[1] + sign * (way[1] * x + across[1] * y), anchor[2] + sign * (way[2] * x + across[2] * y)];
    if (kind === "sphere") {
      const r = Math.hypot(...anchor) + up;
      const unit = norm(p);
      return [unit[0] * r, unit[1] * r, unit[2] * r];
    }
    return [p[0], p[1], 2 * Math.sin(p[0] / 6) * Math.cos(p[1] / 6) + up];
  };
  const faces = letters.map((ch, index) => {
    const x0 = (index - letters.length / 2) * 6;
    const uv: [number, number][] = [[x0, -2.5], [x0 + 5, -2.5], [x0 + 5, 2.5], [x0, 2.5]];
    return { ch, thin: "iem".includes(ch), loops: [{ uv, base: uv.map(([x, y]) => place(x, y, 0)), top: uv.map(([x, y]) => place(x, y, lift)) }] };
  });
  return { ok: true, font: request.font, surface: kind, faces, thin: [], thinNote: null, crossesSeam: false, wayRoundMm: null };
}

async function openModel(page: Page, kind: "sphere" | "freeform"): Promise<TreeMock> {
  const make = kind === "sphere" ? ballSolid : sheetSolid;
  const root = make();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: root.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => root,
    apply: (_request: Body, parent: MockSolid) => make(parent.volumeMm3 + 12),
    // The engine's probe refuses what the kernel refuses before building.
    probe: (request) => {
      const step = ((request.op as { steps?: Body[] }).steps ?? [])[0];
      return step && String(step.text ?? "").includes("POLE") ? { ok: false, error: kind === "sphere" ? POLE : PINCH } : { ok: true };
    },
    textCurved: (request) => layoutOn(request, kind),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "part.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText(`Volume ${root.volumeMm3} mm³`);
  return tree;
}

/** A click on the solid, `fx` and `fy` of the way across its box on screen. */
async function click(page: Page, fx = 0.5, fy = 0.5) {
  const [x, y, w, h] = ((await page.locator("#model").getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  const box = (await page.locator("#model").boundingBox())!;
  await page.mouse.click(box.x + x! + w! * fx, box.y + y! + h! * fy);
}

async function openText(page: Page) {
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelFeatureMenu [data-tool=text]").click();
  await expect(page.locator("#modelToolFeatures")).toHaveAttribute("data-tool", "text");
  await click(page);
  await expect(page.locator("#modelApply")).toBeEnabled();
}

async function typeText(page: Page, text: string) {
  await page.locator("#modelFeatText").fill(text);
  await page.locator("#modelFeatText").dispatchEvent("input");
}

test("a sphere gives the card U or V, Wrap or Project and Flip, takes away Around and Along and the flat U and V, and applies one step", async ({ page }) => {
  const tree = await openModel(page, "sphere");
  await openText(page);
  await expect(page.locator("#modelTextDir")).toBeVisible();
  await expect(page.locator("#modelTextDir [data-dir=u]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelTextWrap")).toBeVisible();
  await expect(page.locator("#modelTextWrap [data-wrap=wrap]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelTextWay")).toBeHidden();
  await expect(page.locator("#modelTextFlip")).toBeVisible();
  await expect(page.locator("#modelTextAnchorText")).toContainText("Placed where you clicked");
  await expect(page.locator("#modelFeatU")).toBeHidden();
  await expect(page.locator("#modelFeatV")).toBeHidden();
  // The preview is the engine's layout on the sphere under the point that was clicked.
  await expect.poll(() => tree.of("textCurved").length).toBeGreaterThan(0);
  const first = tree.of("textCurved").at(-1)!;
  expect(Math.abs(Math.hypot(...(first.point as V)) - 20), "the clicked point is on the sphere").toBeLessThan(0.8);
  expect(first).toMatchObject({ font: "sans@4.0", style: "bold", height: 6, depth: 2, cut: false });
  expect(first.along).toBeUndefined();
  expect(first.wrap).toBeUndefined();
  await expect(page.locator("#model")).toHaveAttribute("data-ghost-tone", "add");
  await typeText(page, "Lime 42");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(() => tree.of("textCurved").at(-1)!.text).toBe("Lime 42");
  await page.screenshot({ path: "test-results/text-skin/sphere-wrap.png" });

  // Along V starts the baseline along the face's V, Project pushes it on straight, Flip turns it, engraved is the cut's colour.
  await page.locator("#modelTextDir [data-dir=v]").click();
  await expect.poll(() => tree.of("textCurved").at(-1)!.along).toBe("v");
  await page.locator("#modelTextWrap [data-wrap=project]").click();
  await expect.poll(() => tree.of("textCurved").at(-1)!.wrap).toBe("project");
  await page.locator("#modelTextFlip").check();
  await expect.poll(() => tree.of("textCurved").at(-1)!.flip).toBe(true);
  await page.locator("#modelTextOp [data-op=cut]").click();
  await expect(page.locator("#model")).toHaveAttribute("data-ghost-tone", "cut");
  await page.screenshot({ path: "test-results/text-skin/sphere-v-project-engraved.png" });

  // One lettering step, anchored where the click was, with the direction, the projection and the flip.
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelHistoryTree [role=treeitem]")).toHaveCount(2);
  await expect(page.locator("#modelHistoryTree [role=treeitem]").nth(1)).toContainText("Text Lime 42");
  const op = tree.of("apply").at(-1)!.op as { kind: string; steps: Body[]; source: Body };
  expect(op.steps).toHaveLength(1);
  expect(op.steps[0]).toMatchObject({ kind: "lettering", op: "cut", text: "Lime 42", font: "sans@4.0", along: "v", wrap: "project", flip: true, depth: 2, height: 6 });
  expect(op.steps[0]!.origin).toEqual(first.point);
  expect(op.source).toMatchObject({ kind: "text", along: "v", wrap: "project", flip: true });

  // Edit reopens with them.
  await page.keyboard.press("Shift+E");
  await expect(page.locator("#modelApply")).toHaveText("Update");
  await expect(page.locator("#modelTextDir [data-dir=v]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelTextWrap [data-wrap=project]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelTextFlip")).toBeChecked();
  await expect.poll(() => (tree.of("textCurved").at(-1)!.point as V).every((value, i) => Math.abs(value - (first.point as V)[i]!) < 1e-5)).toBe(true);
});

test("a freeform face takes text too, and a refusal is one sentence under Apply", async ({ page }) => {
  const tree = await openModel(page, "freeform");
  await openText(page);
  await expect(page.locator("#modelTextDir")).toBeVisible();
  await expect(page.locator("#modelTextWrap")).toBeVisible();
  await expect(page.locator("#modelTextWay")).toBeHidden();
  await expect.poll(() => tree.of("textCurved").length).toBeGreaterThan(0);
  const first = tree.of("textCurved").at(-1)!.point as V;
  expect(Math.abs(first[2]), "the clicked point is on the wavy top").toBeLessThan(3);
  await typeText(page, "Lime 42");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(() => tree.of("textCurved").at(-1)!.text).toBe("Lime 42");
  await expect(page.locator("#model")).toHaveAttribute("data-ghost-tone", "add");
  await page.screenshot({ path: "test-results/text-skin/freeform-wrap.png" });

  // A refusal names the problem and Apply waits.
  await typeText(page, "POLE");
  await expect(page.locator("#modelNote")).toContainText(PINCH);
  await expect(page.locator("#modelApply")).toBeDisabled();
  await page.screenshot({ path: "test-results/text-skin/freeform-refusal.png" });
  await typeText(page, "LIME");
  await expect(page.locator("#modelApply")).toBeEnabled();

});
