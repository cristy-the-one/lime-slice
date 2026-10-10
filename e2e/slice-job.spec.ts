import { expect, test, type Page, type Route } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

type JobMode = "finish" | "hold" | "missing";

function snapshot(stage: string, fraction: number, status: "running" | "done") {
  return { id: "7", stage, done: status === "done" ? 4 : 2, total: 4, fraction, status };
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

/** Mock `/api/jobs`. `finish` completes on the poll fallback; `hold` stays running; `missing` is a 404. */
async function mockJobs(page: Page, mode: JobMode) {
  const calls: string[] = [];
  let polls = 0;
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/cancel", (route) => {
    calls.push("POST /api/cancel");
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/slice", (route) => {
    calls.push("POST /api/slice");
    return route.fulfill({ json: cube });
  });
  await page.route("**/api/jobs**", async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const jobRoot = /\/api\/jobs\/?$/.test(url.pathname);
    if (method === "POST" && jobRoot) {
      calls.push("POST /api/jobs");
      if (mode === "missing") {
        await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
        return;
      }
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: "7" }) });
      return;
    }
    if (method === "POST" && url.pathname.endsWith("/cancel")) {
      calls.push("POST /api/jobs/7/cancel");
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (method === "GET" && url.pathname.endsWith("/result")) {
      calls.push("GET /api/jobs/7/result");
      await route.fulfill({ json: cube });
      return;
    }
    if (method === "GET" && url.pathname.endsWith("/events")) {
      calls.push("GET /api/jobs/7/events");
      const cut = JSON.stringify(snapshot("cut", 0.08, "running"));
      const part = JSON.stringify(snapshot("part", 0.4, "running"));
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${cut}\n\ndata: ${part}\n\n`,
      });
      return;
    }
    if (method === "GET" && /\/api\/jobs\/7\/?$/.test(url.pathname)) {
      polls += 1;
      calls.push("GET /api/jobs/7");
      await new Promise((resolve) => setTimeout(resolve, 120));
      const body = mode === "finish" && polls >= 2 ? snapshot("emit", 1, "done") : snapshot("part", 0.4, "running");
      await route.fulfill({ json: body });
      return;
    }
    await route.fallback();
  });
  return calls;
}

async function openCube(page: Page) {
  await page.goto("/");
  await page.getByText("Samples", { exact: true }).click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
}

test("a job stream shows the stage, then the slice result", async ({ page }) => {
  const calls = await mockJobs(page, "finish");
  await openCube(page);
  await page.locator("#slice").click();
  await expect(page.locator("#timing")).toContainText(/Slicing layers|Walls and infill/);
  await expect(page.locator("#sliceMeter")).toContainText("%");
  await expect(page.locator("#timing")).toContainText("Walls and infill");
  await expect(page.locator("#toasts .toast")).toHaveCount(0);
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current", { timeout: 15_000 });
  expect(calls).toContain("POST /api/jobs");
  expect(calls).toContain("GET /api/jobs/7/result");
  expect(calls).not.toContain("POST /api/slice");
  expect(calls).not.toContain("POST /api/cancel");
});

test("Cancel stops that job and leaves the synchronous cancel route alone", async ({ page }) => {
  const calls = await mockJobs(page, "hold");
  await openCube(page);
  await page.locator("#slice").click();
  await expect(page.locator("#cancel")).toBeVisible();
  await expect(page.locator("#sliceMeter")).toContainText("Walls and infill");
  await page.locator("#cancel").click();
  await expect(page.locator("#cancel")).toBeHidden();
  await expect(page.locator("#toasts .toast")).toHaveCount(0);
  await expect(page.locator("#timing")).toHaveText("");
  expect(calls).toContain("POST /api/jobs/7/cancel");
  expect(calls).not.toContain("POST /api/cancel");
  expect(calls).not.toContain("GET /api/jobs/7/result");
});

test("a slicer without /api/jobs still slices through /api/slice", async ({ page }) => {
  const calls = await mockJobs(page, "missing");
  await openCube(page);
  await page.locator("#slice").click();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current", { timeout: 15_000 });
  expect(calls).toContain("POST /api/jobs");
  expect(calls).toContain("POST /api/slice");
  await expect(page.locator("[data-state=slicing]")).toHaveCount(0);
});

test.describe("compact job progress", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });

  test("the preview pill names the stage and the canvas stays in front", async ({ page }) => {
    const calls = await mockJobs(page, "hold");
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
    await expect(page.locator("#compactFile")).toContainText("calibration_cube");
    await page.locator("#slice").click();
    await page.locator("#compactTabs [data-tab=preview]").click();
    const progress = page.locator("#compactProgress");
    await expect(progress).toHaveAttribute("data-on", "1");
    await expect(progress).toContainText("Walls and infill");
    await expect(page.locator("#cancel")).toBeVisible();
    const view = await share(page, "#view3d");
    expect(view, `preview share ${view}`).toBeGreaterThanOrEqual(0.7);
    await page.locator("#cancel").click();
    await expect(page.locator("#cancel")).toBeHidden();
    expect(calls).toContain("POST /api/jobs/7/cancel");
    await expect(progress).toHaveAttribute("data-on", "0");
  });
});
