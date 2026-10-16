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
serve(session);
