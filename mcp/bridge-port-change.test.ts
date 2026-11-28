import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { bridgeStatus, mirror } from "./bridge-client.ts";

// The app restarted on another port after the server read its token file: the next request that cannot connect
// reads the file again and reaches the app there.
const token = "ab".repeat(32);
const seen: string[] = [];
const app = createServer((request, response) => {
  assert.equal(request.headers.authorization, `Bearer ${token}`);
  seen.push(`${request.method} ${request.url}`);
  response.setHeader("x-lime-bridge-instance", "one");
  response.statusCode = request.method === "POST" ? 204 : 200;
  response.end();
});
await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
const address = app.address();
if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
const live = `http://127.0.0.1:${address.port}/`;

// A port nothing listens on: bind one, then close it.
const closed = createServer();
await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
const closedAddress = closed.address();
if (!closedAddress || typeof closedAddress === "string") throw new Error("Expected a TCP listener");
const dead = `http://127.0.0.1:${closedAddress.port}/`;
await new Promise<void>((resolve) => closed.close(() => resolve()));

const dir = mkdtempSync(join(tmpdir(), "lime-bridge-port-"));
const file = join(dir, "tandem-bridge.json");
delete process.env.LIME_MCP_BRIDGE;
delete process.env.LIME_MCP_BRIDGE_TOKEN;
process.env.LIME_MCP_BRIDGE_FILE = file;

try {
  writeFileSync(file, JSON.stringify({ url: dead, token }));
  assert.equal((await bridgeStatus()).bridge, "absent");
  // The app comes back on another port and rewrites the file; the one-second cache still holds the dead address.
  writeFileSync(file, JSON.stringify({ url: live, token }));
  const status = await bridgeStatus();
  assert.equal(status.bridge, "connected");
  assert.equal(status.url, live);
  assert.equal(await mirror({ tool: "x" }), true);
  assert.ok(seen.includes("POST /"));

  // With the address set in the environment, the file never overrides it.
  process.env.LIME_MCP_BRIDGE = dead;
  process.env.LIME_MCP_BRIDGE_TOKEN = token;
  const pinned = await bridgeStatus();
  assert.equal(pinned.bridge, "absent");
  assert.equal(pinned.url, dead);
} finally {
  rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((resolve, reject) => app.close((error) => (error ? reject(error) : resolve())));
}
console.log("bridge port change: a moved app is found again, and the environment still wins");
