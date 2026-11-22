/**
 * Pose export (docs/plan-pose-export.md, E1/E2/E3):
 * Exercises the Pose Export dialog for every format (STEP AP242 tree & flat, glTF binary with optional animation,
 * 3MF assembly, STL one file & ZIP per member, OBJ + MTL, Pose sheet JSON) on both Now and a stopped animation frame,
 * verifying file names, downloaded bytes, STEP assembly metadata, and that exporting a frame never mutates the pose.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";
import { autoSliceOff } from "./auto-slice";

const FAKE_STEP = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";

test("Pose Export dialog saves every format at Now and at a stopped animation frame without changing the pose", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __limePluginLibrary: unknown }).__limePluginLibrary = {
      invoke: async (command: string) => {
        if (command === "plugin_library_list") return { dir: "test-library", files: [], presets: [], settings: null, imported: null };
        throw new Error(`Unexpected library command ${command}`);
      },
    };
    const handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();
    const emit = (event: string, payload: unknown) => setTimeout(() => { for (const handler of handlers.get(event) ?? []) handler({ payload }); }, 0);
    let run = "", step = 0;
    const say = (line: unknown) => emit("recipe-line", { run, line: JSON.stringify(line) });
    (window as unknown as { __limeRecipeRunner: unknown }).__limeRecipeRunner = {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "recipe_available") return { ok: true, lust: "scripted" };
        if (command === "recipe_build") return { code: 0, stdout: "", stderr: "", exe: "/scripted/recipe", main: "/scripted/main.rs" };
        if (command === "recipe_start") { run = String(args.run); step = 0; return null; }
        if (command === "recipe_send") {
          const msg = JSON.parse(String(args.line)) as { v?: number; result?: { members?: { name: string; joint?: { kind: string } }[] } };
          if (msg.v === 1) { say({ id: 1, call: "rig", args: {}, at: { line: 2 } }); return null; }
          if (step++ === 0) {
            const name = msg.result?.members?.find((m) => m.joint?.kind === "hinge")?.name ?? "missing";
            say({ id: 2, call: "animate", args: { fps: 4, keys: [{ t: 0, rest: true, colors: { [name]: "#ff0000" } }, { t: 1, set: { [name]: 60 }, colors: { [name]: "#0000ff" } }] }, at: { line: 3 } }); return null;
          }
          say({ done: { object: "", metrics: {} } }); return null;
        }
        if (command === "recipe_close_input" || command === "recipe_kill") { emit("recipe-exit", { run, code: 0, reason: null, stderr: "" }); return null; }
        throw new Error(`Unexpected command ${command}`);
      },
      listen: async (event: string, handler: (event: { payload: unknown }) => void) => { const set = handlers.get(event) ?? new Set(); set.add(handler); handlers.set(event, set); return () => set.delete(handler); },
    };
  });

  const exportRequests: Record<string, unknown>[] = [];
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/model/tree", async (route) => {
    const req = route.request().postDataJSON() as Record<string, unknown>;
    if (req.call === "export") {
      exportRequests.push(req);
      const b64 = Buffer.from(FAKE_STEP, "utf8").toString("base64");
      await route.fulfill({ json: { ok: true, bytesBase64: b64, byteLength: FAKE_STEP.length, solids: 2 } });
      return;
    }
    if (req.call === "open") {
      await route.fulfill({
        json: {
          ok: true,
          id: 0,
          editable: true,
          positions: [0, 0, 0, 10, 0, 0, 0, 10, 0],
          triangles: [0],
          faces: [],
          edges: [],
          bounds: { min: [0, 0, 0], max: [10, 10, 10] },
          volumeMm3: 1000,
          openEdges: 0,
          nonManifoldEdges: 0,
        },
      });
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);

  // Build a two-part assembly with a hinged child and an animation plugin.
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
  await page.locator("#plateAddFile").setInputFiles("samples/overhang_ledge.stl");
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  const child = (await page.locator("#prepare").getAttribute("data-plate-selected"))!;
  await page.locator("[data-plate-select='part']").click();
  await page.locator(`[data-plate-attach='${child}']`).click();
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);

  const [saved] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const doc = JSON.parse(readFileSync((await saved.path())!, "utf8"));
  doc.assemblies[0].name = "Test Arm";
  const member = doc.assemblies[0].members.find((m: { object: string }) => m.object === child);
  member.offset = [60, 0, 0];
  member.joint = { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1], min: -90, max: 90, angle: 0 };
  // Give both parts minimal SavedTree modelTrees so the mocked STEP export path runs cleanly.
  for (const obj of doc.objects) {
    obj.modelTree = {
      rootPrimitive: { primitive: "box", origin: [0, 0, 0], size: [20, 20, 20], radius: 10, height: 20, turn: [0, 0, 0] },
      nodes: [{ id: 0, parent: null, op: null, fingerprint: null }],
      current: 0,
      committed: 0,
      nextId: 1,
    };
  }
  const body = "fn main() {}\n";
  const hash = createHash("sha256").update(body).digest("hex");
  doc.plugins = {
    [hash]: `//! ---\n//! plugin: pose-test\n//! title: Test animation\n//! kind: animation\n//! api: 1.8\n//! source-sha256: ${hash}\n//! params: []\n//! ---\n${body}`,
  };

  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "arm.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await page.locator(`[data-plate-select='${child}']`).click();
  await page.locator("#tabPose").click();
  await expect(page.locator("[data-pose-action='pose-export']")).toBeVisible();

  const pose = page.locator("#pose");
  const restPosed = (await pose.getAttribute("data-posed"))!;

  // Helper to open Export dialog and run one export.
  const openExportDialog = async () => {
    await page.locator("[data-pose-action='pose-export']").first().click();
    const dlg = page.locator("[data-pose-export-dialog]");
    await expect(dlg).toBeVisible();
    return dlg;
  };

  // 1. STEP AP242 assembly tree (default) at Now.
  {
    const dlg = await openExportDialog();
    await expect(dlg.locator("[data-pose-export='config']")).toHaveValue("now");
    await expect(dlg.locator("[data-pose-export='filename']")).toHaveValue("test-arm-pose.step");
    const [dl] = await Promise.all([page.waitForEvent("download"), dlg.locator("[data-pose-export-action='submit']").click()]);
    expect(dl.suggestedFilename()).toBe("test-arm-pose.step");
    expect(readFileSync((await dl.path())!, "utf8")).toContain("AP242");
    expect(exportRequests.at(-1)?.assembly).toBeTruthy();
    await expect(dlg).toHaveCount(0);
  }

  // 2. STEP flat option at Now.
  {
    const dlg = await openExportDialog();
    await dlg.locator("[data-pose-export='step']").selectOption("flat");
    const [dl] = await Promise.all([page.waitForEvent("download"), dlg.locator("[data-pose-export-action='submit']").click()]);
    expect(dl.suggestedFilename()).toBe("test-arm-pose.step");
    expect(exportRequests.at(-1)?.assembly).toBeUndefined();
    await expect(dlg).toHaveCount(0);
  }

  // 3. GLB at Now.
  {
    const dlg = await openExportDialog();
    await dlg.locator("[data-pose-export='format']").selectOption("glb");
    await expect(dlg.locator("[data-pose-export='filename']")).toHaveValue("test-arm-pose.glb");
    const [dl] = await Promise.all([page.waitForEvent("download"), dlg.locator("[data-pose-export-action='submit']").click()]);
    expect(dl.suggestedFilename()).toBe("test-arm-pose.glb");
    const buf = readFileSync((await dl.path())!);
    expect(buf.subarray(0, 4).toString()).toBe("glTF");
    await expect(dlg).toHaveCount(0);
  }

  // 4. 3MF assembly at Now.
  {
    const dlg = await openExportDialog();
    await dlg.locator("[data-pose-export='format']").selectOption("3mf");
    await expect(dlg.locator("[data-pose-export='filename']")).toHaveValue("test-arm-pose.3mf");
    const [dl] = await Promise.all([page.waitForEvent("download"), dlg.locator("[data-pose-export-action='submit']").click()]);
    expect(dl.suggestedFilename()).toBe("test-arm-pose.3mf");
    const files = unzipSync(readFileSync((await dl.path())!));
    expect(files["3D/3dmodel.model"]).toBeTruthy();
    await expect(dlg).toHaveCount(0);
  }

  // 5. STL one file & STL ZIP per member.
  {
    const dlg = await openExportDialog();
    await dlg.locator("[data-pose-export='format']").selectOption("stl");
    await expect(dlg.locator("[data-pose-export='filename']")).toHaveValue("test-arm-pose.stl");
    const [dl] = await Promise.all([page.waitForEvent("download"), dlg.locator("[data-pose-export-action='submit']").click()]);
    expect(dl.suggestedFilename()).toBe("test-arm-pose.stl");
    expect(readFileSync((await dl.path())!).byteLength).toBeGreaterThan(84);
    await expect(dlg).toHaveCount(0);
  }
  {
    const dlg = await openExportDialog();
    await dlg.locator("[data-pose-export='format']").selectOption("stl");
    await dlg.locator("[data-pose-export='stl']").selectOption("each");
    await expect(dlg.locator("[data-pose-export='filename']")).toHaveValue("test-arm-pose.zip");
    const [dl] = await Promise.all([page.waitForEvent("download"), dlg.locator("[data-pose-export-action='submit']").click()]);
    expect(dl.suggestedFilename()).toBe("test-arm-pose.zip");
    const files = unzipSync(readFileSync((await dl.path())!));
    expect(Object.keys(files).filter((k) => k.endsWith(".stl")).length).toBe(2);
    await expect(dlg).toHaveCount(0);
  }

  // 6. OBJ + MTL at Now (two downloads in web mode).
  {
    const dlg = await openExportDialog();
    await dlg.locator("[data-pose-export='format']").selectOption("obj");
    await expect(dlg.locator("[data-pose-export='filename']")).toHaveValue("test-arm-pose.obj");
    const downloads: string[] = [];
    const onDl = (dl: { suggestedFilename(): string }) => downloads.push(dl.suggestedFilename());
    page.on("download", onDl);
    await dlg.locator("[data-pose-export-action='submit']").click();
    await expect.poll(() => downloads.length).toBe(2);
    page.off("download", onDl);
    expect(downloads.sort()).toEqual(["test-arm-pose.mtl", "test-arm-pose.obj"]);
    await expect(dlg).toHaveCount(0);
  }

  // 7. Pose sheet JSON at Now.
  {
    const dlg = await openExportDialog();
    await dlg.locator("[data-pose-export='format']").selectOption("pose");
    await expect(dlg.locator("[data-pose-export='filename']")).toHaveValue("test-arm-pose.json");
    const [dl] = await Promise.all([page.waitForEvent("download"), dlg.locator("[data-pose-export-action='submit']").click()]);
    expect(dl.suggestedFilename()).toBe("test-arm-pose.json");
    const sheet = JSON.parse(readFileSync((await dl.path())!, "utf8"));
    expect(sheet.format).toBe("lime-pose");
    expect(sheet.configuration).toEqual({ kind: "now" });
    expect(sheet.members).toHaveLength(2);
    await expect(dlg).toHaveCount(0);
  }

  // 8. Stopped animation frame: export Pose sheet JSON and animated GLB, then verify rest pose is unchanged.
  await page.locator("[data-pose-action='animation-play']").click();
  await page.locator("#pluginTrust [data-choice='run']").click();
  await expect(page.locator("[data-pose-animation-frame]")).toBeVisible();
  await page.locator("[data-pose-animation-frame]").evaluate((el: HTMLInputElement) => {
    el.value = "4";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // Export button beside Save animation opens with Frame 5 selected by default.
  {
    const animExportBtn = page.locator("[data-pose-action='pose-export']").last();
    await animExportBtn.click();
    const dlg = page.locator("[data-pose-export-dialog]");
    await expect(dlg).toBeVisible();
    await expect(dlg.locator("[data-pose-export='config']")).toHaveValue("frame");
    await expect(dlg.locator("[data-pose-export='config'] option[value='frame']")).toContainText("Frame 5 of Test animation (1.00 s)");
    await expect(dlg.locator("[data-pose-export='filename']")).toHaveValue("test-arm-frame-5.step");

    await dlg.locator("[data-pose-export='format']").selectOption("pose");
    await expect(dlg.locator("[data-pose-export='filename']")).toHaveValue("test-arm-frame-5.json");
    const [dl] = await Promise.all([page.waitForEvent("download"), dlg.locator("[data-pose-export-action='submit']").click()]);
    expect(dl.suggestedFilename()).toBe("test-arm-frame-5.json");
    const sheet = JSON.parse(readFileSync((await dl.path())!, "utf8"));
    expect(sheet.configuration.kind).toBe("frame");
    expect(sheet.configuration.frame).toBe(5);
    const hinged = sheet.members.find((m: { joint: { kind: string } }) => m.joint.kind === "hinge");
    expect(hinged.joint.value).toBeCloseTo(60, 2);
    await expect(dlg).toHaveCount(0);
  }

  // Export animated GLB from the same stopped animation.
  {
    await page.locator("[data-pose-action='pose-export']").last().click();
    const dlg = page.locator("[data-pose-export-dialog]");
    await expect(dlg).toBeVisible();
    await dlg.locator("[data-pose-export='format']").selectOption("glb");
    await expect(dlg.locator("[data-pose-export='animation']")).toBeChecked();
    await expect(dlg.locator("[data-pose-export='filename']")).toHaveValue("test-arm-frame-5.glb");
    const [dl] = await Promise.all([page.waitForEvent("download"), dlg.locator("[data-pose-export-action='submit']").click()]);
    expect(dl.suggestedFilename()).toBe("test-arm-frame-5.glb");
    const buf = readFileSync((await dl.path())!);
    const jsonLen = buf.readUInt32LE(12);
    const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
    expect(gltf.animations).toHaveLength(1);
    await expect(dlg).toHaveCount(0);
  }

  // Stop the animation: the assembly's pose is completely unchanged.
  await page.locator("[data-pose-action='animation-stop']").click();
  await expect(pose).toHaveAttribute("data-posed", restPosed);
});
