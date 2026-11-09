/**
 * Tandem in the window's own code, with the desktop bridge stubbed (the Tauri IPC only: lime-bridge events in,
 * receipts and the human context out). Found with the 6.1.0 Tandem beta on 2026-11-09, docs/plan-tandem.md:
 * - A: a Place field the person had committed and still had focused was stored again by the rebuild after an MCP
 *   snapshot, on the part the snapshot selected: a part moved by itself and was reported as the person's change.
 * - B: one part in conflict held back the whole snapshot, so nothing MCP did reached the window any more.
 */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fnv1aHex } from "../src/slice-action.ts";

const stl = fs.readFileSync(path.resolve("samples/calibration_cube_20mm.stl"));
const count = stl.readUInt32LE(80);
const tris = new Float32Array(count * 9);
for (let i = 0; i < count; i += 1) for (let k = 0; k < 9; k += 1) tris[i * 9 + k] = stl.readFloatLE(84 + i * 50 + 12 + k * 4);
const H = fnv1aHex(new Uint8Array(stl));
const meshes = { [H]: { fileName: "cube.stl", bytesB64: stl.toString("base64"), positionsB64: Buffer.from(tris.buffer).toString("base64") } };
const row = (object: string, name: string, x: number) => ({ object, name, scalePercent: 100, centered: false, offset: { x: x + 100, y: 100, z: 0 }, orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], meshHash: H });

type Receipt = { seq: number; outcome: string; held?: { object: string; name: string; kind: string }[] };
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
const receipt = (page: Page, seq: number) => page.waitForFunction((s) => (window as unknown as { __receipts: Receipt[] }).__receipts.find((r) => r.seq === s) ?? null, seq).then((handle) => handle.jsonValue() as Promise<Receipt>);
const hasReceipt = (page: Page, seq: number) => page.evaluate((s) => (window as unknown as { __receipts: Receipt[] }).__receipts.some((r) => r.seq === s), seq);
async function context(page: Page): Promise<Context> {
  await page.waitForTimeout(250);
  return page.evaluate(() => (window as unknown as { __contexts: Context[] }).__contexts.at(-1)!);
}
async function centreX(page: Page, id: string): Promise<number> {
  await page.locator(`[data-plate-select="${id}"]`).click();
  await page.waitForTimeout(150);
  return Number(await page.locator("#placeX").inputValue());
}
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

test("one held part does not freeze the plate, and Undo here takes back only the person's edit", async ({ page }) => {
  const warnings = tandemWarnings(page);
  await openWithBridge(page);
  await emit(page, { tool: "plate_sync", session: "s1", seq: 1, ok: true, objectId: "obj_1", plate: [row("obj_1", "Sphere 1", -50), row("obj_3", "Box", 50)], meshes });
  expect((await receipt(page, 1)).outcome).toBe("applied");
  const box = await centreX(page, "obj_3");
  const sphere = await centreX(page, "obj_1");

  // Half-typed: the snapshot waits for the field, as it waits for a drag.
  await page.locator("#placeX").fill(String(sphere - 7));
  await emit(page, { tool: "object_duplicate", session: "s1", seq: 2, ok: true, objectId: "obj_22", plate: [row("obj_1", "Sphere 1", -30), row("obj_3", "Box", 70), row("obj_22", "Sphere 1 copy", 0)], meshes });
  await page.waitForTimeout(600);
  expect(await hasReceipt(page, 2)).toBe(false);
  await page.locator("#placeX").press("Enter");

  // Both moved Sphere 1: it alone is held; the copy and Box's move apply.
  const second = await receipt(page, 2);
  expect(second.outcome).toBe("conflict");
  expect(second.held).toEqual([{ object: "obj_1", name: "Sphere 1", kind: "both-changed" }]);
  expect(await centreX(page, "obj_3")).toBeCloseTo(box + 20, 1);
  expect(await centreX(page, "obj_22")).toBeCloseTo(sphere + 50, 1);
  expect(await centreX(page, "obj_1")).toBeCloseTo(sphere - 7, 1);
  const held = await context(page);
  expect(held.conflicts.map((row) => row.object)).toEqual(["obj_1"]);
  expect(held.conflicts[0]!.reason).toMatch(/Undo it in the window/);

  // A new part from MCP still arrives; nothing else moves or is reported as the person's.
  await emit(page, { tool: "solid_new", session: "s1", seq: 3, ok: true, objectId: "obj_30", plate: [row("obj_1", "Sphere 1", -30), row("obj_3", "Box", 70), row("obj_22", "Sphere 1 copy", 0), row("obj_30", "Duck", 80)], meshes });
  expect((await receipt(page, 3)).held?.map((row) => row.object)).toEqual(["obj_1"]);
  await expect(page.locator('[data-plate-select="obj_30"]')).toBeVisible();
  expect((await context(page)).humanChanges.map((change) => change.object)).toEqual(["obj_1"]);
  expect(await centreX(page, "obj_3")).toBeCloseTo(box + 20, 1);

  // Undo in the window takes back the person's move only (selections are steps too); MCP's parts and moves stay.
  await page.locator("#placeX").blur();
  for (let i = 0; i < 8 && (await context(page)).humanChanges.length > 0; i += 1) await page.keyboard.press("Control+z");
  expect(await centreX(page, "obj_1")).toBeCloseTo(sphere, 1);
  expect(await centreX(page, "obj_3")).toBeCloseTo(box + 20, 1);
  await expect(page.locator('[data-plate-select="obj_22"]')).toBeVisible();
  await expect(page.locator('[data-plate-select="obj_30"]')).toBeVisible();
  expect((await context(page)).conflicts).toEqual([]);

  // The hold has cleared: MCP's next snapshot moves Sphere 1.
  await emit(page, { tool: "object_place", session: "s1", seq: 4, ok: true, objectId: "obj_1", plate: [row("obj_1", "Sphere 1", -30), row("obj_3", "Box", 70), row("obj_22", "Sphere 1 copy", 0), row("obj_30", "Duck", 80)] });
  expect((await receipt(page, 4)).outcome).toBe("applied");
  expect(await centreX(page, "obj_1")).toBeCloseTo(sphere + 20, 1);
  expect(warnings).toEqual([]);
});
