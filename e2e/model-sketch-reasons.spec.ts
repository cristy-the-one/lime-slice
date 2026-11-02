import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

/**
 * --- P1 and P3 (docs/plan-sketch-for-people.md). Every Edit and Make button says what it is for, and a greyed
 * button says what to do next, with red marks where the drawing needs it. ---
 */

const PURPOSE: Record<string, string> = {
  'button[data-sketch-tool="select"]': "Pick and drag lines and points.",
  'button[data-sketch-tool="trim"]': "Cut away the part of a line between crossings",
  'button[data-sketch-tool="offset"]': "Copy a line or outline at a distance",
  'button[data-sketch-menu="constrain"]': "Lock how lines relate",
  'button[data-sketch-tool="construction"]': "Helper lines for axes and symmetry.",
  'button[data-sketch-tool="fillet"]': "Round off a corner where two lines meet.",
  'button[data-sketch-tool="use"]': "Copy an edge of your part into the sketch",
  "button[data-sketch-extrude]": "Push a shape into a solid",
  "button[data-sketch-revolve]": "Spin a shape around a line",
  "button[data-sketch-loft]": "Blend between shapes at different heights",
  "button[data-sketch-sweep]": "Carry a shape along a route",
  "button[data-sketch-holes]": "Drill a hole at each point or circle",
};

async function openSketch(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  await page.locator("#modelEmptySketch").click();
  await expect(page.locator("#model")).toHaveAttribute("data-sketch", "editing");
}

test("every Edit and Make button says what it is for", async ({ page }) => {
  await openSketch(page);
  // The Make row's ? (P2's Show me list) is a How, not a tool.
  const buttons = page.locator("[data-sketch-section=edit] .sketch-edit > button:not([data-sketch-edit-how]), [data-sketch-section=edit] [data-sketch-menu], [data-sketch-section=make] .sketch-make > button:not([data-sketch-make-how])");
  const count = await buttons.count();
  expect(count, "the card's Edit and Make buttons").toBe(Object.keys(PURPOSE).length);
  for (const [selector, purpose] of Object.entries(PURPOSE)) {
    const button = page.locator(selector);
    await expect(button, selector).toHaveAttribute("data-tip", new RegExp(`^${purpose.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await expect(button, selector).toHaveAttribute("title", /.+/);
  }
  // A greyed button keeps its purpose, with the reason under it.
  const holes = page.locator("button[data-sketch-holes]");
  await expect(holes).toHaveAttribute("aria-disabled", "true");
  await expect(holes).toHaveAttribute("data-reason", /^Holes go into a face\. Start the sketch on a face/);
  await holes.hover();
  const tip = page.locator(".lime-tip[data-open=true]");
  await expect(tip).toContainText("Drill a hole at each point or circle");
  await expect(tip).toContainText("Holes go into a face.");
  if (process.env.LIME_SHOTS) await page.screenshot({ path: `${process.env.LIME_SHOTS}/p1-holes-tip.png` });
});

test("lines that don't close say so, with the open ends in red", async ({ page }) => {
  await openSketch(page);
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "line");
  const box = (await canvas.boundingBox())!;
  const start = { x: box.x + box.width * 0.45, y: box.y + box.height * 0.55 };
  await page.mouse.click(start.x, start.y);
  await page.mouse.move(start.x + 30, start.y);
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  for (const [length, angle] of [["30", "0"], ["20", "90"], ["26", "180"]]) {
    await hud.locator("input").nth(0).fill(length!);
    await hud.locator("input").nth(0).press("Tab");
    await hud.locator("input").nth(1).fill(angle!);
    await hud.locator("input").nth(1).press("Enter");
  }
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "line,line,line");
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-sketch-marks", "0");

  const extrude = page.locator("button[data-sketch-extrude]");
  await expect(extrude).toHaveAttribute("aria-disabled", "true");
  await expect(extrude).toHaveAttribute("data-reason", "Your lines don't close a shape yet, so the red ends need to meet. Click Close the gap, or drag one end onto the other.");
  await extrude.hover();
  await expect(page.locator(".lime-tip[data-open=true]")).toContainText("the red ends need to meet");
  await expect(canvas, "both open ends are marked").toHaveAttribute("data-sketch-marks", "2");
  await expect(canvas).toHaveAttribute("data-sketch-marks-kind", "open");
  if (process.env.LIME_SHOTS) await page.screenshot({ path: `${process.env.LIME_SHOTS}/p3-open-ends.png` });

  // The key says the same, and the marks go once the drawing changes.
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.keyboard.press("e");
  await expect(page.locator("#modelReadout")).toContainText("the red ends need to meet");
  await expect(canvas).toHaveAttribute("data-extrude", "off");
  await page.keyboard.press("Control+z");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "line,line");
  await expect(canvas).toHaveAttribute("data-sketch-marks", "0");
});
