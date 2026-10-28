---
type: Component
title: MCP server
description: One Node process speaks MCP on stdio and loads the slicer in-process. It does not send a job to a printer.
tags: [architecture, mcp]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
sources:
  - id: server
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/server.ts
    title: mcp/server.ts
  - id: protocol
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/protocol.ts
    title: mcp/protocol.ts
  - id: version
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/version.ts
    title: mcp/version.ts
  - id: schema
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/schema.ts
    title: mcp/schema.ts
  - id: readme
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md
    title: README.md
  - id: bridge-client
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/bridge-client.ts
    title: mcp/bridge-client.ts
  - id: pkg
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/package.json
    title: package.json
---

# Process

`mcp/server.ts` is one process, stdio, with the slicer linked in-process. stdout is the protocol. Diagnostics go to stderr. `LIME_MCP_FAKE=1` uses a fake engine. Otherwise it loads the engine worker and constructs a `Session`.[1]

`mcp/protocol.ts` is MCP over stdio, one JSON-RPC message per line. Logs stay off stdout. `initialize` answers `serverInfo` `{ name: "lime-slice", version: appVersion() }`. Protocol versions it accepts are `2024-11-05`, `2025-03-26`, and `2025-06-18`. An unrecognised request gets `2024-11-05`.[2] `appVersion()` reads the bundled version or `package.json`, which is 4.2.0.[3] [7]

The tool list is `TOOLS` in `mcp/schema.ts`. See [Tool catalog](../mcp/tools.md). Prompts, which are not tools, are `slice-for-machine`, `hole-on-face`, `split-fillet-export`, `paint-supports`, `calibrate-pa`, and `explain-slice-failure`. The slice prompt says "Do not send it to a printer."[2]

# What it will not do

`session_info`'s description ends with "Nothing is sent to a printer."[4] The README says the same: an LLM can import or build a part, edit it in Model, place it, change settings, slice, and write G-code, and there is no send-to-printer tool. The desktop window can upload G-code to a host. The server cannot.[5]

The server writes projects, STEP, and G-code only inside the workspace folder the client configures.[5]

# Engine and desktop

The first engine implementation loads `lime-mcp-engine` in-process. See [Engine](engine.md). `package.json` has `build:mcp` (`node tools/mcp/bundle.mjs`) and no script that starts the server. A checkout runs `node` on `mcp/server.ts` after `cargo build -p lime-mcp-engine --release`. The installed app uses `server.mjs`.[7] [5]

The live desktop bridge is separate. The MCP client refuses a bridge URL whose host is not `127.0.0.1`, `localhost`, `::1`, or `[::1]`.[6] See [Desktop shell](desktop.md).

# Citations

[1] [mcp/server.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/server.ts)
[2] [mcp/protocol.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/protocol.ts)
[3] [mcp/version.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/version.ts)
[4] [mcp/schema.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/schema.ts)
[5] [README.md](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md)
[6] [mcp/bridge-client.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/bridge-client.ts)
[7] [package.json](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/package.json)
