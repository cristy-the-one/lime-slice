/**
 * app_open: the plate is saved to the workspace and shown in the desktop app, through the bridge when a running app
 * answers, else by starting the installed app. The launcher and the bridge are stand-ins; no app is started.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchApp, type AppOpener } from "./app-open.ts";
import { bridgeOpen, type BridgeOpen } from "./bridge-client.ts";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-app-open-"));
process.env.LIME_MCP_WORKSPACE = workspace;
delete process.env.LIME_MCP_BRIDGE;
delete process.env.LIME_MCP_BRIDGE_TOKEN;

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const cube = new URL("../samples/calibration_cube_20mm.stl", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** A stand-in opener that records what it was asked. */
function opener(bridge: BridgeOpen, installed: string | null, launchError?: string) {
  const asked = { bridge: [] as string[], launched: [] as [string, string][] };
  const stand: AppOpener = {
    viaBridge: async (path) => {
      asked.bridge.push(path);
      return bridge;
    },
    installed: () => installed,
    launch: async (program, path) => {
      if (launchError) throw new Error(launchError);
      asked.launched.push([program, path]);
    },
  };
  return { stand, asked };
}

async function session(stand: AppOpener): Promise<Session> {
  const made = new Session(fakeEngine());
  made.appOpener = stand;
  return made;
}

// An empty plate has nothing to show.
{
  const { stand, asked } = opener({ opened: true }, null);
  const s = await session(stand);
  const empty = await s.call("app_open", {});
  check("an empty plate is refused in a sentence", empty.ok === false && String(empty.reason).startsWith("The plate is empty."), JSON.stringify(empty));
  check("an empty plate asks nothing of the app", asked.bridge.length === 0);
}

// A running app that answers the bridge opens the saved project, and nothing is started.
const projectPath = join(workspace, "calibration_cube_20mm.lime");
{
  const { stand, asked } = opener({ opened: true }, "C:/Lime Slice/lime-slice-desktop.exe");
  const s = await session(stand);
  await s.call("mesh_import", { path: cube });
  const opened = await s.call("app_open", {});
  check("the plate is saved under its first object's name", opened.path === projectPath && existsSync(projectPath), JSON.stringify(opened));
  check("the saved file is a project", readFileSync(projectPath, "utf8").includes("\"version\""));
  check("the running app is asked over the bridge with the saved path", asked.bridge.length === 1 && asked.bridge[0] === projectPath);
  check("the bridge result says it in a sentence", opened.ok === true && opened.opened === "bridge" && opened.note === "Opened calibration_cube_20mm.lime in the running app.", JSON.stringify(opened));
  check("an app that answered is not started again", asked.launched.length === 0);
  const again = await s.call("app_open", {});
  check("a second open saves over the project it saved", again.path === projectPath && again.ok === true, JSON.stringify(again));
}

// Without a bridge the installed app is started with the file.
{
  const { stand, asked } = opener(null, "C:/Lime Slice/lime-slice-desktop.exe");
  const s = await session(stand);
  await s.call("mesh_import", { path: cube });
  const started = await s.call("app_open", {});
  const saved = String(started.path);
  check("an existing project of that name is not replaced", saved === join(workspace, "calibration_cube_20mm-2.lime") && existsSync(saved), saved);
  check("the installed app is started with the saved file", asked.launched.length === 1 && asked.launched[0]![0] === "C:/Lime Slice/lime-slice-desktop.exe" && asked.launched[0]![1] === saved);
  check("a launch says it in a sentence", started.ok === true && started.opened === "launch" && String(started.note).startsWith("Started Lime Slice with calibration_cube_20mm-2.lime."), JSON.stringify(started));
}

// No installed app: the file stays saved and the sentence says where.
{
  const { stand, asked } = opener(null, null);
  const s = await session(stand);
  await s.call("mesh_import", { path: cube });
  const missing = await s.call("app_open", {});
  check("a missing app is a sentence naming the saved project", missing.ok === false && missing.reason === `Lime Slice is not installed; the project is saved at ${String(missing.path)}.` && existsSync(String(missing.path)), JSON.stringify(missing));
  check("a missing app starts nothing", asked.launched.length === 0);
}

// A launch that fails, and a running app that refuses the file.
{
  const { stand } = opener(null, "C:/nowhere/lime-slice-desktop.exe", "spawn ENOENT");
  const s = await session(stand);
  const failedLaunch = await s.call("app_open", { path: "calibration_cube_20mm.lime" });
  check("a failed launch says why and where the file is", failedLaunch.ok === false && failedLaunch.reason === `Lime Slice did not start (spawn ENOENT); the file is at ${projectPath}.`, JSON.stringify(failedLaunch));
}
{
  const { stand, asked } = opener({ opened: false, reason: "duck.lime was not found." }, "C:/Lime Slice/lime-slice-desktop.exe");
  const s = await session(stand);
  const refused = await s.call("app_open", { path: "calibration_cube_20mm.lime" });
  check("the running app's refusal is passed on", refused.ok === false && String(refused.reason).endsWith("duck.lime was not found."), JSON.stringify(refused));
  check("a refusing app is not started again", asked.launched.length === 0);
}

// A given path opens as it is, inside the workspace only.
{
  const { stand, asked } = opener({ opened: true }, null);
  const s = await session(stand);
  const named = await s.call("app_open", { path: "calibration_cube_20mm.lime" });
  check("a workspace file opens without a save", named.ok === true && named.saved === false && asked.bridge[0] === projectPath, JSON.stringify(named));
  const outsideDir = mkdtempSync(join(tmpdir(), "lime-mcp-outside-"));
  const outside = join(outsideDir, "secret.lime");
  writeFileSync(outside, "{}");
  const away = await s.call("app_open", { path: outside });
  check("a path outside the workspace is refused", away.ok === false && String(away.reason).includes("LIME_MCP_WORKSPACE"), JSON.stringify(away));
  const climbing = await s.call("app_open", { path: `../${outsideDir.split(/[\\/]/).pop()}/secret.lime` });
  check("a relative path that climbs out is refused", climbing.ok === false && String(climbing.reason).includes("LIME_MCP_WORKSPACE"), JSON.stringify(climbing));
  writeFileSync(join(workspace, "notes.txt"), "hi");
  const text = await s.call("app_open", { path: "notes.txt" });
  check("a file the app does not open is refused", text.ok === false && String(text.reason).startsWith("That file is not"), JSON.stringify(text));
  check("no refused path reaches the app", asked.bridge.length === 1);
}

// The bridge: an open goes only to a desktop that names the feature, and its answer is read.
{
  let features = "";
  let answer: [number, string] = [204, ""];
  const posts: unknown[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.authorization !== "Bearer t0ken") {
      res.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const head: Record<string, string> = { "x-lime-bridge-instance": "one" };
      if (features) head["x-lime-bridge-features"] = features;
      if (req.method === "POST") {
        posts.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(answer[0], head).end(answer[1]);
        return;
      }
      res.writeHead(200, head).end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  check("an open with the bridge off is no answer", (await bridgeOpen(projectPath)) === null);
  process.env.LIME_MCP_BRIDGE = `http://127.0.0.1:${port}/`;
  process.env.LIME_MCP_BRIDGE_TOKEN = "t0ken";
  check("an older desktop without the open feature is not sent the open", (await bridgeOpen(projectPath)) === null && posts.length === 0);
  features = "open";
  const opened = await bridgeOpen(projectPath);
  check("a desktop with the feature opens the path", opened?.opened === true && JSON.stringify(posts) === JSON.stringify([{ open: projectPath }]), JSON.stringify(posts));
  answer = [404, "duck.lime was not found."];
  const refused = await bridgeOpen(projectPath);
  check("a desktop's refusal carries its reason", refused?.opened === false && refused.reason === "duck.lime was not found.", JSON.stringify(refused));
  process.env.LIME_MCP_BRIDGE_TOKEN = "wrong";
  check("a desktop that refuses the token is no answer", (await bridgeOpen(projectPath)) === null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.env.LIME_MCP_BRIDGE_TOKEN = "t0ken";
  check("a closed desktop is no answer", (await bridgeOpen(projectPath)) === null);
  delete process.env.LIME_MCP_BRIDGE;
  delete process.env.LIME_MCP_BRIDGE_TOKEN;
}

// The real launcher rejects a program that does not exist, so the tool can say so.
{
  let rejected = false;
  try {
    await launchApp(join(workspace, "no-such-program"), projectPath);
  } catch {
    rejected = true;
  }
  check("a missing program is a failed launch", rejected);
}

if (failed > 0) {
  console.error(`${failed} app_open check(s) failed`);
  process.exit(1);
}
console.log("app_open checks passed");
