import { expect, test, type Page } from "@playwright/test";
import { openApp, still } from "./media";

/**
 * The Part card (docs/readme-media.md): an M6 nut, a 20-tooth GT2 pulley and an L-bracket, each built here, then the
 * kind select opened so its four groups show. Nothing is loaded from outside the repository.
 */
test("part card with the four groups", async ({ page }) => {
  test.setTimeout(300_000);
  await page.addInitScript(() => localStorage.setItem("lime-slice-auto-slice", "0"));
  await openApp(page);
  await page.locator("#tabModel").click();

  await makePart(page, "nut");
  const nut = (await page.locator("#modelHistoryTree [role=treeitem]").last().innerText()).replace(/\s+/g, " ").trim();
  expect(nut).toContain("Nut M6");
  console.log(`model-parts nut: ${nut}`);
  await makePart(page, "gt2");
  const groove = (await page.locator("#modelPartRow").innerText()).replace(/\s+/g, " ").trim();
  expect(groove).toContain("approximate GT2 groove");
  await expect(page.locator("#modelPartTeeth")).toHaveValue("20");
  console.log(`model-parts pulley row: ${groove}`);
  console.log("model-parts pulley teeth: 20");
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelHistoryTree [role=treeitem]").last()).toContainText("GT2 pulley 20 teeth");
  const pulley = (await page.locator("#modelHistoryTree [role=treeitem]").last().innerText()).replace(/\s+/g, " ").trim();
  console.log(`model-parts pulley: ${pulley}`);
  await expect(page.locator("#modelPanel")).toBeHidden();
  await makePart(page, "bracket");
  const bracket = (await page.locator("#modelHistoryTree [role=treeitem]").last().innerText()).replace(/\s+/g, " ").trim();
  expect(bracket).toContain("L-bracket");
  console.log(`model-parts bracket: ${bracket}`);

  await page.locator("#modelToolNew").click();
  await page.locator('#modelPrim [data-kind="part"]').click();
  await expect(page.locator("#modelPartKind")).toBeVisible();
  await page.locator("#modelPartKind").selectOption("nut");
  await expect(page.locator("#modelPartRow")).toContainText("ISO 4032");
  const groups = await page.locator("#modelPartKind optgroup").evaluateAll((rows) => rows.map((row) => row.getAttribute("label")));
  expect(groups).toEqual(["Fasteners", "Fittings", "Brackets", "Pulleys"]);
  // A closed native select does not paint its groups in a headless screenshot. Opening it as a list keeps the labels
  // in the document, which is what the picture is for. The app's own select stays a one-line control.
  await page.locator("#modelPartKind").evaluate((el) => {
    const select = el as HTMLSelectElement;
    const rows = select.querySelectorAll("option, optgroup").length;
    select.size = rows;
    const label = select.closest("label");
    if (label instanceof HTMLElement) label.style.gridColumn = "1 / -1";
    select.style.setProperty("width", "100%", "important");
    select.style.setProperty("max-width", "none", "important");
    select.style.setProperty("height", `${rows * 20}px`, "important");
    select.style.setProperty("max-height", "none", "important");
  });
  await page.locator("#modelPartKind").scrollIntoViewIfNeeded();
  await expect(page.locator(".toast-error")).toHaveCount(0);

  const history = (await page.locator("#modelHistoryTree [role=treeitem]").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
  const row = (await page.locator("#modelPartRow").innerText()).replace(/\s+/g, " ").trim();
  console.log(`model-parts groups: ${groups.join(", ")}`);
  console.log(`model-parts history: ${history.join(" | ")}`);
  console.log(`model-parts row: ${row}`);
  await still(page, "model-parts.png");
});

/** New solid, Part, and the kind. The nut and the bracket are applied here; the pulley stays open so its row can be read. */
async function makePart(page: Page, kind: "nut" | "gt2" | "bracket") {
  await page.locator("#modelToolNew").click();
  await page.locator('#modelPrim [data-kind="part"]').click();
  await expect(page.locator("#modelPartKind")).toBeVisible();
  if (kind !== "nut") await page.locator("#modelPartKind").selectOption(kind);
  await expect(page.locator("#modelPartKind")).toHaveValue(kind);
  if (kind === "gt2") return;
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelPanel")).toBeHidden({ timeout: 120_000 });
}
