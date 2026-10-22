import { expect, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid } from "./model-tree-mock";

type V = [number, number, number];

/** A 10 mm box. Faces 0 to 5: bottom, top, front (-Y), back (+Y), left (-X), right (+X). */
export function boxSolid(volumeMm3: number): MockSolid {
  const c = (x: number, y: number, z: number): V => [x * 10, y * 10, z * 10];
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
  return { volumeMm3, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 100 })), edges: [] };
}

function volumeOf(request: Body): number {
  const primitive = request.primitive as { size?: number[] } | undefined;
  const op = request.op as { kind?: string; size?: number[] } | undefined;
  const size = primitive?.size ?? (op?.kind === "root" ? op.size : undefined);
  if (size && size.length >= 3) return (size[0] ?? 0) * (size[1] ?? 0) * (size[2] ?? 0);
  return 4000;
}

function f32b64(values: number[]): string {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buf.writeFloatLE(value, index * 4));
  return buf.toString("base64");
}

/** A one-triangle reply the spec controls. */
export function mockReply(): string {
  return JSON.stringify({
    ok: true,
    report: {
      representation: "sliced",
      trust: "usable",
      notes: ["Solved at one cell size."],
      margins: [{ kind: "minSafetyFactor", limit: 1, value: 2.5, margin: 1.5, met: true, note: "above the band", hotSpot: { at: [1, 2, 3], role: "outer", governs: "across-layers" } }],
      maxDisplacementMm: 0.1,
      minSafetyFactor: 2.5,
      massG: 1,
    },
    surface: {
      triangles: 1,
      positionsB64: f32b64([0, 0, 0, 4, 0, 0, 0, 4, 0]),
      displacementB64: f32b64([0, 0, 0, 0, 0, 0, 0, 0, -0.2]),
      vonMisesB64: f32b64([1, 4, 9]),
      safetyB64: f32b64([3, 2, 1]),
    },
  });
}

/** The box on the plate, open in Model, with the desktop solve answered by `reply`. */
export async function openStressModel(page: Page, reply = mockReply(), viewport = { width: 1440, height: 900 }) {
  await page.addInitScript((text: string) => {
    const bag = window as unknown as { __limeSimStudy?: (body: string) => string; __limeSimBodies?: string[] };
    bag.__limeSimBodies = [];
    bag.__limeSimStudy = (body: string) => {
      bag.__limeSimBodies?.push(body);
      return text;
    };
  }, reply);
  await page.setViewportSize(viewport);
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid(4000).positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await mockModelTree(page, {
    open: (request) => boxSolid(volumeOf(request)),
    apply: (request) => boxSolid(volumeOf(request)),
    probe: () => ({ ok: true }),
  });
  await page.goto("/?stressFixture=1");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
}

/**
 * Each face's centre on the page and its outward normal, from `#model[data-faces]`. The view publishes it while a face
 * press is a push, so read it before a Stress pick mode turns that off; the camera does not move in between.
 */
export async function facePoints(page: Page): Promise<Map<number, { x: number; y: number; normal: number[] }>> {
  let text = "";
  await expect.poll(async () => (text = (await page.locator("#model").getAttribute("data-faces")) ?? "")).not.toBe("");
  const box = (await page.locator("#model").boundingBox())!;
  const out = new Map<number, { x: number; y: number; normal: number[] }>();
  for (const item of text.split(" ").filter(Boolean)) {
    const [face, xy, normalText] = item.split(":");
    if (!face || !xy || !normalText) continue;
    const [x, y] = xy.split(",").map(Number);
    out.set(Number(face), { x: box.x + x!, y: box.y + y!, normal: normalText.split(",").map(Number) });
  }
  return out;
}

/** Open Stress from the Features menu. */
export async function openStress(page: Page) {
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuStress").click();
  await expect(page.locator("#modelStressMain")).toBeVisible();
}
