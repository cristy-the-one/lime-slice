# The MCP server: setup and use

How to connect an AI client such as Claude to Lime Slice, what the server does, and how to run it from a checkout. [mcp-server.md](mcp-server.md) lists every tool and what is deferred.

An LLM client such as Claude can drive Lime Slice over MCP. It can import or build a part, edit it in Model, place it, change settings, slice, and write G-code. There is no send-to-printer tool.

### Set up on Windows (installed app)

The installer puts the server in `%LOCALAPPDATA%\Lime Slice\mcp\`, with its engine beside it and Open CASCADE in `%LOCALAPPDATA%\Lime Slice\occt\lib\`. You need nothing else from the repository.

1. Install Node 22.6 or later. The installer does not include Node. Check the version in a terminal:

   ```powershell
   node --version
   ```

   It must print `v22.6.0` or higher.

2. Make a folder for the files the server writes, for example `C:\Users\you\lime-workspace`. The server saves projects, STEP files, and G-code only inside this folder.

3. Add the server to your client.

   **Claude Desktop.** Open `%APPDATA%\Claude\claude_desktop_config.json` (Settings > Developer > Edit Config opens it). Add this block, with your user name in both paths. Write every backslash twice.

   ```json
   {
     "mcpServers": {
       "lime-slice": {
         "command": "node",
         "args": ["C:\\Users\\you\\AppData\\Local\\Lime Slice\\mcp\\server.mjs"],
         "env": {
           "LIME_MCP_WORKSPACE": "C:\\Users\\you\\lime-workspace"
         }
       }
     }
   }
   ```

   If the file already has an `mcpServers` object, add only the `"lime-slice"` entry to it.

   **Claude Code.** Run this once in PowerShell. `--scope user` makes the server available in every project:

   ```powershell
   claude mcp add lime-slice --scope user -e LIME_MCP_WORKSPACE=C:\Users\you\lime-workspace -- node "C:\Users\you\AppData\Local\Lime Slice\mcp\server.mjs"
   ```

   For one project only, put the same JSON block as above in a file named `.mcp.json` in that project's folder.

4. Restart Claude Desktop, or run `/mcp` in Claude Code and reconnect `lime-slice`. A client reads its config only when it starts.

5. Check that it works. Ask the client to call `session_info`. The reply must show `"occt": true` and an `engine` version that equals `serverVersion`. If `occt` is false, Model edits will not work: reinstall the app.

Point the client at `server.mjs` in the installed app. Do not point it at `mcp\server.ts` from a checkout unless you build the engine yourself (see "From a checkout").

Recipes (`recipe_run`, Rust programs that build a part) need nothing else: the installer ships the lust compiler and its tinycc in `mcp\lust` beside `server.mjs`, and the server uses that copy.

After you install a new version of the app, restart the client too, so it runs the new server.

### macOS and Linux

The setup is the same. Only the paths differ:

- macOS: `/Applications/Lime Slice.app/Contents/Resources/mcp/server.mjs`. Claude Desktop's config is `~/Library/Application Support/Claude/claude_desktop_config.json`.
- Linux (`.deb`): `/usr/lib/Lime Slice/mcp/server.mjs`. Claude Desktop's config is `~/.config/Claude/claude_desktop_config.json`.

Paths use forward slashes. Set `LIME_MCP_WORKSPACE` the same way. Recipes on Linux need the C headers of `libc6-dev`: the `.deb` installs it, and an AppImage user runs `sudo apt install libc6-dev`. The Apple silicon macOS app ships lust, so recipes run there as on Linux and Windows. The Intel macOS app has no recipes: it ships without lust, and `recipe_run` answers that it needs lust.

### What it does

The server drives the same plate, settings, paint, and Model operations the window commits. The builders are shared (`src/modeling`, `src/model-request`): extrude, revolve, loft, sweep, shell, push/pull (`faceExtrude`, `moveFaces`), holes, fillet, chamfer, split, scale, boolean, pocket, boss, texture, pattern, mirror, text, array, and ribs, plus history edit, parameters, and STEP export. An LLM session therefore builds the same solids and the same G-code. The interactive sketch and its constraint solver stay in the window. The server takes numeric profiles and the feature operations, not pointer drags. There is no send-to-printer tool. `render_view` and `layer_image` give the client a picture of the solid or a layer.

A typical slice is `machine_list`, `machine_select`, `mesh_import`, `slice_start`, `slice_wait`, `gcode_summary`. A hole is `faces_find`, `workplane_set`, `model_probe`, `model_apply`, `model_commit`, then `slice_start`. The guides `lime://guide/slice`, `lime://guide/model`, `lime://guide/paint`, and `lime://guide/calibrate` hold the same sequences. `guide {topic: "ops"}` lists every Model op with an example. `model_apply` names each op kind in one line to keep the tool list small, and `guide {kind: "fillet"}` returns that kind's full schema.

A stress study is `sim_setup`, `sim_run`, then `sim_sweep {reslice: true}` to compare variants: each row has the slicer's time and grams next to the margins. `layer_image {colourBy: "stress"}` draws a layer's toolpaths coloured by the solved stress. `guide {topic: "sim"}` gives the order of calls and what to change for each failure mode.

Placement has the window's options. `object_place {object, layFlat: true}` drops the flattest face, and `{object, rotX: 5, settle: true}` turns the part and snaps it to the nearest flat face within 12°; the reply gives `rotationDeg` and `contactMm2`. `{object, align: {to: <object id or "bed">, how}}` lines the part up as Align to… does, exactly: `how` is `flush-left`, `flush-right`, `flush-front`, `flush-back`, `left-of`, `right-of`, `front-of`, `behind`, `centre-x`, `centre-y`, `centre`, or `on-top`. `mesh_import {path, pieces: true}` opens a STEP of several solids as one object per solid. `solid_new {name}` names a new solid, and `object_select {object, name}` renames an object. Pocket and boss anchor `from: "box"` unless told otherwise.

`model_build` makes a solid, runs a batch of edits, and commits it in one call. Each edit is checked before it is applied. A step that Open CASCADE reports as done but that loses the part, or leaves pieces that meet only along an edge, is taken back and refused. A commit refuses a mesh that does not close, and `model_check` lists open and touching edges with where they are.

A long call sends progress notifications, so a client that restarts its timeout on progress keeps waiting. A cancelled batch is taken back whole. The server autosaves the plate, with every object's Model history, to `autosave-<process id>.lime` in the workspace. Each server writes its own file, so Claude Desktop and Claude Code can share a workspace. If the client restarts the server, the new server moves the newest file of a server that has ended to `autosave-previous.lime` and names it in `session_info` and `plate_list`. Call `project_open` on it to carry on.

Pose can play animation plugins on an assembly, scrub or keep a frame, and export a GIF or PNG frames. The MCP's `pose_animate` samples the same keys and can export with a fixed camera; use `guide {kind:"animation"}` for the script API and examples. Animation playback leaves the assembly pose unchanged until a frame is kept.

Writes stay inside `LIME_MCP_WORKSPACE`. A path can be absolute, or relative to that workspace. Saving a project may overwrite a `.lime` file already in that folder. `app_open` saves the plate in the workspace and opens it in the desktop app. If no running app answers the live bridge, it starts the installed app with the file.

The server lists four tools: `guide`, `call`, `plan_run` and `session_info`. With its instructions, that is about 1,440 tokens of first contact; the old core list was about 6,000. `guide {query: "paint a seam"}` finds tools, fields, Model op kinds and guide sections by task. `guide {tool: "mesh_import"}` gives one tool's full description, fields and an example call. `guide {kind}`, `guide {topic}`, `guide {group}` and `guide {}` read an op kind, a worked sequence, an area or the map. `call {tool: "mesh_import", args: {path: "part.stl"}}` runs any tool, which works in clients that never re-read the tool list. A direct call of any tool by name still works, as before. Set `LIME_MCP_TOOLS=core` in the server's `env` for the older core list with `tools_enable`, or `LIME_MCP_TOOLS=all` (or `LIME_MCP_TOOL_GROUPS=0`) to list every tool. `tools_enable {groups: ["model"]}` still adds a group and sends `notifications/tools/list_changed`. The groups are `core`, `model`, `paint`, `supports`, `plate`, `layers`, `calibration`, `machines` and `stress`. See [mcp-server.md](mcp-server.md), "Discovery".

`plan_run {steps: [{tool, args}, ...]}` runs up to 25 calls in one request. Each step is checked and applied as if it were called alone. An argument that is exactly `"$N.path"` becomes step N's result at that path: `"$1.object"` or `"$2.faces.0.index"`. N counts from 1, and the path is field names and list indexes split by dots. The plan stops at the first refused step and returns every step's result so far, with `failedStep`. A plan that runs past about 45 seconds answers with a job, like any long call. No code from the client runs. `guide {topic: "plans"}` has a worked example.

MCP release notes from 2.1.0 to 2.6.0. Later changes are in [mcp-server.md](mcp-server.md):

- 2.1.0: `model_build`, extrude, revolve, shell, pocket, boss, texture, pattern, mirror, labels, `model_params`, `render_view`, `model_check`.
- 2.2.0: `array` and `ribs` over a face; lit, edge-lined renders.
- 2.3.0: `loft` and `sweep`, spline profiles, resumable builds, `onError: "skip"`, located refusals.
- 2.4.0: anchors, `each` loops, `model_define` parts, recipe reruns, `text`, path patterns, colours and sections in renders, thin-wall checks.
- 2.5.0: `ellipsoid`, sweep caps, face colours, the organic guide.
- 2.6.0: `app_open`.

### From a checkout

For development. The server is `mcp/server.ts`. It speaks newline-delimited JSON on stdin and stdout, and loads the slicer in-process from `crates/lime-mcp-engine`. It does not need `lime-slice serve`.

Build the engine first:

```bash
cargo build -p lime-mcp-engine --release
```

The engine library is `target/release/liblime_mcp_engine.so` (`.dylib` on macOS, `lime_mcp_engine.dll` on Windows). Set `LIME_MCP_ENGINE` if it is somewhere else. If a checkout has no engine built, the server uses the installed app's engine and Open CASCADE, but only when their version equals the checkout's. `session_info` then names that engine's path. While that server runs, it holds the installed engine open, so close the client before you install a new version. A different version is refused before it is loaded, with a message that says what to do. An engine that was missing is looked for again on the next call, so you do not need to reconnect after a build.

```json
{
  "mcpServers": {
    "lime-slice": {
      "command": "node",
      "args": ["--experimental-strip-types", "/absolute/path/to/lime-slice/mcp/server.ts"],
      "env": {
        "LIME_MCP_WORKSPACE": "/absolute/path/to/a/workspace",
        "LIME_OCCT_BRIDGE": "/absolute/path/to/lime-slice/target/release/liblime_model_occt.so"
      }
    }
  }
}
```

Node prints an `ExperimentalWarning` on every start of the TypeScript server. That warning is expected. `npm run build:mcp` writes the bundle the installer ships to `src-tauri/resources/mcp`.

Model edits need the Open CASCADE bridge. From a checkout, the server looks next to the `node` program, not next to the desktop app. Set `LIME_OCCT_BRIDGE` to the bridge library. `LIME_MCP_ENGINE` and `LIME_OCCT_BRIDGE` also override what the installed server finds. `LIME_SLICE_BIN` is only for the golden comparison; the server does not run it.

### Live desktop bridge

The live desktop bridge is off unless you opt in. The app listens on `127.0.0.1` only, and only when both variables are set:

```bash
LIME_BRIDGE=1 LIME_BRIDGE_TOKEN=choose-a-token npm run tauri dev
```

The variables must be set in the environment the app starts from; an app that is already open does not read them. For an installed app on Windows, from PowerShell:

```powershell
$env:LIME_BRIDGE = "1"; $env:LIME_BRIDGE_TOKEN = "choose-a-token"; & "$env:LOCALAPPDATA\Lime Slice\lime-slice-desktop.exe"
```

Point the MCP process at that listener with `LIME_MCP_BRIDGE=http://127.0.0.1:43119/` and the same `LIME_MCP_BRIDGE_TOKEN`. 43119 is the preferred port (`LIME_BRIDGE_PORT` sets it). If Windows reserved it (Hyper-V and WinNAT reserve ranges; see `netsh int ipv4 show excludedportrange protocol=tcp`) or another copy holds it, the app binds a free loopback port and writes that URL to `tandem-bridge.json`, which the bundled MCP reads; with `LIME_BRIDGE_PORT` set, a port that cannot be bound is an error instead. For another MCP client, use Copy MCP settings in the app: it gives the real URL. Both sides must run this version: an older app or server does not speak the mesh-carrying message. `app_open` asks the window to open a file with `{"open": "<path>"}`, only when the window's answers name `open` in `X-Lime-Bridge-Features`; an older window is started again with the file instead.

Each mirror is the whole plate after the tool, with the server's session id and a sequence number, so a missed message is repaired by the next one. A mesh the desktop does not have rides along once: the file bytes and the triangles the server read from them. A commit therefore shows the Open CASCADE triangles the server slices, not a fresh read of the STEP. A new solid appears at its first commit, and the window switches to Prepare to show it. The desktop adds, moves, and removes the objects the server sent; parts you opened yourself stay. A committed mesh drops that object's own Model history in the window, since the history no longer builds it. Each answer names the window's instance; a restarted app or a reloaded page gets every mesh again on the next tool. A mirror that cannot connect does not fail the tool, and closing the app leaves the headless session as it was.

[mcp-server.md](mcp-server.md) lists the tools and what is deferred. [mcp-server-review-2.md](mcp-server-review-2.md) records the resolution of each review finding.
