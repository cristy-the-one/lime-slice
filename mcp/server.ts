/**
 * Lime Slice MCP server. One process, stdio, the slicer linked in-process.
 * stdout is the protocol. Diagnostics go to stderr.
 */
import { fileURLToPath } from "node:url";

import { fakeEngine, loadEngineWorker } from "./engine.ts";
import { serve } from "./protocol.ts";
import { Session } from "./session.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const engine = process.env.LIME_MCP_FAKE === "1" ? fakeEngine() : loadEngineWorker(root);
const session = new Session(engine);

// The plate lives in this process. A stray failure is logged and the server goes on, rather than ending the session
// with the plate in it: Node ends the process on an unhandled rejection by default.
process.on("unhandledRejection", (err) => {
  process.stderr.write(`lime-slice mcp: unhandled ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`lime-slice mcp: uncaught ${err.stack ?? err.message}\n`);
  session.flushAutosave();
});

serve(session);
