import type { Page } from "@playwright/test";

/**
 * Serve `result` through the job routes, finished on the first event. A 404 from `POST /api/jobs`
 * would fall back to `/api/slice`, but the browser logs every 4xx as a console error.
 */
export async function serveSliceJob(page: Page, result: unknown) {
  const done = JSON.stringify({ id: "1", stage: "emit", done: 1, total: 1, fraction: 1, status: "done" });
  await page.route("**/api/jobs**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (/\/api\/jobs\/?$/.test(path)) return route.fulfill({ status: 202, json: { id: "1" } });
    if (path.endsWith("/events")) return route.fulfill({ contentType: "text/event-stream", body: `data: ${done}\n\n` });
    if (path.endsWith("/result")) return route.fulfill({ json: result });
    return route.fulfill({ contentType: "application/json", body: done });
  });
}
