import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid } from "./model-tree-mock";

/**
 * --- Recipe API 1.2: a plugin's `face` value, picked in the viewport. In the Plugins panel, Pick face waits for a click
 * on a flat face and the form shows it; Apply runs the plugin with it and stamps it in History. In the step's card,
 * Pick face takes another face and Rebuild runs the plugin again on that one. The scripted recipe asks the host to
 * resolve its face (`pick`) and cuts a box whose length says which way the face looks.
 */

type V = [number, number, number];

const readout = (page: Page) => page.locator("#modelReadout");
const rows = (page: Page) => page.locator("#modelHistoryTree [role=treeitem]");
const shots = "test-results/plugin-picks";
const NORMALS: V[] = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0]];
/** The cut's length for each way a face looks: +Z 6, −Z 1, −Y 2, +Y 3, −X 4, +X 5 (so the volume tells the face). */
const LENGTH: Record<string, number> = { "0,0,1": 6, "0,0,-1": 1, "0,-1,0": 2, "0,1,0": 3, "-1,0,0": 4, "1,0,0": 5 };

/** A 20 × 20 × 10 box from the origin, each face with its normal and area; `volumeMm3` of it left. */
function boxSolid(volumeMm3 = 4000): MockSolid {
  const c = (x: number, y: number, z: number): V => [x * 20, y * 20, z * 10];
  const quads: V[][] = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  const positions: number[] = [];
  const triangles: number[] = [];
  quads.forEach((q, face) => {
    for (const tri of [[0, 1, 2], [0, 2, 3]]) {
      for (const i of tri) positions.push(...q[i]!);
      triangles.push(face);
    }
  });
  return { volumeMm3, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: id < 2 ? 400 : 200, normal: NORMALS[id]! })), edges: [] };
}

const BODY = [
  "use lime_recipe::{Json, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let f = s.face("face").rule("largest_up").label("Face").help("The face the cut starts from.").get();',
  "    let p = s.object().unwrap();",
  "    let picked = s.pick_face(&p, &f).unwrap();",
  '    s.apply(&p, Json::obj().set("kind", "boolean").set("normal", picked.normal)).unwrap();',
  "    s.done(&p);",
  "}",
  "",
].join("\n");
const SHA = createHash("sha256").update(BODY, "utf8").digest("hex");
const PARAMS = [{ name: "face", kind: "face", default: { rule: "largest_up" }, label: "Face", help: "The face the cut starts from." }];
const FILE = ["//! ---", "//! plugin: face-cut", "//! title: Face cut", "//! version: 1", "//! description: A cut into the face you pick.", "//! author: Marius", "//! api: 1.2", `//! source-sha256: ${SHA}`, "//! target: object", `//! params: ${JSON.stringify(PARAMS)}`, "//! ---", BODY].join("\n");

/** The library (the desktop shell's folder) and the Tauri runner, played in the page. The recipe picks, then cuts. */
async function scripted(page: Page) {
  await page.addInitScript(({ file, lengths }) => {
    (window as unknown as { __limePluginLibrary: unknown }).__limePluginLibrary = {
      invoke: async (command: string) => {
        if (command === "plugin_library_list") return { dir: "C:\\plugins", files: [{ name: "face-cut.rs", text: file }], presets: [], settings: null };
        if (command === "plugin_library_save" || command === "plugin_library_write" || command === "plugin_library_reveal") return null;
        throw new Error(`no command ${command}`);
      },
    };
    type Handler = (event: { payload: unknown }) => void;
    const handlers = new Map<string, Set<Handler>>();
    const emit = (event: string, payload: unknown) => setTimeout(() => {
      for (const handler of handlers.get(event) ?? []) handler({ payload });
    }, 0);
    const log: { command: string; args: Record<string, unknown> }[] = [];
    const picks: unknown[] = [];
    let run = "";
    let object = "";
    let stage = 0;
    const say = (line: unknown) => emit("recipe-line", { run, line: JSON.stringify(line) });
    Object.assign(window as object, { __recipeLog: log, __picks: picks });
    (window as unknown as { __limeRecipeRunner: unknown }).__limeRecipeRunner = {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        log.push({ command, args });
        if (command === "recipe_available") return { ok: true, lust: "scripted" };
        if (command === "recipe_build") return { code: 0, stdout: "", stderr: "", exe: "/scripted/slot-0/recipe", main: "/scripted/slot-0/src/main.rs" };
        if (command === "recipe_start") {
          run = String(args.run);
          return null;
        }
        if (command === "recipe_send") {
          const msg = JSON.parse(String(args.line)) as { v?: number; ok?: boolean; error?: string; result?: { normal?: number[] }; context?: { object?: string } };
          if (msg.v === 1) {
            object = String(msg.context?.object ?? "");
            stage = 1;
            say({ id: 1, call: "pick", args: { param: "face", kind: "face", object, value: { rule: "largest_up" } }, at: { line: 6 } });
            return null;
          }
          if (msg.ok === false) {
            emit("recipe-exit", { run, code: 101, reason: null, stderr: `thread 'main' (7) panicked at src/main.rs:${stage === 1 ? 6 : 7}:5:\n${msg.error}\n` });
            return null;
          }
          if (stage === 1) {
            stage = 2;
            picks.push(msg.result);
            const dx = lengths[(msg.result?.normal ?? []).join(",")] ?? 9;
            say({ id: 2, call: "model_apply", args: { object, op: { kind: "boolean", op: "cut", primitive: "box", dx, dy: 20, dz: 20, origin: [0, 0, 0] }, probe: true }, at: { line: 7 } });
            return null;
          }
          say({ done: { object, metrics: {} } });
          return null;
        }
        if (command === "recipe_close_input" || command === "recipe_kill") {
          emit("recipe-exit", { run, code: command === "recipe_kill" ? null : 0, reason: null, stderr: "" });
          return null;
        }
        throw new Error(`no command ${command}`);
      },
      listen: async (event: string, handler: Handler) => {
        const set = handlers.get(event) ?? new Set<Handler>();
        handlers.set(event, set);
        set.add(handler);
        return () => set.delete(handler);
      },
    };
  }, { file: FILE, lengths: LENGTH });
}

async function openModel(page: Page) {
  const root = boxSolid();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: root.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await mockModelTree(page, {
    open: () => root,
    apply: (request: Body) => boxSolid(4000 - 100 * Number((request.op as { size?: number[] }).size?.[0] ?? 0)),
    probe: () => ({ ok: true }),
  });
  await scripted(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 4000 mm³");
}

async function grips(page: Page): Promise<Record<string, { x: number; y: number }>> {
  const text = (await page.locator("#model").getAttribute("data-handles")) ?? "";
  const box = (await page.locator("#model").boundingBox())!;
  const map: Record<string, { x: number; y: number }> = {};
  for (const item of text.split(" ").filter(Boolean)) {
    const [id, at] = item.split(":");
    const [x, y] = at!.split(",").map(Number);
    map[id!] = { x: box.x + x!, y: box.y + y! };
  }
  return map;
}

/** Where the middle of the solid's top face is on screen: the Hole tool's origin dot starts there. */
async function topMiddle(page: Page) {
  await page.locator("#modelToolHole").click();
  await expect.poll(async () => (await grips(page))["hole-origin"]).toBeTruthy();
  const at = (await grips(page))["hole-origin"]!;
  await page.locator("#modelCancel").click();
  return at;
}

test("a face picked in the Plugins panel runs the plugin on it, and History's card rebuilds it on another face", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await openModel(page);
  const top = await topMiddle(page);
  const before = await rows(page).count();

  // The panel's form: the face's default rule, and Pick face.
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuPlugins").click();
  const card = page.locator("#modelPlugins");
  await card.locator('.pp-pick[data-key="library:face-cut"]').click();
  const value = card.locator('.mh-pick-value[data-name="face"]');
  await expect(value).toHaveText("largest up (default)");
  const pick = card.locator('button[data-pick-act="face"]');
  await expect(pick).toHaveText("Pick face");
  await card.locator("#modelPluginsLive").uncheck();

  // Pick face waits for a click; the click on the top face fills the form.
  await pick.click();
  await expect(pick).toHaveText("Click a face…");
  await expect(pick).toHaveAttribute("aria-pressed", "true");
  await expect(readout(page)).toContainText("Click a flat face of");
  await page.screenshot({ path: `${shots}/panel-pick-waiting.png` });
  await page.mouse.click(top.x, top.y);
  await expect(value).toHaveText("face facing +Z");
  await expect(readout(page)).toContainText("Picked the face facing +Z, 400 mm².");
  await expect(card.locator('button[data-pick-act="clear"]')).toHaveText("Use default");
  await page.screenshot({ path: `${shots}/panel-picked.png` });

  // Apply: the plugin is given the face, resolves it through pick, and lands one row stamped with it.
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Applied “Face cut” v1");
  await expect(readout(page)).toContainText("Volume 3400 mm³");
  await expect(rows(page)).toHaveCount(before + 1);
  const log = () => page.evaluate(() => (window as unknown as { __recipeLog: { command: string; args: Record<string, unknown> }[] }).__recipeLog);
  const starts = async () => (await log()).filter((row) => row.command === "recipe_send" && String(row.args.line).startsWith('{"v":1')).map((row) => JSON.parse(String(row.args.line)) as { params: { face?: { normal: number[]; nearPoint: number[]; areaMm2: number } } });
  const applied = (await starts()).at(-1)!;
  expect(applied.params.face?.normal).toEqual([0, 0, 1]);
  expect(applied.params.face?.nearPoint[2]).toBeCloseTo(10, 3);
  expect(applied.params.face?.areaMm2).toBe(400);
  await page.keyboard.press("Escape");

  // History's card: the stamped face, and Pick face for another one.
  const step = page.getByRole("treeitem", { name: /^Face cut · plugin v1/ });
  await expect(step).toBeVisible();
  await step.hover();
  await step.locator(".mh-edit").click();
  const values = page.locator("#modelPluginCard");
  await expect(values).toBeVisible();
  const stamped = values.locator('.mh-pick-value[data-name="face"]');
  await expect(stamped).toHaveText("face facing +Z");
  const again = values.locator('button[data-pick-act="face"]');
  // A face below the top's middle, toward the camera: the first click that lands on a side face.
  let side = "";
  for (const dy of [60, 90, 120, 150, 180]) {
    await again.click();
    await expect(again).toHaveAttribute("aria-pressed", "true");
    await page.mouse.click(top.x, top.y + dy);
    await expect(again).not.toHaveAttribute("aria-pressed", "true");
    side = (await stamped.textContent()) ?? "";
    if (side !== "face facing +Z" && side.startsWith("face facing")) break;
  }
  expect(side).toMatch(/^face facing [+−][XY]$/);
  await expect(stamped).toHaveAttribute("data-typed", "");
  await page.screenshot({ path: `${shots}/card-new-face.png` });
  await values.locator("#modelPluginRebuild").click();
  const length = LENGTH[{ "+X": "1,0,0", "−X": "-1,0,0", "+Y": "0,1,0", "−Y": "0,-1,0" }[side.slice("face facing ".length)]!]!;
  await expect(readout(page)).toContainText(`Volume ${4000 - 100 * length} mm³`);
  const rebuilt = (await starts()).at(-1)!;
  expect(rebuilt.params.face?.normal).not.toEqual([0, 0, 1]);
  const resolved = await page.evaluate(() => (window as unknown as { __picks: { normal: number[] }[] }).__picks.at(-1));
  expect(resolved?.normal).toEqual(rebuilt.params.face?.normal);
  await expect(stamped).toHaveText(side);
  await page.screenshot({ path: `${shots}/card-rebuilt.png` });

  // One Undo goes back to the top face.
  await page.locator("#modelUndo").click();
  await expect(readout(page)).toContainText("Volume 3400 mm³");
  await expect(stamped).toHaveText("face facing +Z");
});
