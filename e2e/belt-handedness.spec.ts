import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

/**
 * A chiral part sliced for the IR3 V2 by a real engine prints with the part's own hand.
 *   lime-slice serve --port 43218 --cache-dir <dir>
 *   LIME_EDIT_API=http://127.0.0.1:43218 npx playwright test belt-handedness
 */
const api = process.env.LIME_EDIT_API;

test.skip(!api, "set LIME_EDIT_API to a running lime-slice serve");
test.setTimeout(300_000);

const SLICE_MS = 120_000;

/** Three posts of different heights at spots no symmetry maps onto each other: x0, y0, x1, y1, height. */
const POSTS: [number, number, number, number, number][] = [
  [10, 0, 15, 5, 4],
  [40, 20, 45, 25, 8],
  [25, 40, 30, 45, 12],
];

function postsStl(): string {
  const out = ["solid posts"];
  for (const [x0, y0, x1, y1, h] of POSTS) {
    const lo = [x0, y0, 0];
    const hi = [x1, y1, h];
    const corner = (bits: boolean[]) => [0, 1, 2].map((k) => (bits[k] ? hi[k] : lo[k]));
    const f = false;
    const t = true;
    const quads = [
      [[f, f, f], [f, t, f], [t, t, f], [t, f, f]],
      [[f, f, t], [t, f, t], [t, t, t], [f, t, t]],
      [[f, f, f], [t, f, f], [t, f, t], [f, f, t]],
      [[f, t, f], [f, t, t], [t, t, t], [t, t, f]],
      [[f, f, f], [f, f, t], [f, t, t], [f, t, f]],
      [[t, f, f], [t, t, f], [t, t, t], [t, f, t]],
    ];
    for (const q of quads) {
      for (const tri of [[q[0]!, q[1]!, q[2]!], [q[0]!, q[2]!, q[3]!]]) {
        out.push("facet normal 0 0 0", "outer loop");
        for (const bits of tri) out.push(`vertex ${corner(bits).join(" ")}`);
        out.push("endloop", "endfacet");
      }
    }
  }
  out.push("endsolid posts");
  return out.join("\n");
}

type Reply = { gcode?: string; gcodeToken?: string };
type Body = { pose?: { rotation: number[]; pivot: number[]; translation: number[] } };

async function proxy(page: Page) {
  const bodies: Body[] = [];
  const replies: Reply[] = [];
  await page.route("http://127.0.0.1:43118/**", async (route) => {
    const url = route.request().url().replace("http://127.0.0.1:43118", api!);
    if (/\/api\/jobs$|\/api\/slice$/.test(url) && route.request().method() === "POST") bodies.push(route.request().postDataJSON());
    const response = await route.fetch({ url, timeout: SLICE_MS });
    if (/\/api\/jobs\/[^/]+\/result$|\/api\/slice$/.test(url) && response.status() === 200) replies.push(JSON.parse(await response.text()));
    await route.fulfill({ response });
  });
  return { bodies, replies };
}

async function gcodeOf(page: Page, reply: Reply) {
  if (reply.gcode) return reply.gcode;
  const res = await page.request.get(`${api}/api/gcode/${reply.gcodeToken}`);
  expect(res.ok()).toBe(true);
  return res.text();
}

/** Every extruding move's end point, read the way the maker's slicer writes a belt file: X, v = Z - Y cos a, u = Y sin a. */
function machineBeads(gcode: string) {
  const s = Math.sin(Math.PI / 4);
  const c = Math.cos(Math.PI / 4);
  let layer = -1;
  let [x, b, u] = [0, 0, 0];
  const beads: { layer: number; x: number; v: number; u: number }[] = [];
  for (const line of gcode.split("\n")) {
    if (line.startsWith(";LAYER:")) {
      layer += 1;
      continue;
    }
    if (layer < 0 || !/^G1 /.test(line)) continue;
    const word = (axis: string) => new RegExp(`\\s${axis}(-?[\\d.]+)`).exec(line)?.[1];
    x = word("X") ? Number(word("X")) : x;
    b = word("Z") ? Number(word("Z")) : b;
    u = word("Y") ? Number(word("Y")) : u;
    if (word("E") && (word("X") || word("Y"))) beads.push({ layer, x, v: b - u * c, u: u * s });
  }
  return beads;
}

test("a chiral part printed on the IR3 V2 has the part's hand and its high-Y end first", async ({ page }) => {
  const { bodies, replies } = await proxy(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#machinePrinter").selectOption("ideaformer-ir3-v2");
  await page.locator("#file").setInputFiles({ name: "posts.stl", mimeType: "model/stl", buffer: Buffer.from(postsStl()) });
  await expect(page.locator("#objectList .obj").first()).toBeVisible({ timeout: 30_000 });
  await page.locator("#slice").click();
  await expect(page.locator("#slice")).toBeEnabled({ timeout: SLICE_MS });
  await expect(page.locator("#cancel")).toBeHidden();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");

  const pose = bodies.at(-1)!.pose!;
  expect(pose.rotation).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const beads = machineBeads(await gcodeOf(page, replies.at(-1)!));
  expect(beads.length).toBeGreaterThan(100);

  // Each post is the beads over its own X span, where the app put it on the belt.
  const posts = POSTS.map(([x0, , x1, , height]) => {
    const shift = pose.translation[0]! - pose.pivot[0]!;
    const own = beads.filter((bead) => bead.x >= x0 + shift - 0.5 && bead.x <= x1 + shift + 0.5);
    expect(own.length, `beads over the post at X ${x0 + shift}`).toBeGreaterThan(10);
    const mean = (pick: (b: (typeof beads)[number]) => number) => own.reduce((sum, b) => sum + pick(b), 0) / own.length;
    expect(Math.max(...own.map((b) => b.u)), "the post's top").toBeGreaterThan(height - 0.5);
    return { across: mean((b) => b.x), along: mean((b) => b.v), first: Math.min(...own.map((b) => b.layer)) };
  });

  // Seen from above, X right and the design's Y up, the posts turn counter-clockwise. The file's Y is minus `v`.
  const turn = (p: [number, number][]) => (p[1]![0] - p[0]![0]) * (p[2]![1] - p[0]![1]) - (p[1]![1] - p[0]![1]) * (p[2]![0] - p[0]![0]);
  const design = turn(POSTS.map(([x0, y0, x1, y1]) => [(x0 + x1) / 2, (y0 + y1) / 2]));
  const printed = turn(posts.map((p) => [p.across, -p.along]));
  expect(design).toBeGreaterThan(0);
  expect(printed * design, "the belt file is the part, not its mirror image").toBeGreaterThan(0);
  expect(posts[2]!.first).toBeLessThan(posts[1]!.first);
  expect(posts[1]!.first).toBeLessThan(posts[0]!.first);
});
