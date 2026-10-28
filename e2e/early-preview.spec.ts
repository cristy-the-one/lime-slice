import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/** Auto-slice on, the app's default, so an edit re-slices by itself. */
test.use({ storageState: { cookies: [], origins: [] } });

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

/**
 * A job engine. The first job finishes at once. `hold()` keeps the next job running with its early preview ready
 * until the release runs, so the spec sees the toolpaths drawn while the tour would still be ordering.
 */
async function mockJobs(page: Page) {
  const bodies: Record<string, unknown>[] = [];
  const earlyReads: string[] = [];
  let gate: Promise<void> | null = null;
  const running = new Map<string, Promise<void>>();
  const snap = (id: string, status: string, early: boolean) =>
    JSON.stringify({ id, stage: status === "done" ? "emit" : "travel", done: 1, total: 2, fraction: status === "done" ? 1 : 0.6, status, early });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.replace(/^.*\/api\/jobs\/?/, "").split("/").filter(Boolean);
    if (parts.length === 0) {
      const id = String(bodies.length + 1);
      bodies.push(route.request().postDataJSON());
      if (gate) running.set(id, gate);
      gate = null;
      return route.fulfill({ status: 202, json: { id } });
    }
    const [id, tail] = parts;
    const held = running.get(id);
    let settled = !held;
    void held?.then(() => { settled = true; });
    await Promise.resolve();
    if (tail === "early") {
      earlyReads.push(id);
      return route.fulfill({ json: { layers: cube.layers } });
    }
    if (tail === "result") return route.fulfill({ json: cube });
    const body = snap(id, settled ? "done" : "running", !!held);
    // The stream ends without a terminal event while the job runs, so the app polls the job until it is done.
    if (tail === "events") return route.fulfill({ contentType: "text/event-stream", body: `data: ${body}\n\n` });
    return route.fulfill({ contentType: "application/json", body });
  });
  const hold = () => {
    let release = () => {};
    gate = new Promise<void>((resolve) => { release = resolve; });
    return () => release();
  };
  return { bodies, earlyReads, hold };
}

const chip = (page: Page) => page.locator("#staleChip");

test("an edit draws the new toolpaths while the tour orders them, then the reply replaces them", async ({ page }) => {
  const jobs = await mockJobs(page);
  await page.goto("/");
  await page.locator("#fileMenu > summary").click();
  await page.locator("#samples > summary").click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect.poll(() => jobs.bodies.length).toBe(1);
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  expect(jobs.bodies[0].earlyPreview, "nothing on screen yet to draw early").toBeUndefined();
  await page.locator("#tabPreview").click();

  const release = jobs.hold();
  await page.locator("#tabPrepare").click();
  await page.locator("#rotZ").click();
  await page.locator("#tabPreview").click();
  await expect.poll(() => jobs.bodies.length, { timeout: 5000 }).toBe(2);
  expect(jobs.bodies[1].earlyPreview).toBe(true);

  await expect.poll(() => jobs.earlyReads, { timeout: 5000 }).toContain("2");
  await expect(chip(page)).toContainText("Ordering", { timeout: 5000 });
  await expect(page.locator("#stage")).not.toHaveClass(/stale/);
  await expect(page.locator("#pane3d"), "the new toolpaths are drawn sharp").not.toHaveClass(/is-pending/);

  release();
  await expect(chip(page)).toBeHidden({ timeout: 5000 });
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  expect(jobs.earlyReads.filter((id) => id === "2")).toHaveLength(1);
});
