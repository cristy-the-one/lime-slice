import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { answerSheet, askSheet } from "./ask-sheet";
import { BODY, pluginProject, SHA, type Doc } from "./plugin-fixture";
import { FILE_NOTCH, FILE_OUTLINE, FILE_OUTLINE_BARE, scriptedLibrary, scriptedRunner, SHA_V4 } from "./plugins-scripted";

/**
 * --- The Plugins panel (docs/plan-recipe-plugins.md D13, milestone 7). The library (a stand-in for the desktop
 * shell's folder) lists in the Features menu's card; search, the form's ranges, units and presets; Preview builds the
 * plugin on the part and takes it back; Apply lands one History row that Undo takes back; History offers Use v4 for
 * the step built with v3, and Save as plugin… for a draft. The scripted recipe cuts `studs` boxes, each 2 × studs mm.
 */

const readout = (page: Page) => page.locator("#modelReadout");
const rows = (page: Page) => page.locator("#modelHistoryTree [role=treeitem]");
const card = (page: Page) => page.locator("#modelPlugins");
const shots = "test-results/plugins-panel";
/** A draft: a recipe run nobody kept, whose code is not in the library. */
const DRAFT = `${BODY}// kept by nobody yet\n`;
const DRAFT_SHA = createHash("sha256").update(DRAFT, "utf8").digest("hex");

async function both(page: Page) {
  await scriptedLibrary(page);
  await scriptedRunner(page);
}

async function openPanel(page: Page) {
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuPlugins").click();
  await expect(page.locator("#modelPanelTitle")).toHaveText("Plugins");
  await expect(card(page)).toBeVisible();
}

test("the Plugins panel lists and searches the library, checks the form, previews without keeping, and applies one History row", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await pluginProject(page, { before: both });
  await expect(page.getByRole("treeitem", { name: /^Stud row · plugin v3/ })).toBeVisible();
  const before = await rows(page).count();
  await openPanel(page);

  // The library: one section, each row its title, version, description, author and badges.
  // All: the plugins, then the library's other nuggets (here stud-row's preset).
  const list = card(page).locator(".pp-section");
  await expect(list.locator(".pp-section-title")).toHaveText(["Your plugins", "Presets"]);
  await expect(card(page).locator(".pp-pick")).toHaveCount(3);
  const studRow = card(page).locator('.pp-pick[data-key="library:stud-row"]');
  await expect(studRow.locator(".pp-version")).toHaveText("v4");
  await expect(studRow.locator(".pp-badge")).toHaveText("needs a part");
  await expect(studRow.locator(".pp-by")).toHaveText("By Marius");
  await page.screenshot({ path: `${shots}/panel-list.png` });

  // Search: a word of a title or description; nothing found says what to do.
  const search = card(page).locator("#modelPluginsSearch");
  await search.fill("clip");
  await expect(card(page).locator(".pp-pick")).toHaveCount(1);
  await expect(card(page).locator(".pp-pick .pp-title")).toHaveText("Corner notch");
  await search.fill("zebra");
  await expect(card(page).locator(".pp-pick")).toHaveCount(0);
  await expect(card(page).locator(".pp-empty")).toHaveText("Nothing matches “zebra”. Try another word, or clear the search.");
  await search.fill("studs");
  await search.press("Enter");

  // The form: each value with its unit and range; a value out of range is said, with the fix, and Apply waits.
  await expect(card(page).locator("#modelPluginsTitle")).toContainText("Stud row");
  await expect(card(page).locator("#modelPluginsTarget")).toHaveText(/^Changes /);
  const studs = card(page).locator('.mh-plugin-control[data-name="studs"]');
  await expect(studs).toHaveValue("3");
  await expect(card(page).locator(".mh-plugin-unit").nth(0)).toHaveText("1 to 12");
  await expect(card(page).locator(".mh-plugin-unit").nth(1)).toHaveText("mm · 0.5 to 3");
  await card(page).locator("#modelPluginsLive").uncheck();
  await studs.fill("13");
  await expect(card(page).locator("#modelPluginsStatus")).toHaveText("Studs is 1 to 12. Type a value in that range.");
  await expect(page.locator("#modelApply")).toBeDisabled();
  await expect(page.locator("#modelApply")).toHaveAttribute("data-reason", "Studs is 1 to 12. Type a value in that range.");
  await expect(card(page).locator("#modelPluginsPreview")).toBeDisabled();

  // A preset fills the form.
  await card(page).locator("#modelPluginsPreset").selectOption("dense");
  await expect(studs).toHaveValue("6");
  await expect(card(page).locator('.mh-plugin-control[data-name="radius"]')).toHaveValue("0.8");

  // Preview: the plugin runs on the part and is taken back; History keeps its rows.
  await studs.fill("2");
  await card(page).locator('.mh-plugin-control[data-name="radius"]').fill("1");
  await card(page).locator("#modelPluginsPreview").click();
  await expect(readout(page)).toContainText("Preview of “Stud row”");
  await expect(readout(page)).toContainText("Volume 1600 mm³");
  await expect(readout(page)).toContainText("Nothing is kept until you Apply.");
  await expect(rows(page)).toHaveCount(before);
  await page.screenshot({ path: `${shots}/panel-preview.png` });
  const log = await page.evaluate(() => (window as unknown as { __recipeLog: { command: string; args: Record<string, unknown> }[] }).__recipeLog);
  const start = JSON.parse(String(log.find((row) => row.command === "recipe_send")!.args.line)) as { params: Record<string, unknown> };
  expect(start.params).toEqual({ studs: 2 });

  // Live: a change previews again by itself.
  await card(page).locator("#modelPluginsLive").check();
  await studs.fill("3");
  await expect(readout(page)).toContainText("Volume 2400 mm³");
  await expect(rows(page)).toHaveCount(before);

  // Apply: one History row, stamped v4, which one Undo takes back.
  await studs.fill("2");
  await expect(readout(page)).toContainText("Volume 1600 mm³");
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Applied “Stud row” v4 with Studs 2: one step in History, which Undo takes back.");
  await expect(rows(page)).toHaveCount(before + 1);
  await expect(page.getByRole("treeitem", { name: /^Stud row · plugin v4/ })).toHaveCount(1);
  await page.screenshot({ path: `${shots}/panel-applied.png` });
  await page.locator("#modelUndo").click();
  await expect(readout(page)).toContainText("undone");
  await page.locator("#modelRedo").click();
  await expect(readout(page)).toContainText("redone");

  // The project keeps the plugin's code and the stamp.
  await page.keyboard.press("Escape");
  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const doc = JSON.parse((await readFile((await download.path())!)).toString("utf8")) as Doc;
  expect(Object.keys(doc.plugins ?? {}).sort()).toEqual([SHA, SHA_V4].sort());
  const stamps = doc.objects[0]!.modelTree.nodes.filter((node) => node.plugin).map((node) => node.plugin as { version: number; params: Record<string, unknown> });
  expect(stamps.map((stamp) => [stamp.version, stamp.params])).toEqual([[3, { studs: 5 }], [4, { studs: 2 }]]);
});

test("History offers Use v4 for a step built with v3, never by itself, and the menu reveals and removes", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await pluginProject(page, { before: both });
  const plugin = page.getByRole("treeitem", { name: /^Stud row · plugin v3/ });
  await plugin.hover();
  await plugin.locator(".mh-edit").click();
  const history = page.locator("#modelPluginCard");
  await expect(history.locator(".mh-plugin-note")).toHaveText("v4 is in your library.");
  await expect(history.locator("#modelPluginUse")).toHaveText("Use v4");
  await page.screenshot({ path: `${shots}/history-use-v4.png` });
  await history.locator("#modelPluginUse").click();
  await expect(readout(page)).toContainText("Rebuilt “Stud row” with v4 from your library.");
  await expect(page.getByRole("treeitem", { name: /^Stud row · plugin v4/ })).toHaveCount(1);
  await expect(history.locator("#modelPluginUse")).toBeHidden();
  await page.locator("#modelUndo").click();
  await expect(history.locator("#modelPluginUse")).toBeVisible();

  // The panel's menu: Reveal in folder asks the shell; Remove asks first, then the library forgets it.
  await openPanel(page);
  await card(page).locator('.pp-pick[data-key="library:corner-notch"]').click();
  await card(page).locator("#modelPluginsMore").click();
  await card(page).locator('#modelPluginsMenu [data-act="reveal"]').click();
  await expect(readout(page)).toContainText("Showing corner-notch.rs in");
  await card(page).locator("#modelPluginsMore").click();
  // Remove asks in the app's sheet: Cancel keeps the plugin, Remove takes it and its older versions.
  await card(page).locator('#modelPluginsMenu [data-act="remove"]').click();
  const sheet = askSheet(page);
  await expect(sheet).toHaveAttribute("aria-modal", "true");
  await expect(sheet.locator(".ask-body")).toHaveText("It and its older versions leave your library. Parts built with it keep their code in their project.");
  await expect(sheet.locator('[data-ask="confirm"]')).toBeFocused();
  // Tab stays in the sheet: Remove, Cancel, Remove.
  await page.keyboard.press("Tab");
  await expect(sheet.locator('[data-ask="cancel"]')).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(sheet.locator('[data-ask="confirm"]')).toBeFocused();
  await page.screenshot({ path: `${shots}/sheet-remove-plugin.png` });
  await answerSheet(page, "Remove “Corner notch”?", { cancel: true });
  expect(Object.keys(await page.evaluate(() => (window as unknown as { __libraryStore: { files: Record<string, string> } }).__libraryStore.files))).toContain("corner-notch.rs");
  await card(page).locator("#modelPluginsMore").click();
  await card(page).locator('#modelPluginsMenu [data-act="remove"]').click();
  await answerSheet(page, "Remove “Corner notch”?");
  await expect(readout(page)).toContainText("Removed “Corner notch” from your library (1 file).");
  await expect(card(page).locator(".pp-pick")).toHaveCount(2);
  const log = await page.evaluate(() => (window as unknown as { __libraryLog: { command: string; args: Record<string, unknown> }[] }).__libraryLog.map((row) => [row.command, row.args.id ?? null]));
  expect(log).toContainEqual(["plugin_library_reveal", "corner-notch"]);
  expect(log).toContainEqual(["plugin_library_remove", "corner-notch"]);
});

test("Save as plugin… keeps a draft in the library after its checks, and its step becomes the plugin's", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await pluginProject(page, {
    before: both,
    edit: (doc) => {
      const first = doc.objects[0]!.modelTree.nodes.find((node) => node.plugin)!;
      first.plugin = { ...(first.plugin as Record<string, unknown>), plugin: "studs", version: 0, sha256: DRAFT_SHA };
      doc.plugins = undefined;
      doc.mcpModel = { rustRecipes: { studs: { source: DRAFT, sha256: DRAFT_SHA, params: { studs: 5 }, objects: [], changed: ["x"], at: 1 } } };
    },
  });
  const draft = page.getByRole("treeitem", { name: /^studs · draft/ });
  await expect(draft).toBeVisible();
  await draft.hover();
  await draft.locator(".mh-edit").click();
  const history = page.locator("#modelPluginCard");
  await expect(history.locator("#modelPluginSave")).toBeVisible();
  await history.locator("#modelPluginSave").click();
  const sheet = page.locator("#modelPluginSaveSheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator("#modelPluginSaveName")).toHaveValue("Studs");
  await sheet.locator("#modelPluginSaveName").fill("Stud strip");
  await sheet.locator("#modelPluginSaveDesc").fill("Studs in a row, for a test.");
  await sheet.locator("#modelPluginSaveAuthor").fill("Tester");
  await page.screenshot({ path: `${shots}/save-as-plugin.png` });
  await sheet.locator("#modelPluginSaveGo").click();
  await expect(sheet).toBeHidden();
  await expect(readout(page)).toContainText("Saved “Stud strip” as plugin stud-strip v1");
  await expect(page.getByRole("treeitem", { name: /^Stud strip · plugin v1/ })).toBeVisible();
  const saved = await page.evaluate(() => (window as unknown as { __libraryStore: { files: Record<string, string>; settings: string | null } }).__libraryStore);
  const file = saved.files["stud-strip.rs"]!;
  expect(file).toContain("//! author: Tester");
  expect(file).toContain("//! target: either");
  expect(file).toContain('"name":"studs"');
  expect(file.endsWith(DRAFT)).toBe(true);
  expect(JSON.parse(saved.settings ?? "{}")).toEqual({ author: "Tester" });
  const log = await page.evaluate(() => (window as unknown as { __recipeLog: { command: string; args: Record<string, unknown> }[] }).__recipeLog);
  const starts = log.filter((row) => row.command === "recipe_send").map((row) => JSON.parse(String(row.args.line)) as { v?: number; describe?: boolean; params?: Record<string, unknown> }).filter((msg) => msg.v === 1);
  expect(starts.map((msg) => [!!msg.describe, msg.params])).toEqual([[true, {}], [false, {}]]);
});

test("the How's Show me opens a demo plugin ready for its next change, and its Apply never touches the part", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await pluginProject(page, { before: both });
  await openPanel(page);
  await card(page).locator("#modelPluginsHowOpen").click();
  await expect(card(page).locator("#modelPluginsHow li")).toHaveCount(4);
  await card(page).locator("#modelPluginsShowMe").click();
  await expect(card(page).locator("#modelPluginsTitle")).toContainText("Drilled bar (demo)");
  await expect(card(page).locator("#modelPluginsDemo")).toContainText("Try it: change Holes to 6.");
  await expect(card(page).locator("#modelPluginsTarget")).toHaveText("Builds a new part.");
  await expect(card(page).locator('.mh-plugin-control[data-name="width"]')).toBeFocused();
  await expect(page.locator("#modelApply")).toBeDisabled();
  await expect(page.locator("#modelApply")).toHaveAttribute("data-reason", "This is a demo, so nothing is added to your part. Click Back to my plugins.");
  // The demo makes a new part: Live previews it after the change, and the plate keeps what it had.
  const objects = await page.locator("#objectList .obj").count();
  await card(page).locator('.mh-plugin-control[data-name="holes"]').fill("6");
  await expect(readout(page)).toContainText("Preview of “Drilled bar (demo)”, a new part");
  await expect(readout(page)).toContainText("Volume 4800 mm³");
  await page.screenshot({ path: `${shots}/panel-show-me.png` });
  await card(page).locator("#modelPluginsBack").click();
  await expect(card(page).locator(".pp-pick")).toHaveCount(3);
  await expect(page.locator("#objectList .obj")).toHaveCount(objects);
});

test("a plugin that builds a new part applies as a new object, stamped, and Undo takes it back", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await pluginProject(page, { before: both });
  const objects = await page.locator("#objectList .obj").count();
  await openPanel(page);
  await card(page).locator('.pp-pick[data-key="library:bolt-flange"]').click();
  await expect(card(page).locator("#modelPluginsTarget")).toHaveText("Builds a new part.");
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Applied “Bolt-circle flange” v2: bar, a new part, which Undo takes back.");
  await expect(page.locator("#objectList .obj")).toHaveCount(objects + 1);
  await expect(page.getByRole("treeitem", { name: /^Bolt-circle flange · plugin v2/ })).toHaveCount(1);
  await page.screenshot({ path: `${shots}/panel-new-part.png` });
  await page.keyboard.press("Escape");
  await page.locator("#tabPrepare").click();
  await page.keyboard.press("Control+z");
  await expect(page.locator("#objectList .obj")).toHaveCount(objects);
});

test("a plugin that reads recipe data runs from the data it carries, and one kept without it says what is missing", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await pluginProject(page, {
    before: async (p) => {
      await scriptedLibrary(p, false, { "outline-bar.rs": FILE_OUTLINE, "outline-bar-old.rs": FILE_OUTLINE_BARE });
      await scriptedRunner(p);
    },
  });
  const objects = await page.locator("#objectList .obj").count();
  await openPanel(page);
  await card(page).locator('.pp-pick[data-key="library:outline-bar"]').click();
  await expect(card(page).locator("#modelPluginsData")).toHaveText("Carries the recipe data shapes/outline (11 B): it runs the same without the files it was made from.");
  await card(page).locator("#modelPluginsLive").uncheck();

  // Preview: the run asks for its data, and the window answers from what the plugin carries; only the code is built.
  await card(page).locator("#modelPluginsPreview").click();
  await expect(readout(page)).toContainText("Preview of “Outline bar”, a new part");
  await page.screenshot({ path: `${shots}/panel-data-preview.png` });
  const log = await page.evaluate(() => (window as unknown as { __recipeLog: { command: string; args: Record<string, unknown> }[] }).__recipeLog);
  const sent = log.filter((row) => row.command === "recipe_send").map((row) => JSON.parse(String(row.args.line)) as { id?: number; ok?: boolean; result?: unknown });
  expect(sent.find((msg) => msg.id === 100)).toEqual({ id: 100, ok: true, result: { studs: 3 } });
  const built = log.filter((row) => row.command === "recipe_build").map((row) => String(row.args.source));
  expect(built.at(-1)).toContain('s.data("shapes/outline")');
  expect(built.at(-1)).not.toContain("// data: ");

  // Apply: a new part, stamped with the plugin, as any plugin's.
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Applied “Outline bar” v1");
  await expect(page.locator("#objectList .obj")).toHaveCount(objects + 1);
  await expect(page.getByRole("treeitem", { name: /^Outline bar · plugin v1/ })).toHaveCount(1);

  // Kept before plugins carried their data: the window says which data is missing and how to carry it.
  if (!(await card(page).isVisible())) await openPanel(page);
  if (await card(page).locator("#modelPluginsBack").isVisible()) await card(page).locator("#modelPluginsBack").click();
  await card(page).locator('.pp-pick[data-key="library:outline-bar-old"]').click();
  await expect(card(page).locator("#modelPluginsTitle")).toContainText("Outline bar (old)");
  await expect(card(page).locator("#modelPluginsData")).toHaveCount(0);
  await card(page).locator("#modelPluginsLive").uncheck();
  await card(page).locator("#modelPluginsPreview").click();
  await expect(card(page).locator("#modelPluginsStatus")).toContainText("This plugin reads recipe data shapes/outline, which was not kept with it.");
  await expect(card(page).locator("#modelPluginsStatus")).toContainText('nugget {action:"save", kind:"plugin", id, data:["shapes/outline"]}');
  await page.screenshot({ path: `${shots}/panel-data-missing.png` });
});

test("a plugin header with markup in its title, description, author and labels shows it as text", async ({ page }) => {
  const evil = "<img src=x onerror=alert(1)>";
  const hostile = FILE_NOTCH
    .replace("//! plugin: corner-notch", "//! plugin: hostile-notch")
    .replace("//! title: Corner notch", `//! title: ${evil} & "Co"`)
    .replace("//! description: Square notches cut along one edge, for a clip.", `//! description: ${evil} it's <b>bold</b>`)
    .replace("//! author: unknown", `//! author: ${evil}`)
    .replace('"label":"Notches"', '"label":"<i>Notches</i>"')
    .replace('"help":"How many notches along the edge."', '"help":"<script>alert(2)</script>"');
  await pluginProject(page, { before: async (p) => { await scriptedLibrary(p, false, { "hostile-notch.rs": hostile }); await scriptedRunner(p); } });
  const alerts: string[] = [];
  page.on("dialog", (dialog) => { alerts.push(dialog.message()); void dialog.dismiss(); });
  await openPanel(page);
  const row = card(page).locator('.pp-pick[data-key="library:hostile-notch"]');
  await expect(row.locator(".pp-title")).toHaveText(`${evil} & "Co"`);
  await expect(row.locator(".pp-desc")).toHaveText(`${evil} it's <b>bold</b>`);
  await expect(row.locator(".pp-by")).toHaveText(`By ${evil}`);
  await row.click();
  await expect(card(page).locator("#modelPluginsTitle")).toContainText(evil);
  await expect(card(page).locator(".mh-plugin-field").first()).toContainText("<i>Notches</i>");
  await card(page).locator("#modelPluginsMore").click();
  await card(page).locator('#modelPluginsMenu [data-act="remove"]').click();
  await expect(askSheet(page).locator("h2")).toHaveText(`Remove “${evil} & "Co"”?`);
  await answerSheet(page, /^Remove/, { cancel: true });
  // Nothing in any of it became an element: no img, script, b or i inside the card or the sheet.
  expect(await page.locator("#modelPlugins img, #modelPlugins script, #modelPlugins b, #modelPlugins i, #askSheet img, #askSheet script").count()).toBe(0);
  expect(alerts).toEqual([]);
});
