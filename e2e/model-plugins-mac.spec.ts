import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { pluginProject } from "./plugin-fixture";
import { scriptedLibrary, scriptedRunner } from "./plugins-scripted";

/**
 * --- The Plugins panel where lust is absent (docs/plan-recipe-plugins.md D15, milestone 7): the macOS app. The panel
 * still lists the library and shows each form, read-only, with one sentence; Preview and Apply are greyed with that
 * reason; the menu's Reveal in folder still works. History keeps the part as built and offers no Use v4 that could run.
 */

const shots = "test-results/plugins-panel";
const MAC = "Running plugins needs lust, which the macOS app does not ship yet. Projects open, and parts built with plugins are kept as built.";

async function macApp(page: Page) {
  await scriptedLibrary(page);
  await scriptedRunner(page, false);
}

test("without lust the panel lists plugins and shows their forms read-only, with the reason on every greyed button", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await pluginProject(page, { before: macApp });
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuPlugins").click();
  const card = page.locator("#modelPlugins");
  await expect(card.locator(".pp-pick")).toHaveCount(3);
  await card.locator('.pp-pick[data-key="library:stud-row"]').click();
  await expect(card.locator("#modelPluginsReadOnly")).toHaveText(MAC);
  const studs = card.locator('.mh-plugin-control[data-name="studs"]');
  await expect(studs).toHaveValue("3");
  await expect(studs).toHaveJSProperty("readOnly", true);
  await expect(card.locator("#modelPluginsPreview")).toBeDisabled();
  await expect(card.locator("#modelPluginsPreview")).toHaveAttribute("data-reason", MAC);
  await expect(page.locator("#modelApply")).toBeDisabled();
  await expect(page.locator("#modelApply")).toHaveAttribute("data-tip", `Run the plugin and keep the result as one History step. Undo takes it back.\n${MAC}`);
  await page.screenshot({ path: `${shots}/panel-mac.png` });

  // Reveal in folder needs no lust.
  await card.locator("#modelPluginsMore").click();
  await card.locator('#modelPluginsMenu [data-act="reveal"]').click();
  await expect(page.locator("#modelReadout")).toContainText("Showing stud-row.rs in");

  // History: the part stays as built; Use v4 is shown but cannot run here, and says why.
  await page.keyboard.press("Escape");
  const plugin = page.getByRole("treeitem", { name: /^Stud row · plugin v3/ });
  await plugin.hover();
  await plugin.locator(".mh-edit").click();
  const history = page.locator("#modelPluginCard");
  await expect(history.locator(".mh-plugin-hint")).toContainText("Running plugins needs lust, which the macOS app does not ship yet.");
  await expect(history.locator("#modelPluginUse")).toBeDisabled();
  await expect(history.locator("#modelPluginUse")).toHaveAttribute("data-tip", /does not ship yet\. The step stays as built\.$/);
});
