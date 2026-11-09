/**
 * Tandem in the window's own code, with the desktop bridge stubbed (the Tauri IPC only: lime-bridge events in,
 * receipts and the human context out). Found with the 6.1.0 Tandem beta on 2026-11-09, docs/plan-tandem.md:
 * - A: a Place field the person had committed and still had focused was stored again by the rebuild after an MCP
 *   snapshot, on the part the snapshot selected: a part moved by itself and was reported as the person's change.
 * - B: one part in conflict held back the whole snapshot, so nothing MCP did reached the window any more.
 * - Live shapes (wave 8, the eyeglasses session): an MCP shape commit on a part with a Model history in the window was
 *   held back and needed a reload. Now MCP's shape and history apply live, as one named undo step, every time.
 */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fnv1aHex } from "../src/slice-action.ts";

function meshOf(file: string, name: string) {
  const stl = fs.readFileSync(path.resolve(file));
  const count = stl.readUInt32LE(80);
  const tris = new Float32Array(count * 9);
  for (let i = 0; i < count; i += 1) for (let k = 0; k < 9; k += 1) tris[i * 9 + k] = stl.readFloatLE(84 + i * 50 + 12 + k * 4);
  return { hash: fnv1aHex(new Uint8Array(stl)), count, mesh: { fileName: name, bytesB64: stl.toString("base64"), positionsB64: Buffer.from(tris.buffer).toString("base64") } };
}
const cube = meshOf("samples/calibration_cube_20mm.stl", "cube.stl");
const post = meshOf("samples/arc_post.stl", "frame.stl");
const H = cube.hash;
const meshes = { [H]: cube.mesh };
const row = (object: string, name: string, x: number, hash = H) => ({ object, name, scalePercent: 100, centered: false, offset: { x: x + 100, y: 100, z: 0 }, orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], meshHash: hash });

type Receipt = { session: string; seq: number; outcome: string; held?: { object: string; name: string; kind: string }[]; replaced?: { object: string; name: string; kind: string }[]; reason?: string };
type Context = { humanChanges: { object: string }[]; conflicts: { object: string; reason: string }[] };

async function openWithBridge(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const callbacks = new Map<number, (value: unknown) => void>();
    let next = 1;
    w.__receipts = [];
    w.__contexts = [];
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      transformCallback(callback: (value: unknown) => void) {
        const id = next++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      convertFileSrc: (file: string) => file,
      invoke(cmd: string, args: Record<string, unknown>) {
        if (cmd === "plugin:event|listen") {
          if (args.event === "lime-bridge") w.__emitBridge = (payload: unknown) => callbacks.get(args.handler as number)?.({ event: "lime-bridge", id: 1, payload });
          return Promise.resolve(1);
        }
        // The Tandem light: an MCP server talked lately.
        if (cmd === "bridge_status") return Promise.resolve({ state: "connected", beta: true, port: 43129, source: "app", url: "http://127.0.0.1:43129/" });
        if (cmd === "bridge_receipt") (w.__receipts as unknown[]).push(args);
        else if (cmd === "bridge_human_context") (w.__contexts as unknown[]).push(args.context);
        else if (cmd !== "bridge_ready") return Promise.reject(new Error(`No ${cmd} in this test.`));
        return Promise.resolve(null);
      },
    };
  });
  await page.goto("/");
  await page.waitForFunction(() => typeof (window as unknown as { __emitBridge?: unknown }).__emitBridge === "function");
}

const emit = (page: Page, payload: unknown) => page.evaluate((p) => (window as unknown as { __emitBridge: (p: unknown) => void }).__emitBridge(p), payload);
/** The window's last word on `seq`: a waiting receipt is followed by the outcome under the same number. */
const receipt = (page: Page, seq: number, settled = true) => page.waitForFunction(([s, done]) => (window as unknown as { __receipts: Receipt[] }).__receipts.filter((r) => r.seq === s && (!done || r.outcome !== "waiting")).at(-1) ?? null, [seq, settled] as const).then((handle) => handle.jsonValue() as Promise<Receipt>);
const settledReceipt = (page: Page, seq: number) => page.evaluate((s) => (window as unknown as { __receipts: Receipt[] }).__receipts.some((r) => r.seq === s && r.outcome !== "waiting"), seq);
async function context(page: Page): Promise<Context> {
  await page.waitForTimeout(250);
  return page.evaluate(() => (window as unknown as { __contexts: Context[] }).__contexts.at(-1)!);
}
async function centreX(page: Page, id: string): Promise<number> {
  await page.locator(`[data-plate-select="${id}"]`).click();
  await page.waitForTimeout(150);
  return Number(await page.locator("#placeX").inputValue());
}
const tip = (page: Page, id: string) => page.locator(`[data-plate-select="${id}"]`).getAttribute("data-tip");
function tandemWarnings(page: Page): string[] {
  const said: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning" && message.text().startsWith("Tandem")) said.push(message.text());
  });
  return said;
}

test("a committed Place field still focused does not move the part MCP adds", async ({ page }) => {
  const warnings = tandemWarnings(page);
  await openWithBridge(page);
  await emit(page, { tool: "plate_sync", session: "s1", seq: 1, ok: true, objectId: "obj_1", plate: [row("obj_1", "Sphere 1", -50), row("obj_3", "Box", 50)], meshes });
  expect((await receipt(page, 1)).outcome).toBe("applied");
  const sphere = await centreX(page, "obj_1");
  await page.locator("#placeX").fill(String(sphere - 7));
  await page.locator("#placeX").press("Enter");
  await page.waitForTimeout(400);
  await emit(page, { tool: "solid_new", session: "s1", seq: 2, ok: true, objectId: "obj_30", plate: [row("obj_1", "Sphere 1", -50), row("obj_3", "Box", 50), row("obj_30", "Duck", 80)], meshes });
  expect((await receipt(page, 2)).outcome).toBe("diverged");
  // Before the fix the Duck took the person's typed X and was reported as theirs.
  expect((await context(page)).humanChanges.map((change) => change.object)).toEqual(["obj_1"]);
  expect(await centreX(page, "obj_30")).toBeCloseTo(sphere + 130, 1);
  expect(await centreX(page, "obj_1")).toBeCloseTo(sphere - 7, 1);
  expect(warnings).toEqual([]);
});

test("a part both sides changed takes MCP's version live while the rest applies; Undo puts the person's back", async ({ page }) => {
  const warnings = tandemWarnings(page);
  await openWithBridge(page);
  await emit(page, { tool: "plate_sync", session: "s1", seq: 1, ok: true, objectId: "obj_1", plate: [row("obj_1", "Sphere 1", -50), row("obj_3", "Box", 50)], meshes });
  expect((await receipt(page, 1)).outcome).toBe("applied");
  const box = await centreX(page, "obj_3");
  const sphere = await centreX(page, "obj_1");

  // Half-typed: the snapshot waits for the field, as it waits for a drag, and the receipt says so.
  await page.locator("#placeX").fill(String(sphere - 7));
  await emit(page, { tool: "object_duplicate", session: "s1", seq: 2, ok: true, objectId: "obj_22", plate: [row("obj_1", "Sphere 1", -30), row("obj_3", "Box", 70), row("obj_22", "Sphere 1 copy", 0)], meshes });
  const waiting = await receipt(page, 2, false);
  expect(waiting.outcome).toBe("waiting");
  expect(waiting.reason).toBe("typing");
  await page.waitForTimeout(400);
  expect(await settledReceipt(page, 2)).toBe(false);
  await page.locator("#placeX").press("Enter");

  // Both moved Sphere 1: MCP's move shows (never held back), and the receipt names the person's edit it replaced.
  const second = await receipt(page, 2);
  expect(second.outcome).toBe("applied");
  expect(second.held).toBeUndefined();
  expect(second.replaced).toEqual([{ object: "obj_1", name: "Sphere 1", kind: "human-edits" }]);
  await expect(page.locator(".toast", { hasText: "Assistant: object duplicate on Sphere 1" })).toBeVisible();
  expect((await context(page)).conflicts).toEqual([]);
  expect(await centreX(page, "obj_3")).toBeCloseTo(box + 20, 1);
  expect(await centreX(page, "obj_22")).toBeCloseTo(sphere + 50, 1);
  expect(await centreX(page, "obj_1")).toBeCloseTo(sphere + 20, 1);

  // Undo in the window puts the person's X back; MCP's other changes stay (selections are steps too).
  await page.locator("#placeX").blur();
  expect((await context(page)).humanChanges).toEqual([]);
  for (let i = 0; i < 8 && (await context(page)).humanChanges.length === 0; i += 1) await page.keyboard.press("Control+z");
  await expect(page.locator(".toast", { hasText: "Undid Assistant: object duplicate on Sphere 1" })).toBeVisible();
  expect(await centreX(page, "obj_1")).toBeCloseTo(sphere - 7, 1);
  expect(await centreX(page, "obj_3")).toBeCloseTo(box + 20, 1);
  await expect(page.locator('[data-plate-select="obj_22"]')).toBeVisible();
  expect((await context(page)).humanChanges.map((change) => change.object)).toEqual(["obj_1"]);

  // MCP's next move of Sphere 1 applies live again.
  await emit(page, { tool: "object_place", session: "s1", seq: 3, ok: true, objectId: "obj_1", plate: [row("obj_1", "Sphere 1", -10), row("obj_3", "Box", 70), row("obj_22", "Sphere 1 copy", 0)] });
  expect((await receipt(page, 3)).outcome).toBe("applied");
  expect(await centreX(page, "obj_1")).toBeCloseTo(sphere + 40, 1);
  expect(warnings).toEqual([]);
});

/** A box with no steps, and the same box with one cut: the history MCP's commit continues. */
const boxRoot = { primitive: "box", origin: [0, 0, 0], size: [20, 20, 20], radius: 5, height: 10, turn: [0, 0, 0] };
const rootNode = { id: 0, parent: null, op: null, fingerprint: null };
const cutNode = { id: 1, parent: 0, op: { kind: "boolean", op: "cut", primitive: "cylinder", origin: [10, 10, 0], size: [1, 1, 1], radius: 3, height: 20, turn: [0, 0, 0] }, fingerprint: null };
const before = { tree: { nodes: [rootNode], current: 0, committed: 0, nextId: 1, rootPrimitive: boxRoot } };
const after = { tree: { nodes: [rootNode, cutNode], current: 1, committed: 1, nextId: 2, rootPrimitive: boxRoot } };

test("an MCP shape commit on a part with a Model history in the window shows live, and Ctrl+Z puts the window's back", async ({ page }) => {
  const warnings = tandemWarnings(page);
  await openWithBridge(page);
  await expect(page.locator("#tandemBridge")).toBeVisible();
  await expect(page.locator("#tandemBridgeText")).toHaveText("Tandem: connected");
  // The window holds the frame's Model history, as after opening the project MCP saved (another MCP process then).
  await emit(page, { tool: "plate_sync", session: "s0", seq: 1, ok: true, objectId: "obj_1", plate: [row("obj_1", "Glasses frame", 0)], meshes, modelHistories: { obj_1: before } });
  expect((await receipt(page, 1)).outcome).toBe("applied");
  await expect.poll(() => tip(page, "obj_1")).toContain(`${cube.count} triangles`);

  // MCP fuses onto it and commits: shape and history replace the window's, live. A fast-forward: nothing reported lost.
  await emit(page, { tool: "model_commit", session: "s1", seq: 5, ok: true, objectId: "obj_1", change: "Fuse Ornament gear", commit: { object: "obj_1", meshHash: post.hash }, plate: [row("obj_1", "Glasses frame", 0, post.hash)], meshes: { [post.hash]: post.mesh }, modelHistories: { obj_1: after } });
  const committed = await receipt(page, 5);
  expect(committed.outcome).toBe("applied");
  expect(committed.replaced).toBeUndefined();
  await expect.poll(() => tip(page, "obj_1")).toContain(`${post.count} triangles`);
  await expect(page.locator(".toast", { hasText: "Assistant: Fuse Ornament gear on Glasses frame" })).toBeVisible();

  // One Ctrl+Z: the window's shape is back, said by name.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+z");
  await expect.poll(() => tip(page, "obj_1")).toContain(`${cube.count} triangles`);
  await expect(page.locator(".toast", { hasText: "Undid Assistant: Fuse Ornament gear on Glasses frame" })).toBeVisible();
  // Redo takes MCP's again.
  await page.keyboard.press("Control+y");
  await expect.poll(() => tip(page, "obj_1")).toContain(`${post.count} triangles`);
  expect(warnings).toEqual([]);
});
