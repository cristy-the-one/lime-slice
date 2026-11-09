/**
 * Tandem live shapes against real Open CASCADE (wave 8, feedback 2026-11-09 section 1): what MCP sends the window with a
 * shape commit is enough to replace the part's shape and its Model history there.
 * - A commit carries the part's whole history and names what it did (`change`, the window's undo step).
 * - A second commit's history continues the first's exactly: the window, holding the first (opened from the project MCP
 *   saved, the eyeglasses case), sees a fast-forward, so nothing of its own is reported replaced.
 * - plate_undo of that commit sends the part's history again with its old shape, the same history the window had.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { bridgeHistoryRelation, bridgeSavedRoot, type BridgeHistoryShape, type BridgeMessage } from "../src/bridge.ts";
import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";
import { mirror } from "./bridge-client.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("tandem-history-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("tandem-history-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-tandem-history-"));
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "25";

// A stand-in window: it takes each snapshot and answers `applied`, as the desktop does.
const sent: BridgeMessage[] = [];
const server = createServer((request, response) => {
  response.setHeader("x-lime-bridge-instance", "test-window");
  response.setHeader("x-lime-bridge-features", "open tandem-context tandem-receipts");
  if (request.method === "GET") {
    response.end(JSON.stringify(sent.filter((row) => typeof row.seq === "number" && row.plate).map((row) => ({ session: row.session, seq: row.seq, outcome: "applied" }))));
    return;
  }
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    sent.push(JSON.parse(Buffer.concat(chunks).toString()) as BridgeMessage);
    response.writeHead(204).end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
process.env.LIME_MCP_BRIDGE = `http://127.0.0.1:${address.port}/`;
process.env.LIME_MCP_BRIDGE_TOKEN = "test-token";

const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => await session.call(name, args);
const lastOf = (tool: string) => [...sent].reverse().find((row) => row.tool === tool)!;
const shapeOf = (tree: NonNullable<BridgeMessage["modelHistories"]>[string]["tree"]): BridgeHistoryShape => ({ root: bridgeSavedRoot(tree), nodes: tree.nodes, committed: tree.committed });

await call("project_create", {});
const made = await call("solid_new", { primitive: "box", dx: 30, dy: 20, dz: 10 });
const object = String(made.object);
const first = await call("model_commit", { object });
assert.equal(first.ok, true, JSON.stringify(first));
assert.equal((first.tandemReceipt as { status: string }).status, "applied", "the commit's reply gives the window's outcome");
const firstCommit = lastOf("model_commit");
const firstTree = firstCommit.modelHistories?.[object]?.tree;
assert.ok(firstTree, "a shape commit carries the part's Model history");
// What project_save writes for this part: the history the window gets when it opens that project.
const savedTree = session.savedModelTree(session.find(object)!);
assert.ok(savedTree);
assert.equal(bridgeHistoryRelation(shapeOf(savedTree as never), shapeOf(firstTree)), "same");

const slot = { kind: "boolean", op: "cut", primitive: "box", dx: 8, dy: 30, dz: 4, origin: [11, -5, 7] };
const cut = await call("model_apply", { object, op: slot, probe: true });
assert.equal(cut.ok, true, JSON.stringify(cut));
const second = await call("model_commit", { object });
assert.equal(second.ok, true, JSON.stringify(second));
const secondCommit = lastOf("model_commit");
const secondTree = secondCommit.modelHistories?.[object]?.tree;
assert.ok(secondTree && secondCommit.meshes && Object.keys(secondCommit.meshes).length === 1, "the new shape and its history ride together");
assert.match(String(secondCommit.change), /^Cut /, `the commit names what it did: ${secondCommit.change}`);
assert.equal(bridgeHistoryRelation(shapeOf(firstTree), shapeOf(secondTree)), "behind", "the second commit fast-forwards the window's history");
assert.equal(bridgeHistoryRelation(shapeOf(savedTree as never), shapeOf(secondTree)), "behind", "and the saved project's");
assert.ok(secondCommit.modelHistories?.[object]?.brepB64, "with the solid, so the window opens it without a rebuild");

// MCP steps back and commits the earlier shape: the window gets it with a history that still holds its steps.
assert.equal((await call("model_undo", { object })).ok, true);
assert.equal((await call("model_commit", { object })).ok, true);
const back = lastOf("model_commit");
const backTree = back.modelHistories?.[object]?.tree;
assert.ok(backTree, "the earlier shape comes with its history");
assert.equal(bridgeHistoryRelation(shapeOf(secondTree), shapeOf(backTree)), "kept", "the window's newer steps are still in MCP's tree: nothing of its own is reported lost");
const foreign = { ...shapeOf(secondTree), root: bridgeSavedRoot({ rootPrimitive: { kind: "box", dx: 1, dy: 1, dz: 1 } }) };
assert.equal(bridgeHistoryRelation(foreign, shapeOf(backTree)), "diverged");

await mirror({ test: "drain" });
await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
console.log("tandem history (OCCT): a commit sends shape and history, a fast-forward, an undo keeps the window's steps");
process.exit(0);
