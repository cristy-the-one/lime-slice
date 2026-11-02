import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { FILE, pluginProject, ROOT, SHA, type Doc } from "./plugin-fixture";

/**
 * --- Plugin steps (docs/plan-recipe-plugins.md milestone 4). A project the MCP built with a plugin: its run reads as one
 * History row named for the plugin, the row's values open read-only beside the code, and a step the app cannot rebuild
 * says why in one sentence. The fixture is a project the app saves, with the MCP's stamp and plugin copy written in.
 */

const readout = (page: Page) => page.locator("#modelReadout");
const rows = (page: Page) => page.locator("#modelHistoryTree [role=treeitem]");
const shots = "test-results/plugin-step";

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
  // The browser build runs no plugins: the values stay read-only, and the card says where they can change.
  await expect(card.locator(".mh-plugin-hint")).toContainText("needs the desktop app");
  await expect(card.locator("#modelPluginRebuild")).toBeHidden();
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
  await pluginProject(page, { copy: (file) => file.replace("[-10.0 + 4.0", "[-12.0 + 4.0") });
  const plugin = page.getByRole("treeitem", { name: /^Stud row · plugin v3/ });
  await expect(plugin).toBeVisible();
  await expect(plugin).toHaveAttribute("aria-description", /This project's copy of the plugin was changed outside the app/);
  await expect(plugin.locator(".mh-warn")).toBeVisible();
  await plugin.hover();
  await plugin.locator(".mh-edit").click();
  const card = page.locator("#modelPluginCard");
  await expect(card.locator(".mh-plugin-note")).toHaveText("This project's copy of the plugin was changed outside the app.");
  await expect(card.locator(".mh-plugin-hint")).toContainText("The part stays as it was built.");
  await page.screenshot({ path: `${shots}/plugin-edited-copy.png` });
});
