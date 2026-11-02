import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid } from "./model-tree-mock";

/**
 * --- Plugin steps (docs/plan-recipe-plugins.md milestone 4). A project the MCP built with a plugin: its run reads as one
 * History row named for the plugin, the row's values open read-only beside the code, and a step the app cannot rebuild
 * says why in one sentence. The fixture is a project the app saves, with the MCP's stamp and plugin copy written in.
 */

type V = [number, number, number];

function boxSolid(size: V): MockSolid {
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

const ROOT = boxSolid([20, 20, 10]);
const readout = (page: Page) => page.locator("#modelReadout");
const rows = (page: Page) => page.locator("#modelHistoryTree [role=treeitem]");
const shots = "test-results/plugin-step";

const BODY = [
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
const SHA = createHash("sha256").update(BODY, "utf8").digest("hex");
const FILE = [
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

interface SavedNode { id: number; parent: number | null; op: { kind: string } | null; plugin?: unknown; run?: unknown }
interface Doc { plugins?: Record<string, string>; objects: { modelTree: { nodes: SavedNode[] } }[] }

/** A part with three cuts, saved by the app, then written as the MCP writes a plugin run: the three cuts are the run. */
async function pluginProject(page: Page, copy: (file: string) => string = (file) => file): Promise<Doc> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: ROOT.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await mockModelTree(page, { open: () => ROOT, apply: (request: Body) => boxSolid([20, 20, (request.op as { size: number[] }).size[0]!]) });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(`Volume ${ROOT.volumeMm3} mm³`);
  for (const dx of [8, 6, 4]) {
    if ((await page.locator("#modelToolBoolean").getAttribute("aria-pressed")) !== "true") await page.locator("#modelToolBoolean").click();
    if ((await page.locator("#modelCut").getAttribute("aria-pressed")) !== "true") await page.locator("#modelCut").click();
    await page.locator("#modelDx").fill(String(dx));
    await expect(page.locator("#modelApply")).toBeEnabled();
    await page.locator("#modelApply").click();
    await expect(readout(page)).toContainText(`Volume ${400 * dx} mm³`);
  }
  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const doc = JSON.parse((await readFile((await download.path())!)).toString("utf8")) as Doc;
  const nodes = doc.objects[0]!.modelTree.nodes;
  const cuts = nodes.filter((node) => node.op?.kind === "boolean");
  expect(cuts).toHaveLength(3);
  cuts.forEach((node, i) => {
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

test("a plugin run reads as one History row; its values open read-only, beside its code", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await pluginProject(page);
  const plugin = page.getByRole("treeitem", { name: /^Stud row · plugin v3/ });
  await expect(plugin).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  await expect(plugin).toHaveAttribute("aria-expanded", "false");
  await expect(plugin).toHaveAttribute("data-plugin", "");
  await expect(plugin.locator(".mh-plugin-mark")).toBeVisible();
  await expect(plugin.locator(".mh-warn")).toHaveCount(0);

  // One undo takes the whole run back, and one redo brings it again.
  await page.locator("#modelUndo").click();
  await expect(readout(page)).toContainText(`Volume ${ROOT.volumeMm3} mm³. Stud row · plugin v3 undone.`);
  await expect(plugin).toHaveAttribute("data-state", "redo");
  await page.locator("#modelRedo").click();
  await expect(readout(page)).toContainText("Volume 1600 mm³. Stud row · plugin v3 redone.");
  await expect(plugin).toHaveAttribute("aria-selected", "true");

  // The pencil opens the values, read-only, in the plugin's own words and order.
  await plugin.hover();
  await plugin.locator(".mh-edit").click();
  const card = page.locator("#modelPluginCard");
  await expect(card).toBeVisible();
  await expect(card.locator(".mh-plugin-title")).toHaveText("Stud row");
  await expect(card.locator(".mh-plugin-kind")).toHaveText("plugin v3");
  await expect(card.locator(".mh-plugin-meta")).toHaveText("A row of studs along the top. · By Marius · made with claude-code");
  await expect(card.locator(".mh-plugin-name")).toHaveText(["Studs", "Stud radius", "edge"]);
  const controls = card.locator(".mh-plugin-control");
  await expect(controls.nth(0)).toHaveValue("5");
  await expect(controls.nth(0)).toHaveJSProperty("readOnly", true);
  await expect(controls.nth(1)).toHaveValue("1");
  await expect(card.locator(".mh-plugin-unit").nth(1)).toHaveText("mm · default");
  await expect(controls.nth(2)).toBeDisabled();
  await expect(controls.nth(2)).toHaveValue("fillet");
  await expect(card.locator(".mh-plugin-note")).toBeHidden();
  await expect(card.locator(".mh-plugin-hint")).toContainText("Read-only for now.");
  await page.screenshot({ path: `${shots}/plugin-row-values.png` });

  // View source shows the file the project carries; Escape closes it and focus comes back.
  await card.locator("#modelPluginSourceOpen").click();
  const sheet = page.locator("#modelPluginSource");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator("#modelPluginSourceTitle")).toHaveText("Stud row · plugin v3");
  await expect(sheet.locator(".mh-source")).toContainText('s.count("studs", 3)');
  await expect(sheet.locator(".mh-source")).toContainText("//! plugin: stud-row");
  await page.screenshot({ path: `${shots}/plugin-source.png` });
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(card.locator("#modelPluginSourceOpen")).toBeFocused();

  // The row's menu has the same two, and closing the card puts focus back on the row.
  await card.locator(".mh-plugin-close").click();
  await expect(card).toBeHidden();
  await expect(plugin).toBeFocused();
  await plugin.locator(".mh-more").click();
  await expect(page.getByRole("menuitem", { name: /Plugin values/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /View source/ })).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("Escape");

  // Expanded, the run shows its steps; its first step still opens the values.
  await plugin.locator(".mh-fold").click();
  await expect(rows(page)).toHaveCount(4);

  // A save keeps the stamp, the run, and the project's copy.
  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const again = JSON.parse((await readFile((await download.path())!)).toString("utf8")) as Doc;
  expect(again.plugins?.[SHA]).toBe(FILE);
  expect(again.objects[0]!.modelTree.nodes.filter((node) => node.run).length).toBe(3);
  expect(again.objects[0]!.modelTree.nodes.filter((node) => node.plugin).length).toBe(1);
});

test("a plugin step the app cannot rebuild says why, in one sentence on the row and in its card", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await pluginProject(page, (file) => file.replace("[-10.0 + 4.0", "[-12.0 + 4.0"));
  const plugin = page.getByRole("treeitem", { name: /^Stud row · plugin v3/ });
  await expect(plugin).toBeVisible();
  await expect(plugin).toHaveAttribute("aria-description", /This project's copy of the plugin was changed outside the app/);
  await expect(plugin.locator(".mh-warn")).toBeVisible();
  await plugin.hover();
  await plugin.locator(".mh-edit").click();
  const card = page.locator("#modelPluginCard");
  await expect(card.locator(".mh-plugin-note")).toHaveText("This project's copy of the plugin was changed outside the app.");
  await expect(card.locator(".mh-plugin-hint")).toHaveText("The part stays as it was built, with every step after it.");
  await page.screenshot({ path: `${shots}/plugin-edited-copy.png` });
});
