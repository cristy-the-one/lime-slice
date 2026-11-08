import { createServer } from "node:http";
import { strict as assert } from "node:assert";
import { bridgeHumanContext } from "./bridge-client.ts";

let oldPeer = false;
const server = createServer((request, response) => {
  assert.equal(request.url, "/tandem-context");
  assert.equal(request.headers.authorization, "Bearer test-token");
  response.setHeader("x-lime-bridge-features", oldPeer ? "open" : "open tandem-context");
  response.end(JSON.stringify({ stage: "model", selected: "Arm", gesture: false, editing: true }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
process.env.LIME_MCP_BRIDGE = `http://127.0.0.1:${address.port}/`;
process.env.LIME_MCP_BRIDGE_TOKEN = "test-token";
assert.deepEqual(await bridgeHumanContext(), { stage: "model", selected: "Arm", gesture: false, editing: true });
oldPeer = true;
assert.equal(await bridgeHumanContext(), null);
delete process.env.LIME_MCP_BRIDGE_TOKEN;
assert.equal(await bridgeHumanContext(), null);
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
console.log("bridge human context: authenticated, bounded request and disabled behavior ok");
