/**
 * Tandem receipts and bridge status in the MCP replies (feedback 2026-11-09, sections 2 and 3), against a stand-in window:
 * a loopback server that answers as the desktop bridge does and writes the receipts a test asks for.
 * - A call that changes the plate waits briefly for the window's receipt and returns its outcome: applied, applied over
 *   the person's edits (`applied-replaced`, naming the part), waiting for a gesture.
 * - What does not come in time is `pending`, and the next call's reply gives it (`tandemEarlier`).
 * - No window: `no-bridge` at once, never pending forever. session_info.tandem is always there with `bridge` and why.
 * - app_open by launch says plainly that the bridge is off and the file reloads.
 */
import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { bridgeStatus, bridgeTarget, mirror } from "./bridge-client.ts";
import { openInApp } from "./app-open.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-tandem-live-"));
delete process.env.LIME_MCP_BRIDGE;
delete process.env.LIME_MCP_BRIDGE_TOKEN;
delete process.env.LIME_MCP_BRIDGE_FILE;

/** How the stand-in window answers the next snapshot: a receipt after `delayMs`, or none. */
let answer: { outcome: string; delayMs: number; replaced?: unknown[]; reason?: string } | null = { outcome: "applied", delayMs: 20 };
const receipts: Record<string, unknown>[] = [];
const window: Server = createServer((request, response) => {
  response.setHeader("x-lime-bridge-instance", "test-window");
  response.setHeader("x-lime-bridge-features", "open tandem-context tandem-receipts");
  if (request.headers.authorization !== "Bearer test-token") {
    response.writeHead(401).end();
    return;
  }
  if (request.method === "GET") {
    response.end(request.url === "/tandem-receipts" ? JSON.stringify(receipts) : request.url === "/tandem-context" ? "null" : "ok");
    return;
  }
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    response.writeHead(204).end();
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    const now = answer;
    if (!now || typeof body.seq !== "number" || !Array.isArray(body.plate)) return;
    setTimeout(() => receipts.push({ session: body.session, seq: body.seq, outcome: now.outcome, ...(now.replaced ? { replaced: now.replaced } : {}), ...(now.reason ? { reason: now.reason } : {}) }), now.delayMs);
  });
});
await new Promise<void>((resolve) => window.listen(0, "127.0.0.1", resolve));
const address = window.address();
if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
const url = `http://127.0.0.1:${address.port}/`;
const cube = fileURLToPath(new URL("../samples/calibration_cube_20mm.stl", import.meta.url));

// --- Section 3: no bridge configured. session_info says so, and why.
const quiet = new Session(fakeEngine());
const offInfo = await quiet.call("session_info", {});
const offTandem = offInfo.tandem as { bridge: string; why: string };
assert.equal(offTandem.bridge, "absent", "session_info.tandem is there with no bridge at all");
assert.match(offTandem.why, /not configured/);
assert.equal((await quiet.call("mesh_import", { path: cube })).tandemReceipt, undefined, "no bridge configured: no receipt to wait for");

// app_open by launch, bridge off: a plain warning that this reloads the file.
const launched = await openInApp(join(process.env.LIME_MCP_WORKSPACE, "eyeglasses.lime"), { viaBridge: async () => null, installed: () => "lime-slice", launch: async () => {}, bridge: bridgeStatus }, true);
assert.equal(launched.opened, "launch");
assert.equal(launched.bridge, "absent");
assert.match(String(launched.warning), /not connected/);
assert.match(String(launched.warning), /reloads eyeglasses\.lime/);

// --- Section 2: the commit waits for its receipt.
process.env.LIME_MCP_BRIDGE = url;
process.env.LIME_MCP_BRIDGE_TOKEN = "test-token";
const session = new Session(fakeEngine());
assert.deepEqual(await bridgeStatus(), { bridge: "connected", url });
const imported = await session.call("mesh_import", { path: cube });
const first = imported.tandemReceipt as { seq: number; status: string };
assert.equal(first.status, "applied", JSON.stringify(first));
assert.equal(first.seq, session.bridgePlateSeq);

answer = { outcome: "applied", delayMs: 30, replaced: [{ object: String(imported.object), name: "calibration_cube_20mm", kind: "human-edits" }] };
const moved = await session.call("object_place", { object: imported.object, centreX: 30, centreY: 100 });
const replaced = moved.tandemReceipt as { status: string; replaced: { object: string; kind: string }[]; note: string };
assert.equal(replaced.status, "applied-replaced", "MCP's change applied over the person's edits, and the reply says so");
assert.equal(replaced.replaced[0]!.kind, "human-edits");
assert.match(replaced.note, /Ctrl\+Z/);

// The person is dragging: the window says it waits, the reply says so, and the next reply gives the outcome.
answer = { outcome: "waiting", delayMs: 10, reason: "gesture" };
const during = await session.call("object_place", { object: imported.object, centreX: 40, centreY: 100 });
const waited = during.tandemReceipt as { seq: number; status: string; reason: string };
assert.equal(waited.status, "waiting");
assert.equal(waited.reason, "gesture");
receipts.push({ session: session.bridgeSession, seq: waited.seq, outcome: "applied" });

// A window too slow to answer within the wait: pending, then given with the next call.
answer = { outcome: "applied", delayMs: 2500 };
const slow = await session.call("object_place", { object: imported.object, centreX: 50, centreY: 100 });
const pending = slow.tandemReceipt as { seq: number; status: string };
assert.equal(pending.status, "pending");
const settledWaiting = (slow.tandemEarlier as { seq: number; status: string }[] | undefined) ?? [];
assert.deepEqual(settledWaiting.map((row) => [row.seq, row.status]), [[waited.seq, "applied"]], "the waiting change's outcome comes with the next reply");
await new Promise((resolve) => setTimeout(resolve, 1200));
answer = { outcome: "applied", delayMs: 10 };
const next = await session.call("object_place", { object: imported.object, centreX: 60, centreY: 100 });
assert.equal((next.tandemReceipt as { status: string }).status, "applied");
assert.deepEqual((next.tandemEarlier as { seq: number; status: string }[]).map((row) => [row.seq, row.status]), [[pending.seq, "applied"]]);
assert.equal(session.tandemPending.length, 0);
const info = await session.call("session_info", {});
assert.equal((info.tandem as { bridge: string }).bridge, "connected");

// --- Section 3: the window went away. The snapshot is no-bridge at once, never pending forever.
await new Promise<void>((resolve, reject) => window.close((error) => (error ? reject(error) : resolve())));
const gone = await session.call("object_place", { object: imported.object, centreX: 70, centreY: 100 });
const lost = gone.tandemReceipt as { status: string; why: string };
assert.equal(lost.status, "no-bridge", JSON.stringify(lost));
assert.match(lost.why, /nothing answers/);
const goneInfo = (await session.call("session_info", {})).tandem as { bridge: string; why: string };
assert.equal(goneInfo.bridge, "absent");
assert.match(goneInfo.why, /not answering/);
await mirror({ test: "drain" });

// --- The app's own token file (Tandem light): the server reads it when LIME_MCP_BRIDGE_FILE names it.
delete process.env.LIME_MCP_BRIDGE;
delete process.env.LIME_MCP_BRIDGE_TOKEN;
const file = join(process.env.LIME_MCP_WORKSPACE, "tandem-bridge.json");
writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:43129/", token: "ab".repeat(32) }));
process.env.LIME_MCP_BRIDGE_FILE = file;
assert.deepEqual(bridgeTarget(), { url: "http://127.0.0.1:43129/", token: "ab".repeat(32) });
delete process.env.LIME_MCP_BRIDGE_FILE;
console.log("tandem live: replies carry the window's outcome, the bridge says when it is absent, app_open warns");
