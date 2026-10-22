import { expect, test, type Page } from "@playwright/test";
import { facePoints, openStress, openStressModel } from "./stress-mock";

const SHOTS = "test-results/stress-guided";

/** The left dock and the canvas, which is what the setup is about. */
async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Whether `selector` is inside the viewport and inside the dock, with no scrolling. */
async function onScreen(page: Page, selector: string) {
  return page.locator(selector).evaluate((node) => {
    const box = node.getBoundingClientRect();
    const dock = document.querySelector("#modelDock")!.getBoundingClientRect();
    return box.height > 0 && box.top >= dock.top - 1 && box.bottom <= Math.min(dock.bottom, innerHeight) + 1;
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
});

test("Stress is set up in steps: hold faces, load faces, then Run, and folding keeps the result", async ({ page }) => {
  await openStressModel(page, undefined, { width: 1440, height: 1000 });
  await openStress(page);
  const status = page.locator("#stressStatus");
  const run = page.locator("#stressRun");
  const model = page.locator("#model");

  await expect(run).toHaveAttribute("aria-disabled", "true");
  await expect(status).toHaveText("Hold the part: the bed, or pick faces.");
  expect(await onScreen(page, "#stressStatus"), "the next step is said beside Run").toBe(true);
  await expect(page.locator("#stressHoldStep [data-step-mark]")).toHaveText("1");
  await expect(page.locator("#stressEIn"), "the card's numbers wait under Edit numbers").toBeHidden();
  await expect(page.locator("#stressEdge"), "the cell size waits under Advanced").toBeHidden();
  await expect(page.locator("#stressResult")).toBeHidden();
  await shot(page, "1-opened");

  const faces = await facePoints(page);
  const top = [...faces].find(([, at]) => at.normal[2]! > 0.5);
  const side = [...faces].find(([, at]) => at.normal[1]! < -0.5);
  if (!top || !side) throw new Error(`no top or front face in ${[...faces.keys()].join(" ")}`);
  const [topFace, topAt] = top;
  const [sideFace, sideAt] = side;

  await page.locator("#stressHoldFaces").click();
  await expect(page.locator("#stressHoldFaces")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#stressHoldPick").click();
  await expect(page.locator("#stressHoldPick")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#stressHoldHint")).toBeVisible();
  await page.mouse.click(sideAt.x, sideAt.y);
  await expect(page.locator("#stressHoldChips .stress-chip")).toHaveText([`Face ${sideFace + 1}`]);
  await expect(model, "the held face is tinted on the part").toHaveAttribute("data-stress-hold", String(sideFace));
  await expect(page.locator("#modelContextBar"), "a pick for Stress is not a selection").toBeHidden();
  await expect(page.locator("#stressHoldStep")).toHaveAttribute("data-done", "");
  await expect(status).toHaveText("Pick the faces the load pushes on.");
  await shot(page, "2-hold-picking");

  await page.locator("#stressLoadPick").click();
  await expect(page.locator("#stressHoldPick"), "one pick mode at a time").toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#stressLoadPick")).toHaveAttribute("aria-pressed", "true");
  await expect(model, "no arrow before the load has a face").not.toHaveAttribute("data-stress-arrow", /./);
  await page.mouse.click(topAt.x, topAt.y);
  await expect(page.locator("#stressLoadChips .stress-chip")).toHaveText([`Face ${topFace + 1}`]);
  await expect(model).toHaveAttribute("data-stress-load", String(topFace));
  await expect(model, "the arrow sits on the loaded face").toHaveAttribute("data-stress-arrow", "5.00,5.00,10.00");
  await expect(model).toHaveAttribute("data-stress-hold", String(sideFace));
  await expect(run).toHaveAttribute("aria-disabled", "false");
  await expect(status).toHaveText("");
  await expect(page.locator("#stressLoadStep")).toHaveAttribute("data-done", "");

  // A second click on a picked face takes it out, and a third puts it back.
  await page.mouse.click(topAt.x, topAt.y);
  await expect(page.locator("#stressLoadChips .stress-chip")).toHaveCount(0);
  await expect(run).toHaveAttribute("aria-disabled", "true");
  await page.mouse.click(topAt.x, topAt.y);
  await expect(page.locator("#stressLoadChips .stress-chip")).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(page.locator("#stressLoadPick"), "Escape on the part ends the pick mode").toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#modelStressMain")).toBeVisible();
  // The arrow's head is on the face and its shaft above it; dragging the shaft turns the load.
  await page.mouse.move(topAt.x, topAt.y - 30);
  await page.mouse.down();
  await page.mouse.move(topAt.x + 80, topAt.y - 30, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator("#stressDirX")).not.toHaveValue("0");
  for (const [id, value] of [["#stressDirX", "0"], ["#stressDirY", "0"], ["#stressDirZ", "-1"]] as const) {
    await page.locator(id).fill(value);
    await page.locator(id).press("Tab");
  }
  await page.locator("#stressForce").fill("25");
  await page.locator("#stressForce").press("Tab");
  await shot(page, "3-ready");

  await run.click();
  await expect(page.locator("#stressResult")).toBeVisible();
  await expect(model).toHaveAttribute("data-stress-solid", "hidden");
  await expect(model, "the result's colours replace the tint").not.toHaveAttribute("data-stress-hold", /./);
  await expect(page.locator("#stressLegend")).toContainText("In-house estimate · as sliced");
  await expect(page.locator("#stressMargins")).toContainText("Safety factor ≥ 1.0");
  await expect(status).toHaveText("");
  expect(await onScreen(page, "#stressRun"), "Run stays in the foot").toBe(true);
  const sent = await page.evaluate(() => (window as unknown as { __limeSimBodies?: string[] }).__limeSimBodies ?? []);
  const body = JSON.parse(sent.at(-1) ?? "{}") as { study?: { holds?: { kind: string }[]; loads?: { force?: number[]; region?: { kind: string } }[]; checkResolution?: boolean } };
  expect(body.study?.holds?.map((hold) => hold.kind)).toEqual(["region"]);
  expect(body.study?.loads?.[0]?.region?.kind).toBe("faces");
  expect(body.study?.loads?.[0]?.force).toEqual([0, 0, -25]);
  expect(body.study?.checkResolution).toBe(true);
  await shot(page, "4-result");

  await page.locator("#modelStressToggle").click();
  await expect(page.locator("#modelStressMain")).toBeHidden();
  await expect(page.locator("#stressLegend"), "a folded study keeps its colours").toBeVisible();
  await expect(model).toHaveAttribute("data-stress-solid", "hidden");
  await page.locator("#modelStressToggle").click();
  await expect(page.locator("#stressResult")).toBeVisible();
  await expect(page.locator("#stressMargins")).toContainText("Safety factor ≥ 1.0");
  await expect(page.locator("#stressLoadChips .stress-chip")).toHaveCount(1);

  await page.locator("#stressCancel").click();
  await expect(page.locator("#modelStressMain")).toBeHidden();
  await expect(page.locator("#stressLegend")).toBeHidden();
  await expect(model).toHaveAttribute("data-stress-solid", "shown");
  await expect(model).not.toHaveAttribute("data-stress-load", /./);
});

test("a run with no hold says so beside Run, and Escape ends a pick mode before it folds", async ({ page }) => {
  await openStressModel(page);
  await openStress(page);
  const status = page.locator("#stressStatus");
  // aria-disabled, not disabled: the press still lands and the reason is read out.
  await page.locator("#stressRun").click({ force: true });
  await expect(status).toHaveText("Hold the part: the bed, or pick faces.");
  expect(await page.evaluate(() => (window as unknown as { __limeSimBodies?: string[] }).__limeSimBodies?.length ?? 0)).toBe(0);

  await page.locator("#stressBed").click();
  await expect(page.locator("#stressBedHint")).toHaveText("The faces that sit on the bed are held.");
  await expect(status).toHaveText("Pick the faces the load pushes on.");
  await expect(page.locator("#model")).not.toHaveAttribute("data-stress-hold", /./);

  await page.locator("#stressLoadPick").click();
  await expect(page.locator("#stressLoadPick")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#stressLoadPick").press("Escape");
  await expect(page.locator("#stressLoadPick")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#modelStressMain"), "the first Escape only ended picking").toBeVisible();
  await page.locator("#stressLoadPick").press("Escape");
  await expect(page.locator("#modelStressMain")).toBeHidden();

  await page.locator("#modelStressToggle").click();
  await page.locator("#stressLoadPick").click();
  await page.locator("#modelPickEdge").click();
  await expect(page.locator("#stressLoadPick"), "the Edge filter ends a pick mode").toHaveAttribute("aria-pressed", "false");
  await page.locator("#modelPickFace").click();
  await page.locator("#stressLoadPick").click();
  await page.locator("#modelToolNew").click();
  await expect(page.locator("#stressLoadPick"), "a model tool ends a pick mode").toHaveAttribute("aria-pressed", "false");
});
