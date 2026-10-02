import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share";

const out = path.resolve("artifacts/compact");
fs.mkdirSync(out, { recursive: true });

const hull = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/hull-speed.json"), "utf8"));

/** A trunk through the hull center, so a tap in the middle of the 3D view hits it. */
const skeleton = {
  id: [1, 2],
  tree: [1, 1],
  into: [0, 1],
  live: [1, 1],
  siteX: [0, 6],
  siteY: [0, 2],
  siteZ: [20, 12],
  start: [0, 2, 4],
  xs: [0, 0, 6, 3],
  ys: [0, 0, 2, 1],
  zs: [20, 0, 12, 4],
  rs: [2.4, 3, 1.2, 1.6],
};

const gap = {
  z: [14, 22] as [number, number],
  areaMm2: 18.4,
  min: [-10, -6] as [number, number],
  max: [10, 6] as [number, number],
  outline: [[[-10, -6], [10, -6], [10, 6], [-10, 6]]],
};

function applied(kind: "prune" | "regrow") {
  return {
    status: "applied",
    changedLayers: 6,
    newlyFloatingMm2: kind === "regrow" ? -gap.areaMm2 : gap.areaMm2,
    floating: kind === "regrow" ? [] : [gap],
  };
}

function responseFor(edits: { kind: string }[] | undefined) {
  const body = structuredClone(hull);
  body.skeleton = skeleton;
  const list = edits ?? [];
  if (!list.length) {
    body.coverage = [];
    return body;
  }
  const last = list[list.length - 1].kind;
  body.coverage = last === "regrow" ? [] : [gap];
  body.supportEdits = list.map((edit) => applied(edit.kind === "regrow" ? "regrow" : "prune"));
  return body;
}

async function share(page: Page, selector: string) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height, viewW: window.innerWidth, viewH: window.innerHeight };
  }, selector);
  expect(box, selector).not.toBeNull();
  return canvasShare({ width: box!.width, height: box!.height }, { width: box!.viewW, height: box!.viewH });
}

async function dismissToasts(page: Page) {
  await page.evaluate(() => document.querySelector("#toasts")?.replaceChildren());
}

/** The sheet height animates. Measures after it has settled. */
async function settleSheet(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    const root = document.documentElement;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    root.addEventListener("transitionend", finish, { once: true });
    window.setTimeout(finish, 400);
  }));
}

test.describe("compact support editing", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });

  test("tap a tree, prune, regrow, and open the half sheet", async ({ page }) => {
    const requests: { kind: string }[][] = [];
    await page.addInitScript(() => {
      localStorage.setItem("lime-slice-theme", "dark");
      localStorage.setItem("lime-slice-settings-level", "simple");
    });
    await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
    await page.route("**/api/slice", async (route) => {
      const edits = (route.request().postDataJSON()?.supportEdits ?? []) as { kind: string }[];
      requests.push(edits);
      await route.fulfill({ json: responseFor(edits) });
    });
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="lime_hull.stl"]')?.click());
    await expect(page.locator("#compactFile")).toContainText("lime_hull");

    const prepare = await share(page, "#prepare");
    expect(prepare, `prepare share ${prepare}`).toBeGreaterThanOrEqual(0.7);

    await page.locator("#supports").evaluate((el: HTMLInputElement) => {
      el.checked = true;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.locator("#compactTabs [data-tab=preview]").click();
    await page.locator("#slice").click();
    await expect.poll(async () => page.locator("#rangeHigh").evaluate((el: HTMLInputElement) => Number(el.max))).toBeGreaterThan(0);
    await page.locator("#rangeHigh").evaluate((el: HTMLInputElement) => {
      el.value = el.max;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(300);

    const preview = await share(page, "#view3d");
    expect(preview, `preview share ${preview}`).toBeGreaterThanOrEqual(0.7);
    await expect(page.locator("#compactSupportEdit")).toBeVisible();

    await page.locator("#compactSupportEdit").click();
    await expect(page.locator("html")).toHaveAttribute("data-support-edit", "1");
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    await settleSheet(page);
    const editing = await share(page, "#view3d");
    expect(editing, `edit peek share ${editing}`).toBeGreaterThanOrEqual(0.7);
    expect(editing, `edit peek share ${editing}`).toBeLessThan(0.86);
    console.log(`viewport shares prepare=${prepare.toFixed(3)} preview=${preview.toFixed(3)} editPeek=${editing.toFixed(3)}`);
    await expect(page.locator("#compactSupportPeek")).toContainText("Tap a support");

    const canvas = page.locator("#view3d");
    const box = (await canvas.boundingBox())!;
    const x = box.width / 2;
    const y = box.height / 2;
    await canvas.click({ position: { x, y }, delay: 650 });
    await expect(page.locator("#compactSupportChip")).toBeVisible();
    await expect(page.locator("#compactSupportChipLabel")).toContainText("Tree");
    await expect(page.locator("#compactSupportChipAction")).toHaveText("Prune");
    await expect(page.locator("html")).not.toHaveClass(/chrome-hidden/);
    await dismissToasts(page);
    await page.screenshot({ path: path.join(out, "09-support-select.png") });

    await page.locator("#compactSupportChipAction").click();
    await expect(page.locator("#banner")).toContainText("unheld");
    await expect.poll(() => requests.at(-1)?.length ?? 0).toBe(1);
    expect(requests.at(-1)?.[0].kind).toBe("prune");
    await dismissToasts(page);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(out, "10-support-prune.png") });
    await page.screenshot({ path: path.join(out, "11-support-coverage.png") });

    const handle = page.locator("#compactSheetHandle");
    const handleBox = (await handle.boundingBox())!;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 12);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y - 280, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "half");
    await settleSheet(page);
    await expect(page.locator("#supportEdits")).toContainText("Delete tree");
    await expect(page.locator(".se-gap")).toContainText("Regrow");
    const view = (await canvas.boundingBox())!;
    const sheet = (await page.locator("#compactSheet").boundingBox())!;
    const half = await share(page, "#view3d");
    console.log(`viewport share half=${half.toFixed(3)} canvasGap=${(view.y + view.height - sheet.y).toFixed(2)}`);
    expect(half, `half share ${half}`).toBeGreaterThan(0.4);
    expect(half, `half share ${half}`).toBeLessThan(0.55);
    expect(Math.abs(view.y + view.height - sheet.y), "canvas ends where the sheet starts").toBeLessThan(3);
    await page.screenshot({ path: path.join(out, "12-support-half.png") });

    await page.locator('.se-gap [data-action="regrow"]').click();
    await expect.poll(() => requests.at(-1)?.some((edit) => edit.kind === "regrow")).toBe(true);
    await expect(page.locator("#banner")).not.toContainText("unheld");
    await dismissToasts(page);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(out, "13-support-regrow.png") });
  });
});
