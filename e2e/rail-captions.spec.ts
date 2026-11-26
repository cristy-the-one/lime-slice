import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

/**
 * One setting, "Names on tool buttons", draws a short name under every rail icon.
 * The names stay inside the rail: none overlaps another button, and none is clipped mid-word.
 */

const STAGES = [
  ["model", "#tabModel"],
  ["pose", "#tabPose"],
  ["prepare", "#tabPrepare"],
  ["preview", "#tabPreview"],
  ["gcode", "#tabGcode"],
] as const;

async function openApp(page: Page, size: { width: number; height: number }) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.setViewportSize(size);
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  await page.locator("#railModel[data-no-solid]").waitFor({ state: "attached" });
  await page.evaluate(() => document.fonts.ready);
}

/** A stage change with no solid hides its tools again. Put them back, then let the rail fold. */
async function showSolidTools(page: Page) {
  await page.locator("#railModel").evaluate((el) => {
    el.removeAttribute("data-no-solid");
    document.querySelector("#railModelFoot")?.removeAttribute("data-no-solid");
    window.dispatchEvent(new Event("resize"));
  });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
}

/** Visible rail tools, not the dock toggle, the gizmo keys, a menu item, or the Features chevron. */
function captionProblems(on: boolean): string[] {
  const rail = document.querySelector<HTMLElement>("#toolRail");
  if (!rail) return ["no rail"];
  const railBox = rail.getBoundingClientRect();
  const skip = (button: HTMLButtonElement) =>
    button.id === "leftToggle" ||
    button.id === "modelFeatureMore" ||
    button.closest("#gizmoNudge, [role=menu]") != null ||
    !button.checkVisibility();
  const buttons = [...rail.querySelectorAll<HTMLButtonElement>("button")].filter((button) => !skip(button));
  const problems: string[] = [];
  const boxes = buttons.map((button) => ({ button, box: button.getBoundingClientRect() }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const overlap = !(a.box.right <= b.box.left + 0.5 || a.box.left >= b.box.right - 0.5 || a.box.bottom <= b.box.top + 0.5 || a.box.top >= b.box.bottom - 0.5);
      if (overlap) problems.push(`${a.button.id || a.button.dataset.tool} overlaps ${b.button.id || b.button.dataset.tool}`);
    }
  }
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;left:-9999px;white-space:nowrap;";
  document.body.append(probe);
  for (const { button, box } of boxes) {
    const name = button.id || button.dataset.tool || button.dataset.poseTool || button.className;
    if (box.bottom > railBox.bottom + 1 || box.top < railBox.top - 1) problems.push(`${name} falls outside the rail`);
    const before = getComputedStyle(button, "::before");
    const painted = before.content.replace(/^"|"$/g, "");
    if (!on) {
      if (before.content !== "none") problems.push(`${name} still shows ${before.content}`);
      continue;
    }
    const cap = button.dataset.cap ?? "";
    if (!cap) problems.push(`${name} has no data-cap`);
    if (painted !== cap) problems.push(`${name} paints ${before.content} instead of ${cap}`);
    probe.style.font = `${before.fontWeight} ${before.fontSize}/${before.lineHeight} ${before.fontFamily}`;
    probe.textContent = cap;
    const textW = probe.getBoundingClientRect().width;
    const room = button.closest(".model-feature")?.getBoundingClientRect().width ?? box.width;
    if (textW > room + 0.5) problems.push(`${name} caption "${cap}" is ${textW.toFixed(1)}px in a ${room.toFixed(1)}px box`);
    const icon = button.querySelector(".ico")?.getBoundingClientRect();
    // The Features row paints Pocket under the pair, not inside the 24px button.
    if (icon && !button.closest(".model-feature") && icon.bottom > box.bottom - 7) problems.push(`${name} caption has no room under the icon`);
  }
  probe.remove();
  const feature = rail.querySelector<HTMLElement>(".model-feature");
  if (on && feature?.checkVisibility()) {
    const row = feature.getBoundingClientRect();
    const capTop = row.bottom - 10;
    for (const button of feature.querySelectorAll<HTMLButtonElement>("button")) {
      const box = button.getBoundingClientRect();
      if (box.bottom > capTop + 0.5) problems.push(`${button.id} overlaps the Pocket caption`);
    }
  }
  return problems;
}

for (const size of [
  { width: 1440, height: 1000 },
  { width: 1280, height: 720 },
] as const) {
  test(`names under every rail icon at ${size.width}×${size.height}, and none when the setting is off`, async ({ page }) => {
    await openApp(page, size);
    for (const [stage, tab] of STAGES) {
      await page.locator(tab).click();
      await expect(page.locator("html")).toHaveAttribute("data-stage", stage);
      if (stage === "model") await showSolidTools(page);
      const problems = await page.evaluate(captionProblems, true);
      expect(problems, problems.join("\n")).toEqual([]);
    }
    await page.locator("#railCaptions").evaluate((el: HTMLInputElement) => {
      el.checked = false;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(page.locator("html")).toHaveAttribute("data-rail-captions", "0");
    for (const [stage, tab] of STAGES) {
      await page.locator(tab).click();
      if (stage === "model") await showSolidTools(page);
      const problems = await page.evaluate(captionProblems, false);
      expect(problems, `${stage}\n${problems.join("\n")}`).toEqual([]);
    }
  });
}

test("Model's rail from Make through Frame fits a 1440×900 window with whole captions", async ({ page }) => {
  await openApp(page, { width: 1440, height: 900 });
  await showSolidTools(page);
  await expect(page.locator("#toolRail")).toBeVisible();
  const fit = await page.locator("#toolRail").evaluate((rail) => rail.scrollHeight <= rail.clientHeight + 1);
  expect(fit, "the rail fits").toBe(true);
  for (const heading of ["Make", "Shape", "Feat.", "Check", "Frame"]) {
    await expect(page.locator("#railModel .rail-caption").filter({ hasText: new RegExp(`^${heading}$`) })).toBeVisible();
  }
  const workplane = await page.locator("#modelToolWorkplane").boundingBox();
  const rail = await page.locator("#toolRail").boundingBox();
  expect(workplane, "Workplane is on the rail").not.toBeNull();
  expect(workplane!.y + workplane!.height).toBeLessThanOrEqual(rail!.y + rail!.height + 1);
  const problems = await page.evaluate(captionProblems, true);
  expect(problems, problems.join("\n")).toEqual([]);
});

test("search for tool labels, rail labels, captions, or names finds the one setting", async ({ page }) => {
  await openApp(page, { width: 1440, height: 1000 });
  await expect(page.locator("#railLabels")).toHaveCount(0);
  const row = page.locator("label.setting").filter({ has: page.locator("#railCaptions") });
  await expect(row.locator(".row-label")).toHaveText("Names on tool buttons");
  const words = await row.evaluate((el) => `${el.getAttribute("data-label") ?? ""} ${el.getAttribute("data-keywords") ?? ""}`.toLowerCase());
  for (const query of ["tool labels", "rail labels", "captions", "names"]) {
    for (const word of query.split(" ")) expect(words, query).toContain(word);
  }
  await expect(row).not.toHaveAttribute("data-tip", /1280/);
});
