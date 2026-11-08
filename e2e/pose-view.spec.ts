import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

/**
 * Pose M1 (docs/plan-pose.md, section 4). A fifth stage draws every object at its assembled pose, solid in Model's
 * look, with the selected part in the pose colour. Nothing there turns transparent, a click selects, and the print
 * layout does not move.
 */

const shots = process.env.LIME_SHOTS ?? path.join("test-results", "pose");

type Box = number[];

async function commit(page: Page, id: "#placeX" | "#placeY", value: number) {
  await page.locator(id).fill(String(value));
  await page.locator(id).press("Tab");
}

function boxes(raw: string | null): Record<string, Box> {
  return Object.fromEntries((raw ?? "").split(" ").filter(Boolean).map((entry) => {
    const [id, numbers] = entry.split(":");
    return [id!, numbers!.split(",").map(Number)];
  }));
}

/** The cube ("part") at (100, 100) and the ledge at (60, 60) on the bed, the ledge selected. Returns the ledge's id. */
async function cubeAndLedge(page: Page): Promise<string> {
  await page.addInitScript(() => {
    localStorage.setItem("lime-slice-theme", "dark");
    localStorage.setItem("lime-slice-closed-groups", "[]");
  });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
  await commit(page, "#placeX", 100);
  await commit(page, "#placeY", 100);
  await page.locator("#plateAddFile").setInputFiles("samples/overhang_ledge.stl");
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await commit(page, "#placeX", 60);
  await commit(page, "#placeY", 60);
  const id = await page.locator("#prepare").getAttribute("data-plate-selected");
  expect(id).toBeTruthy();
  return id!;
}

/** Clicks the canvas where `fx`, `fy` (fractions of its size) fall, and returns what the view picked. */
async function clickPose(page: Page, fx: number, fy: number): Promise<string> {
  const box = (await page.locator("#pose").boundingBox())!;
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  return (await page.locator("#pose").getAttribute("data-picked")) ?? "";
}

test("Pose draws every part solid at its assembled pose, tints the selection, and leaves the print layout", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  const ledge = await cubeAndLedge(page);
  const layoutBefore = await placeFields(page, [ledge, "part"]);
  await page.locator(`[data-plate-select='${ledge}']`).click();

  // Key 5 opens Pose, the fifth tab.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("5");
  await expect(page.locator("#tabPose")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#poseBody")).toBeVisible();
  await expect(page.locator("#prepareBody")).toBeHidden();
  const pose = page.locator("#pose");
  await expect(pose).toHaveAttribute("data-opaque", "true");
  await expect(pose).toHaveAttribute("data-selected", ledge);
  await expect(pose).toHaveAttribute("data-looks", `${ledge}:selected`);
  await expect(pose).toHaveAttribute("data-pose-color", "#f2846f");
  const posed = boxes(await pose.getAttribute("data-posed"));
  expect(Object.keys(posed).sort(), "both objects are drawn").toEqual([ledge, "part"].sort());
  // Neither file was moved in model space, so both stand on one spot, centred on the bed, on the plate.
  for (const id of [ledge, "part"]) expect(posed[id]![2], `${id} stands on the plate`).toBeCloseTo(0, 1);
  const size = await pose.evaluate((el) => [el.clientWidth, el.clientHeight]);
  expect(size[0]).toBeGreaterThan(600);
  expect(size[1]).toBeGreaterThan(500);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, "pose-selected.png") });

  // The list selects, and the view follows.
  await page.locator("[data-pose-action='select'][data-object='part']").click();
  await expect(pose).toHaveAttribute("data-selected", "part");
  await expect(pose).toHaveAttribute("data-looks", "part:selected");

  // A click on a part selects it; a click on empty space keeps the selection.
  const picked = await clickPose(page, 0.5, 0.5);
  expect([ledge, "part"]).toContain(picked);
  await expect(pose).toHaveAttribute("data-selected", picked);
  await expect(page.locator(`#objectList .obj[data-plate-id='${picked}']`)).toHaveAttribute("data-selected", "true");
  expect(await clickPose(page, 0.03, 0.08), "the corner of the stage is empty").toBe("");
  await expect(pose).toHaveAttribute("data-selected", picked);

  // The camera presets: the chip and the T, Y, I keys.
  await page.locator("#poseViewPresets [data-pose-view='top']").click();
  await expect(pose).toHaveAttribute("data-camera-preset", "top");
  await page.keyboard.press("y");
  await expect(pose).toHaveAttribute("data-camera-preset", "front");
  await page.keyboard.press("i");
  await expect(pose).toHaveAttribute("data-camera-preset", "iso");

  // The light theme keeps the dark viewport, and so the same coral.
  await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>("#theme")!;
    select.value = "light";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(pose).toHaveAttribute("data-pose-color", "#f2846f");

  // Back in Prepare, the print layout is where it was.
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#prepareBody")).toBeVisible();
  expect(await placeFields(page, [ledge, "part"])).toEqual(layoutBefore);
});

/** Each object's Place X and Y in Prepare, selecting it to read them. */
async function placeFields(page: Page, ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    await page.locator(`[data-plate-select='${id}']`).click();
    await expect(page.locator(`#objectList .obj[data-plate-id='${id}']`)).toHaveAttribute("data-selected", "true");
    out.push(`${id} ${await page.locator("#placeX").inputValue()} ${await page.locator("#placeY").inputValue()}`);
  }
  return out;
}

test("Pose draws assembled poses as the Assembly view does, and tints crossing parts amber", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  const ledge = await cubeAndLedge(page);
  await page.locator("[data-plate-select='part']").click();
  await page.locator(`[data-plate-attach='${ledge}']`).click();
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  await page.locator("[data-assembly-view='assembly']").click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-clashing", [ledge, "part"].sort().join(" "));
  const assembled = boxes(await page.locator("#prepare").getAttribute("data-assembled"));

  await page.locator("#tabPose").click();
  const pose = page.locator("#pose");
  await expect(pose).toHaveAttribute("data-looks", new RegExp(`${ledge}:clash`));
  await expect(pose).toHaveAttribute("data-looks", /part:clash/);
  const posed = boxes(await pose.getAttribute("data-posed"));
  for (const id of [ledge, "part"]) {
    expect(posed[id]!.length).toBe(6);
    posed[id]!.forEach((value, axis) => expect(value, `${id} axis ${axis} matches the Assembly view`).toBeCloseTo(assembled[id]![axis]!, 1));
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, "pose-clash.png") });
});

test("Pose with an empty plate says what to do", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.locator("#tabPose").click();
  await expect(page.locator("#poseBody")).toBeVisible();
  await expect(page.locator("#poseEmpty")).toBeVisible();
});


test("Pose tints the selected part's joint chain up to its fixed anchor", async ({ page }) => {
  const ledge = await cubeAndLedge(page);
  await page.locator("[data-plate-select='part']").click();
  await page.locator(`[data-plate-attach='${ledge}']`).click();
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const doc = JSON.parse(fs.readFileSync((await download.path())!).toString("utf8"));
  const source = doc.objects.find((row: { id: string }) => row.id === ledge);
  const tip = "pose-tip";
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  source.modelPose = { m: identity, t: [80, 0, 0] };
  doc.objects.push({ ...structuredClone(source), id: tip, name: "tip.stl", modelPose: { m: identity, t: [160, 0, 0] } });
  doc.assemblies[0].members = [
    { object: "part", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
    { object: ledge, parent: "part", offset: [80, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1] } },
    { object: tip, parent: ledge, offset: [80, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1] } },
  ];
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "joints.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  await page.locator(`[data-plate-select='${tip}']`).click();
  await page.locator("#tabPose").click();
  const pose = page.locator("#pose");
  await expect(pose).toHaveAttribute("data-looks", new RegExp(`${tip}:selected`));
  await expect(pose).toHaveAttribute("data-looks", new RegExp(`${ledge}:chain`));
  await expect(pose).not.toHaveAttribute("data-looks", /part:chain/);
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, "pose-joint-chain.png") });
});
