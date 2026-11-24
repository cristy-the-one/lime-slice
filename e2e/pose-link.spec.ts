import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { linkInPose, ungroupInPose } from "./link-in-pose";

/**
 * X2: Pose's Link makes an assembly of two free parts, joins a third into it, and Ungroup on the header takes it
 * apart. One Undo takes the first link back. Both parts keep their positions.
 */

const shots = process.env.LIME_SHOTS;

interface SavedObject { id: string; modelPose?: { t: number[] }; placement?: unknown }
interface Saved { objects: SavedObject[]; assemblies?: { name: string; members: { object: string; parent: string | null }[] }[] }

async function saved(page: Page): Promise<Saved> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const [file] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  return JSON.parse(fs.readFileSync((await file.path())!, "utf8")) as Saved;
}

function stood(doc: Saved): string {
  return JSON.stringify(doc.objects.map((row) => ({ id: row.id, t: row.modelPose?.t ?? null, placement: row.placement ?? null })));
}

test("Link two free parts, link into that assembly, and Ungroup from Pose", async ({ page }) => {
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
  await page.locator("#plateAddFile").setInputFiles("samples/overhang_ledge.stl");
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  const ledge = (await page.locator("#prepare").getAttribute("data-plate-selected"))!;
  const before = stood(await saved(page));

  await page.locator("[data-plate-select='part']").click();
  await linkInPose(page, ledge, "part");
  await page.locator("#tabPose").click();
  const panel = page.locator("#posePanel");
  await expect(panel.locator("[data-pose-assembly]")).toHaveCount(1);
  await expect(panel.locator("[data-pose-assembly]")).toContainText("2 parts");
  await expect(panel.locator("[data-pose-ungroup]")).toBeInViewport();
  await expect(panel.locator("[data-pose-action='assembly-export']")).toBeInViewport();
  await expect(panel).toContainText("Link two parts to pose them together.");
  const linked = await saved(page);
  expect(stood(linked), "both parts keep their positions").toBe(before);
  expect(linked.assemblies?.map((row) => row.members.map((member) => [member.object, member.parent]))).toEqual([[["part", null], [ledge, "part"]]]);

  await page.keyboard.press("Control+z");
  await expect(panel.locator("[data-pose-assembly]"), "one Undo takes the link back").toHaveCount(0);
  await expect(panel).toContainText("Free parts");

  await linkInPose(page, ledge, "part");
  await page.locator("#plateAddFile").setInputFiles("samples/calibration_cube_20mm.stl");
  await expect(panel.locator(".pose-free")).toBeVisible();
  const third = (await page.locator("#prepare").getAttribute("data-plate-selected"))!;
  expect(third).not.toBe(ledge);
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, "pose-parts.png") });
  }
  await linkInPose(page, third, "part");
  await expect(panel.locator("[data-pose-assembly]")).toHaveCount(1);
  await expect(panel.locator("[data-pose-assembly]")).toContainText("3 parts");

  await page.locator("#tabPrepare").click();
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  await expect(page.locator("[data-assembly-layout]")).toBeVisible();
  await expect(page.locator("[data-edit-in-pose]")).toBeVisible();
  await expect(page.locator("[data-assembly-ungroup]")).toHaveCount(0);
  await expect(page.locator("[data-assembly-step]")).toHaveCount(0);
  await expect(page.locator("[data-plate-attach]")).toHaveCount(0);
  if (shots) await page.screenshot({ path: path.join(shots, "prepare-header.png") });

  await page.locator("[data-edit-in-pose]").click();
  await expect(page.locator("#tabPose")).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator("[data-pose-assembly]")).toBeVisible();
  await ungroupInPose(page);
  await expect(page.locator("[data-assembly-head]")).toHaveCount(0);
  await expect(page.locator("#export")).toHaveText("G-code");
  await expect(page.locator("#export")).toHaveAttribute("aria-label", "Export G-code");
});
