import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { pluginProject } from "./plugin-fixture";
import { scriptedLibrary, scriptedRunner } from "./plugins-scripted";

/**
 * --- Nuggets in the window (docs/plan-recipe-ingredients.md I9–I16). The Plugins panel lists every kind the library
 * keeps, as `nugget find` does for an agent: plugins, ingredients, presets and lessons, with kind chips and one search.
 * An ingredient opens to what it gives and the line that imports it; a lesson is removed in one click; the form keeps
 * its values as a preset and removes one; and the Model tool's card shows the lessons about its kind of step.
 */

const readout = (page: Page) => page.locator("#modelReadout");
const card = (page: Page) => page.locator("#modelPlugins");
const shots = "test-results/nuggets-panel";

type Store = { presets: Record<string, string>; lessons: string | null; ingredients: Record<string, string> };
const store = (page: Page) => page.evaluate(() => (window as unknown as { __libraryStore: Store }).__libraryStore);

async function both(page: Page) {
  await scriptedLibrary(page, true);
  await scriptedRunner(page);
}

async function openPanel(page: Page) {
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuPlugins").click();
  await expect(page.locator("#modelPanelTitle")).toHaveText("Plugins");
  await expect(card(page)).toBeVisible();
}

test("the panel lists every kind of nugget, filters by kind, searches them all, and opens an ingredient", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await pluginProject(page, { before: both });
  await page.evaluate(() => localStorage.removeItem("lime-slice-plugins-kind"));
  await openPanel(page);

  // All: each kind with its count, plugins first, then ingredients, presets and lessons.
  const chips = card(page).locator(".pp-kind");
  await expect(chips).toHaveText(["All", "Plugins 3", "Ingredients 1", "Presets 1", "Lessons 2"]);
  await expect(card(page).locator('.pp-kind[data-kind="all"]')).toHaveAttribute("aria-pressed", "true");
  await expect(card(page).locator(".pp-section-title")).toHaveText(["Your plugins", "Ingredients", "Presets", "Lessons"]);
  await page.screenshot({ path: `${shots}/all.png` });

  // A chip shows one kind; the choice stays for the next visit.
  await card(page).locator('.pp-kind[data-kind="lesson"]').click();
  await expect(card(page).locator(".pp-section-title")).toHaveText(["Lessons"]);
  await expect(card(page).locator(".pp-lesson")).toHaveCount(2);
  await expect(card(page).locator(".pp-lesson").first().locator(".pp-about")).toHaveText("boolean");
  expect(await page.evaluate(() => localStorage.getItem("lime-slice-plugins-kind"))).toBe("lesson");

  // One search across the kinds; a kind with no match says so and names the way out.
  await card(page).locator('.pp-kind[data-kind="all"]').click();
  const search = card(page).locator("#modelPluginsSearch");
  await search.fill("pocket");
  await expect(card(page).locator(".pp-section-title")).toHaveText(["Ingredients", "Lessons"]);
  await search.fill("skin");
  await expect(card(page).locator(".pp-section-title")).toHaveText(["Lessons"]);
  await card(page).locator('.pp-kind[data-kind="ingredient"]').click();
  await expect(card(page).locator(".pp-empty")).toHaveText("No ingredient matches “skin”. Try another word, show All, or clear the search.");
  await search.fill("cells");
  await search.press("Enter");

  // The ingredient: what it gives, how a recipe imports it (latest, or a kept version), who carries it, its menu.
  await expect(card(page).locator("#modelPluginsTitle")).toContainText("Honeycomb cells v2");
  await expect(card(page).locator("#modelIngredientUse")).toHaveText("A recipe imports it with use ingredients::honeycomb::*;, or a kept version with ingredients::honeycomb::v1.");
  await expect(card(page).locator("#modelIngredientItems li")).toHaveText(["fn cells", "const NODE_R"]);
  await expect(card(page).locator("#modelIngredientUsers")).toContainText("No plugin in your library carries it yet.");
  await expect(page.locator("#modelApply")).toBeDisabled();
  await page.screenshot({ path: `${shots}/ingredient.png` });
  await card(page).locator("#modelPluginsMore").click();
  await card(page).locator('#modelPluginsMenu [data-act="reveal"]').click();
  await expect(readout(page)).toContainText("Showing ingredients/honeycomb.rs in");
  await card(page).locator("#modelPluginsMore").click();
  page.once("dialog", (dialog) => void dialog.accept());
  await card(page).locator('#modelPluginsMenu [data-act="remove"]').click();
  await expect(readout(page)).toContainText("Removed the ingredient “Honeycomb cells” (2 files).");
  expect(Object.keys((await store(page)).ingredients)).toEqual([]);
  const log = await page.evaluate(() => (window as unknown as { __libraryLog: { command: string; args: Record<string, unknown> }[] }).__libraryLog.map((row) => [row.command, row.args.id ?? null, row.args.kind ?? null]));
  expect(log).toContainEqual(["plugin_library_reveal", "honeycomb", "ingredient"]);
  expect(log).toContainEqual(["plugin_library_remove", "honeycomb", "ingredient"]);
});

test("a lesson is removed from the list, and the Model tool's card shows the lessons about its kind of step", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await pluginProject(page, { before: both });
  // Boolean is open after the fixture's cuts: its card reads the boolean lesson once the library is read.
  await openPanel(page);
  await page.keyboard.press("Escape");
  await page.locator("#modelToolBoolean").click();
  const lessons = page.locator("#modelLessons");
  await expect(lessons).toBeVisible();
  await expect(lessons.locator("h4")).toHaveText("Seen in practice");
  await expect(lessons.locator("li")).toHaveText(["A cut tool flush with a face leaves a skin; make it 0.1 mm longer."]);
  await page.screenshot({ path: `${shots}/boolean-lessons.png` });
  // Another tool has none of its own: the box hides.
  await page.locator("#modelToolShell").click();
  await expect(lessons).toBeHidden();

  // Removing the lesson in the panel takes it off the card too.
  await openPanel(page);
  await card(page).locator('.pp-kind[data-kind="lesson"]').click();
  await card(page).locator('.pp-lesson-remove[data-lesson="2"]').click();
  await expect(readout(page)).toContainText("Removed the lesson about boolean.");
  await expect(card(page).locator(".pp-lesson")).toHaveCount(1);
  expect(JSON.parse((await store(page)).lessons ?? "[]").map((row: { n: number }) => row.n)).toEqual([1]);
  await page.keyboard.press("Escape");
  await page.locator("#modelToolBoolean").click();
  await expect(lessons).toBeHidden();
});

test("the form keeps its values as a preset, checked, and removes one", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await pluginProject(page, { before: both });
  await openPanel(page);
  await card(page).locator('.pp-kind[data-kind="all"]').click();
  await card(page).locator('.pp-pick[data-key="library:stud-row"]').click();
  await card(page).locator("#modelPluginsLive").uncheck();
  const studs = card(page).locator('.mh-plugin-control[data-name="studs"]');
  const save = card(page).locator("#modelPluginsSavePreset");

  // A value out of range: the button says why, and keeps nothing.
  await studs.fill("40");
  await expect(save).toHaveAttribute("aria-disabled", "true");
  await expect(save).toHaveAttribute("data-reason", "Studs is 1 to 12. Type a value in that range.");

  // A name that is not a slug is refused with the rule; a good one is kept with every value.
  await studs.fill("8");
  await expect(save).toHaveAttribute("aria-disabled", "false");
  page.once("dialog", (dialog) => void dialog.accept("Eight Studs"));
  await save.click();
  await expect(card(page).locator("#modelPluginsStatus")).toHaveText("A preset's name is lower-case letters, digits and dashes, for example pp-5mm-wall. Type one like that.");
  page.once("dialog", (dialog) => void dialog.accept("eight-studs"));
  await save.click();
  await expect(card(page).locator("#modelPluginsStatus")).toContainText("Kept these values as the preset “eight-studs”.");
  await expect(card(page).locator("#modelPluginsPreset")).toHaveValue("eight-studs");
  await expect(studs).toHaveValue("8");
  const kept = JSON.parse((await store(page)).presets["stud-row"]!) as Record<string, { params: Record<string, unknown> }>;
  expect(Object.keys(kept)).toEqual(["dense", "eight-studs"]);
  expect(kept["eight-studs"]!.params).toEqual({ studs: 8, radius: 1, gap: 4 });
  await page.screenshot({ path: `${shots}/preset-saved.png` });

  // The list finds it, and picking it opens the plugin with its values.
  await card(page).locator("#modelPluginsBack").click();
  await card(page).locator("#modelPluginsSearch").fill("eight");
  await card(page).locator('.pp-pick-preset[data-preset="eight-studs"]').click();
  await expect(card(page).locator("#modelPluginsPreset")).toHaveValue("eight-studs");
  await expect(studs).toHaveValue("8");

  // Remove preset asks first, then the library forgets it; the form keeps its values.
  page.once("dialog", (dialog) => void dialog.accept());
  await card(page).locator("#modelPluginsRemovePreset").click();
  await expect(card(page).locator("#modelPluginsStatus")).toHaveText("Removed the preset “eight-studs”. The form keeps its values.");
  expect(Object.keys(JSON.parse((await store(page)).presets["stud-row"]!))).toEqual(["dense"]);
  await expect(studs).toHaveValue("8");
});
