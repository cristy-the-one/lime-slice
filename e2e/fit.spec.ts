import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { serveSliceJob } from "./serve-job.ts";
import { autoSliceOff } from "./auto-slice";

const longPrint = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/long-print.json"), "utf8"));

const windows = [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }];
const rightWidths = [240, 320, 560];
const leftWidths = [180, 240, 300, 480];

/** Readouts that must show whole: tiles, feature rows, slice stats, active layer and diagnostics, strategy rows. */
const RIGHT_READOUTS = ".big > div, .big b, .big small, table.est td, .est-row, .est-row > *, .stats > div, .stats span, .stats b, .kv dt, .kv dd, .chip, .btn";
const LEFT_READOUTS = ".strat, .strat > *, .panel-head, .profile-row, .find-row, .grid3 label, .grid3, .mod-row, .mod-adds, .mod-adds .btn, .obj-tools";

async function openLongPrint(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await serveSliceJob(page, longPrint);
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#slice").click();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  await expect(page.locator("#estimate")).toContainText("Time by feature");
}

async function setPanels(page: Page, left: number, right: number) {
  await page.evaluate(([l, r]) => {
    const workspace = document.querySelector<HTMLElement>(".workspace")!;
    workspace.style.setProperty("--panel-left", `${l}px`);
    workspace.style.setProperty("--panel-right", `${r}px`);
    window.dispatchEvent(new Event("resize"));
  }, [left, right]);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/** What in `selector`'s matches is cut off: text wider than its box, a wrapped label, an input or select showing less than its text. */
async function clipped(page: Page, panel: string, selector: string) {
  return page.evaluate(([panelSel, sel]) => {
    const root = document.querySelector<HTMLElement>(panelSel)!;
    const canvas = document.createElement("canvas").getContext("2d")!;
    const out: string[] = [];
    const name = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${[...el.classList].join(".")} "${(el.textContent ?? "").trim().slice(0, 24)}"`;
    for (const el of root.querySelectorAll<HTMLElement>(sel)) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || getComputedStyle(el).display === "none") continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push(`${name(el)} scrollWidth ${el.scrollWidth} > ${el.clientWidth}`);
    }
    const controls = root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(":is(.panel-head, .grid3) :is(input:not([type=checkbox]):not([type=file]), select)");
    for (const el of controls) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || getComputedStyle(el).visibility === "hidden") continue;
      const style = getComputedStyle(el);
      canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const text = el instanceof HTMLSelectElement ? el.selectedOptions[0]?.textContent ?? "" : el.value || el.placeholder;
      const spare = el instanceof HTMLSelectElement ? 24 : el.type === "number" ? 16 : 0;
      const room = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - spare;
      if (canvas.measureText(text.trim()).width > room - 8) out.push(`${name(el)} shows less than "${text.trim()}" (room ${Math.round(room)})`);
    }
    for (const label of root.querySelectorAll<HTMLElement>(".grid3 label")) {
      const range = document.createRange();
      const text = [...label.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
      if (!text) continue;
      range.selectNodeContents(text);
      if (range.getClientRects().length > 1) out.push(`${name(label)} wraps`);
    }
    return out;
  }, [panel, selector]);
}

for (const size of windows) {
  test(`readouts fit at every panel width, window ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await openLongPrint(page);
    expect.soft(await page.locator("#timing").textContent(), "top bar estimate").toContain("16 h 46 min");

    for (const right of rightWidths) {
      for (const left of leftWidths) {
        await setPanels(page, left, right);
        const where = `left ${left}, right ${right}`;
        expect(await clipped(page, "#right", RIGHT_READOUTS), `${where}: results panel`).toEqual([]);
        expect(await clipped(page, "#left", LEFT_READOUTS), `${where}: settings panel`).toEqual([]);
        const scroll = await page.evaluate(() => ["#left", "#leftBody", "#right"].map((sel) => {
          const el = document.querySelector<HTMLElement>(sel)!;
          return el.scrollWidth - el.clientWidth;
        }));
        expect(Math.max(...scroll), `${where}: horizontal scroll in settings, settings body, results`).toBeLessThanOrEqual(1);
      }
    }
  });
}

test("the top bar estimate reads whole and drops the secondary values before it clips", async ({ page }) => {
  for (const width of [1920, 1280, 960]) {
    await page.setViewportSize({ width, height: 800 });
    if (width === 1920) await openLongPrint(page);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const timing = page.locator("#timing");
    await expect(timing).toContainText("16 h 46 min");
    const fit = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>("#timing")!;
      const box = el.getBoundingClientRect();
      const neighbours = [".title-tabs", "#sliceSplit", "#printerChip"].map((sel) => document.querySelector(sel)?.getBoundingClientRect()).filter((b) => b && b.width > 0);
      const overlaps = neighbours.some((b) => b && box.left < b.right - 0.5 && box.right > b.left + 0.5 && box.top < b.bottom && box.bottom > b.top);
      return { clipped: el.scrollWidth - el.clientWidth, overlaps, text: el.textContent };
    });
    expect(fit.clipped, `${width}: ${fit.text}`).toBeLessThanOrEqual(1);
    expect(fit.overlaps, `${width}: ${fit.text}`).toBe(false);
  }
  await page.setViewportSize({ width: 1920, height: 800 });
  await expect(page.locator("#timing")).toHaveText("16 h 46 min · 162.6 g · €3.25", { useInnerText: true });
});
