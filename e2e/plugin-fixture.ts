import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid } from "./model-tree-mock";

/**
 * --- Plugin steps. The fixture the plugin step specs share: a part the app built with three cuts, saved, then written
 * as the MCP writes a plugin run (docs/plan-recipe-plugins.md D8): the cuts are the run of `stud-row` v3, and the
 * project carries the plugin's file.
 */

type V = [number, number, number];

export function boxSolid(size: V): MockSolid {
  const [sx, sy, sz] = size;
  const c = (x: number, y: number, z: number): V => [x * sx, y * sy, z * sz];
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
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [] };
}

export const ROOT = boxSolid([20, 20, 10]);

export const BODY = [
  "use lime_recipe::{ops, Session};",
  "",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let n = s.count("studs", 3).range(1, 10).label("Studs").get();',
  '    let r = s.number("radius", 1.0).range(0.5, 3.0).unit("mm").label("Stud radius").get();',
  '    let edge = s.choice("edge", &["fillet", "sharp"], "fillet").get();',
  "    let p = s.object().unwrap();",
  "    for i in 0..n {",
  '        s.apply(&p, ops::boolean("fuse", ops::cylinder(r, 3.0), [-10.0 + 4.0 * i as f64, 0.0, 10.0])).unwrap();',
  "    }",
  '    s.log(edge.as_str());',
  "    s.done(&p);",
  "}",
  "",
].join("\n");
export const SHA = createHash("sha256").update(BODY, "utf8").digest("hex");
export const FILE = [
  "//! ---",
  "//! plugin: stud-row",
  "//! title: Stud row",
  "//! version: 3",
  "//! description: A row of studs along the top.",
  "//! author: Marius",
  "//! made-by: claude-code",
  "//! api: 1.1",
  `//! source-sha256: ${SHA}`,
  "//! target: object",
  '//! params: [{"name":"studs","kind":"count","default":3,"min":1,"max":10,"label":"Studs"},{"name":"radius","kind":"number","default":1,"min":0.5,"max":3,"unit":"mm","label":"Stud radius"},{"name":"edge","kind":"choice","default":"fillet","options":["fillet","sharp"]}]',
  "//! ---",
  BODY,
].join("\n");

export interface SavedNode { id: number; parent: number | null; op: { kind: string } | null; plugin?: unknown; run?: unknown }
export interface Doc { plugins?: Record<string, string>; objects: { modelTree: { nodes: SavedNode[] } }[] }

/**
 * A part with three cuts (and `after`, cuts of the person's own after them), saved by the app, then written as the MCP
 * writes a plugin run: the first three cuts are the run. `copy` changes the project's copy of the plugin; `before`
 * runs before the page loads (a scripted recipe runner, say).
 */
export async function pluginProject(page: Page, opts: { copy?: (file: string) => string; after?: number[]; before?: (page: Page) => Promise<void> } = {}): Promise<Doc> {
  const copy = opts.copy ?? ((file: string) => file);
  const readout = page.locator("#modelReadout");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: ROOT.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await mockModelTree(page, { open: () => ROOT, apply: (request: Body) => boxSolid([20, 20, (request.op as { size: number[] }).size[0]!]) });
  await opts.before?.(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(readout).toContainText(`Volume ${ROOT.volumeMm3} mm³`);
  for (const dx of [8, 6, 4, ...(opts.after ?? [])]) {
    if ((await page.locator("#modelToolBoolean").getAttribute("aria-pressed")) !== "true") await page.locator("#modelToolBoolean").click();
    if ((await page.locator("#modelCut").getAttribute("aria-pressed")) !== "true") await page.locator("#modelCut").click();
    await page.locator("#modelDx").fill(String(dx));
    await expect(page.locator("#modelApply")).toBeEnabled();
    await page.locator("#modelApply").click();
    await expect(readout).toContainText(`Volume ${400 * dx} mm³`);
  }
  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const doc = JSON.parse((await readFile((await download.path())!)).toString("utf8")) as Doc;
  const nodes = doc.objects[0]!.modelTree.nodes;
  const cuts = nodes.filter((node) => node.op?.kind === "boolean");
  expect(cuts).toHaveLength(3 + (opts.after?.length ?? 0));
  cuts.slice(0, 3).forEach((node, i) => {
    node.run = { id: "a1b2c3d4", k: i + 1, n: 3 };
    if (i === 0) node.plugin = { plugin: "stud-row", version: 3, sha256: SHA, api: "1.1", params: { studs: 5 }, context: { bedMm: [250, 210, 220], nozzleMm: 0.4 }, fingerprint: { volumeMm3: 1600, faces: 6, edges: 12 } };
  });
  doc.plugins = { [SHA]: copy(FILE) };
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "studs.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  return doc;
}
