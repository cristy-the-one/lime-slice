import { createServer } from "node:http";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { mirror } from "./bridge-client.ts";

let delivered: (value: Record<string, unknown>) => void = () => {};
const received = new Promise<Record<string, unknown>>((resolve) => { delivered = resolve; });
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    if (request.method === "GET") { response.writeHead(204).end(); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    if (body.tool === "project_create") delivered(body);
    response.setHeader("x-lime-bridge-instance", "test-window");
    response.writeHead(204).end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
process.env.LIME_MCP_BRIDGE = `http://127.0.0.1:${address.port}/`;
process.env.LIME_MCP_BRIDGE_TOKEN = "test-token";
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-tandem-test-"));
const session = new Session(fakeEngine());
const answer = await session.call("project_create", {});
const receipt = answer.tandemReceipt as { seq: number; status: string };
const payload = await received;
assert.equal(session.bridgeSession, payload.session);
assert.equal(receipt.seq, payload.seq);
// A window without the receipts feature took it: the reply says unconfirmed rather than pending forever.
assert.equal(receipt.status, "unconfirmed");
const cube = fileURLToPath(new URL("../samples/calibration_cube_20mm.stl", import.meta.url));
assert.equal((await session.call("mesh_import", { path: cube })).ok, true);
await mirror({ test: "drain" });
const first = session.lastBridge as { plate: Array<{ object: string; meshHash: string }> };
assert.ok(session.bridgeLink.known.has(first.plate[0]!.meshHash), "the first object's mesh is already cached");
assert.ok(session.bridgeObjectIds.has(first.plate[0]!.object));
assert.equal((await session.call("mesh_import", { path: cube })).ok, true);
const snapshot = session.lastBridge as { plate: Array<{ meshHash: string }>; meshes?: Record<string, unknown> };
assert.equal(snapshot.plate.length, 2);
assert.equal(snapshot.plate[0]!.meshHash, snapshot.plate[1]!.meshHash);
assert.ok(snapshot.meshes?.[snapshot.plate[1]!.meshHash], "a new object carries its shared mesh even when that hash was sent before");
// Every row says where its part stands in Model's shared space, so the window keeps an edited part in its assembly.
const posed = session.lastBridge as { plate: Array<{ object: string; modelPose?: { m: number[]; t: number[] } }> };
for (const sent of posed.plate) {
  const held = session.objects.find((row) => row.id === sent.object)!;
  assert.deepEqual(sent.modelPose, { m: [...held.modelPose.m], t: [...held.modelPose.t] }, "a row carries its part's model pose");
}
await mirror({ test: "drain" });
delete process.env.LIME_MCP_BRIDGE;
delete process.env.LIME_MCP_BRIDGE_TOKEN;
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
console.log("tandem receipt: operation identifies its pending desktop snapshot");
