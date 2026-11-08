import { createServer } from "node:http";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { mirror } from "./bridge-client.ts";

let delivered: (value: Record<string, unknown>) => void = () => {};
const received = new Promise<Record<string, unknown>>((resolve) => { delivered = resolve; });
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
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
const receipt = answer.tandemReceipt as { session: string; seq: number; status: string };
const payload = await received;
assert.equal(receipt.session, payload.session);
assert.equal(receipt.seq, payload.seq);
assert.match(receipt.status, /pending/);
await mirror({ test: "drain" });
delete process.env.LIME_MCP_BRIDGE;
delete process.env.LIME_MCP_BRIDGE_TOKEN;
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
console.log("tandem receipt: operation identifies its pending desktop snapshot");
