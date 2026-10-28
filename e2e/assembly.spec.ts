import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

/**
 * Assemblies M5 (docs/plan-assemblies.md, the owner's gaps item 20). Two objects grouped in the object list; the view
 * chip draws them where they sit in the assembly; a hook lifted above the body in the assembly is not flagged as an
 * overlap there, though the bed's XY check still flags it in the print layout; a parameter moves it; a move in the
 * assembly view carries what sits on the moved part.
 */

const shots = process.env.LIME_SHOTS ?? path.join("test-results", "assembly");

type Box = number[];

async function commit(page: Page, id: "#placeX" | "#placeY", value: number) {
  await page.locator(id).fill(String(value));
  await page.locator(id).press("Tab");
}

async function assembledBoxes(page: Page): Promise<Record<string, Box>> {
  const raw = (await page.locator("#prepare").getAttribute("data-assembled")) ?? "";
  return Object.fromEntries(raw.split(" ").filter(Boolean).map((entry) => {
    const [id, numbers] = entry.split(":");
    return [id!, numbers!.split(",").map(Number)];
  }));
}

/** The cube ("part") and the ledge on one spot of the bed, the ledge selected. Returns the ledge's id. */
async function twoOnOneSpot(page: Page): Promise<string> {
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
  await commit(page, "#placeX", 100);
  await commit(page, "#placeY", 100);
  const id = await page.locator("#prepare").getAttribute("data-plate-selected");
  expect(id).toBeTruthy();
  return id!;
}

test("group two objects, see them assembled, and a lifted part is no overlap there", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  const ledge = await twoOnOneSpot(page);
  await page.locator("[data-plate-select='part']").click();
  await expect(page.locator("#plateOverlap"), "on one spot of the bed, the print layout flags them").toBeVisible();
  await expect(page.locator("#assemblyViewChip")).toBeHidden();

  // Attach the ledge to the cube: one group, the cube its root.
  await page.locator(`[data-plate-attach='${ledge}']`).click();
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  await expect(page.locator("[data-assembly-head]")).toContainText("2 parts");
  await expect(page.locator(".obj-member")).toHaveCount(2);
  await expect(page.locator("#assemblyViewChip")).toBeVisible();
  await expect(page.locator("[data-plate-attach]")).toHaveCount(0);

  // M6: both files sit at the origin of model space, so assembled they cross. The mesh pass tints both and says so.
  await page.locator("[data-assembly-view='assembly']").click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-clashing", [ledge, "part"].sort().join(" "));
  await expect(page.locator("#assemblyInterference")).toContainText("crosses");
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, "assembly-crossing.png") });
  await page.locator("[data-assembly-view='print']").click();
  await expect(page.locator("#assemblyInterference")).toHaveCount(0);

  // Lift the ledge 20 mm above the cube in the assembly, driven by a parameter: the file is where an MCP client or a
  // later Place would have put it.
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const doc = JSON.parse(fs.readFileSync((await download.path())!).toString("utf8")) as {
    parameters?: Record<string, number>;
    objects: { id: string; modelPose?: { m: number[]; t: number[] } }[];
    assemblies?: { members: { object: string; parent: string | null; offset: number[]; exprs?: unknown }[] }[];
  };
  expect(doc.assemblies?.[0]?.members.map((row) => [row.object, row.parent])).toEqual([["part", null], [ledge, "part"]]);
  const cubeAt = doc.objects.find((row) => row.id === "part")?.modelPose?.t ?? [0, 0, 0];
  const ledgeRow = doc.objects.find((row) => row.id === ledge)!;
  const offset = doc.assemblies![0]!.members[1]!.offset;
  ledgeRow.modelPose = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [cubeAt[0]! + offset[0]!, cubeAt[1]! + offset[1]!, cubeAt[2]! + 20] };
  doc.assemblies![0]!.members[1] = { object: ledge, parent: "part", offset: [offset[0]!, offset[1]!, 20], turn: [0, 0, 0], exprs: { offset: [null, null, "lift"] } } as never;
  doc.parameters = { lift: 20 };
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "assembly.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  await expect(page.locator("#plateOverlap"), "the print layout still flags the shared spot").toBeVisible();
  await page.evaluate(() => document.querySelector("#toasts")?.replaceChildren());
  await page.screenshot({ path: path.join(shots, "print-layout.png") });

  await page.locator("[data-assembly-view='assembly']").click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-view", "assembly");
  await expect(page.locator("[data-assembly-view='assembly']")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#plateOverlap"), "a lifted part is not an overlap in the assembly view").toHaveCount(0);
  const lifted = await assembledBoxes(page);
  expect(Object.keys(lifted).sort()).toEqual([ledge, "part"].sort());
  expect(lifted[ledge]![2]! - lifted.part![2]!, "the ledge sits 20 mm higher").toBeCloseTo(20, 1);
  await expect(page.locator("#prepare"), "resting on the cube's top is a touch, not a crossing").toHaveAttribute("data-clashing", "");
  await expect(page.locator("#assemblyInterference")).toHaveCount(0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, "assembly-view.png") });

  // A parameter moves the part whose offset reads it.
  await page.locator("#tabModel").click();
  await page.keyboard.press("Control+Alt+p");
  await expect(page.locator("#modelParamsMain")).toBeVisible();
  const value = page.locator("#modelParams [data-param-value]").first();
  await value.fill("35");
  await value.blur();
  await page.locator("#tabPrepare").click();
  await expect.poll(async () => {
    const boxes = await assembledBoxes(page);
    return Math.round((boxes[ledge]![2]! - boxes.part![2]!) * 10) / 10;
  }, { message: "lift 35 puts the ledge 35 mm higher" }).toBe(35);

  // A move in the assembly view: the ledge, a member, moves alone; the cube, the root, carries it.
  await page.locator(`[data-plate-select='${ledge}']`).click();
  await page.locator('#toolRail [data-tool="move"]').click();
  await expect(page.locator("#gizmoNudge")).toBeVisible();
  const before = await assembledBoxes(page);
  for (let i = 0; i < 5; i += 1) await page.getByRole("button", { name: "Nudge Z +0.1 mm" }).click();
  await expect.poll(async () => {
    const boxes = await assembledBoxes(page);
    return Math.round((boxes[ledge]![2]! - boxes.part![2]! - (before[ledge]![2]! - before.part![2]!)) * 10) / 10;
  }).toBe(0.5);
  await page.locator("[data-plate-select='part']").click();
  const grouped = await assembledBoxes(page);
  for (let i = 0; i < 3; i += 1) await page.getByRole("button", { name: "Nudge Z +0.1 mm" }).click();
  await page.waitForTimeout(200);
  const after = await assembledBoxes(page);
  expect(after[ledge]![2]! - after.part![2]!, "moving the root keeps the ledge where it sits on it").toBeCloseTo(grouped[ledge]![2]! - grouped.part![2]!, 2);

  // Back to the print layout: the bed flags the spot again. Ungroup leaves both where they are.
  await page.locator("[data-assembly-view='print']").click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-view", "print");
  await expect(page.locator("#plateOverlap")).toBeVisible();
  await page.locator("[data-assembly-ungroup]").click();
  await expect(page.locator("[data-assembly-head]")).toHaveCount(0);
  await expect(page.locator("#assemblyViewChip")).toBeHidden();
  await page.keyboard.press("Control+z");
  await expect(page.locator("[data-assembly-head]"), "Undo brings the group back").toHaveCount(1);
});
