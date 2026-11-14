# Plan: progressive discovery for the MCP interface

Status: plan, for review. Written 2026-11-14 against `main` at `bfa4c0fa` (the merge of #673). Docs only: no code changes with this plan. The implementation follows on its own branch and PR and keeps to this text; where it learns otherwise, it updates this file in the same PR.

The owner's request: "the limit of the MCP - progressive discovery, that needs to be the way to communicate, so the interface is not limited by a fix 'budget' of tokens."

## 1. The problem, measured

Token counts below are UTF-8 bytes / 4, rounded up, the rule `mcp/schema.test.ts` uses. They were measured on `bfa4c0fa` with `listedTools` and a fake-engine `Session`.

| What a client reads | Tokens | Tools | Bound in `schema.test.ts` |
|---|---|---|---|
| Server instructions (initialize) | 378 | | none |
| First `tools/list` (groups on, none opened) | 5,649 | 31 | 5,650 |
| Flat `tools/list` (`LIME_MCP_TOOL_GROUPS=0`) | 18,249 | 96 | 18,250 |
| Model group, added to the list by `tools_enable` | +6,998 | 28 | (inside the flat bound) |
| Stress / plate / layers / paint groups | +1,584 / +1,212 / +1,006 / +874 | | |

Both bounds are full to the token. Of the flat list's 18,249 tokens, tool descriptions are 2,348 and input schemas (with their field descriptions) 13,174, so the cuts fall mostly on field descriptions.

Every feature is now paid for by another tool's words:

- #673 cut `model_check` from naming the six gear verdicts to "gears: gear pairs." (33 tokens over).
- #670 paid 20 tokens for `recipe_run {query}` by trimming `recipe_run` itself and five of its fields (`path`, `full`, `profile`, `meshAtEnd`, `plugin`, `keep`).
- #674 (open) pays for `model_place {gears}` by trimming `model_place`, `root`, `compact` and `objects`.
- `ccf8e8f4` trimmed eight Model descriptions, dropping facts such as "At the root, nothing changes" (`model_undo`) and "The root and the plated step are refused" (`model_drop`).

### What exists toward discovery

- **Tool groups.** Only the 31 core tools are listed; `tools_enable {groups}` adds a group and sends `notifications/tools/list_changed`; calling a tool of a closed group by name opens it.
- **Guides.** `guide {topic, section}` reads one section of a long guide; `guide {kind}` returns one Model op kind's full schema and its example lines (or the `assembly`, `place`, `pose` texts).
- **Lean op schema.** `model_apply`'s op is listed as kind names and one line each; the server checks every call against the full schema.
- **Refusals with fields.** A wrong top-level field names up to 16 of the tool's fields; a wrong op field names the kind's fields and `guide {kind}`.
- **plan_run** calls any tool by name as a step, which is today's way around a client that does not re-read the list.

### What clients do (checked)

| Client | How checked | Re-reads after `list_changed`? | Notes |
|---|---|---|---|
| Claude Code 2.1.312 (desktop Code tab) | This session, against the installed server: `tools_enable {groups:["calibration"]}`, then searched its tool registry | **No** (the four calibration tools did not appear in the session) | Loads MCP tools on demand by search; turns `items: {enum}` into `items: {}`, so enums inside arrays are lost. |
| MCP TypeScript SDK client | `mcp/stdio.test.ts` | Only when the caller asks | The reference client; nothing re-reads by itself. |
| Claude Desktop, Cursor, ChatGPT, Grok | Not checked here | Unknown | Cursor has capped the number of tools per session in the past; ChatGPT caches a connector's tools. |

So the design may rely on `tools/list` and `tools/call` only. A list that changes mid-session is a bonus for some clients and invisible to others, and in clients that keep the tool list in the prompt it also invalidates the prompt cache.

## 2. Decisions

### D1. What an agent sees first

**First contact is four tools and a short map, and its size is bound.** `tools/list` (default mode) lists:

| Tool | What it does | Fields (fixed) |
|---|---|---|
| `guide` | Find and read everything: search by task, one tool, one op kind, one area, one worked guide. | `query`, `tool`, `kind`, `group`, `topic`, `section`, `full` |
| `call` | Run any tool by name. | `tool`, `args` |
| `plan_run` | Run several calls in one, a step reading an earlier one's result. | unchanged |
| `session_info` | Server, engine, plate state. | unchanged |

The server's instructions carry the map: how to find and call, and one line per **area** (slicing, Model, assemblies and pose, paint, supports, plate, layers, calibration, machines, stress). An area line names what the area is for, never its tools, so adding a tool to an area does not change it. Adding an area is a deliberate change that the bound below catches.

**Target:** instructions + first `tools/list` ≤ **1,500 tokens** (today 6,027), held by the test with no headroom clauses for features: a feature never enters first contact.

`guide` and `call` have generic, fixed schemas. Neither description lists catalogue content.

### D2. How it finds the rest

**One discovery tool, `guide`, over one catalogue.** The catalogue is every tool (`TOOLS`), every op kind (`OP_KINDS`), the kind texts (`assembly`, `place`, `pose`, `recipes`) and the guide topics. There is no fourth mechanism; the existing ones become modes of `guide`:

| Ask | Answer | Was |
|---|---|---|
| `guide {query:"couple gears"}` | Up to 8 ranked lines: `tool model_place {gears}: Couple meshing gears…`, `op gear: spur gear…`, `topic pose`… each with the call that reads it in full. | new |
| `guide {tool:"model_place"}` | The tool's full description, its area, one line per field (name, shape, required, description), an example call, and `guide {kind}` pointers for op fields. `schema:true` adds the raw JSON schema. | `tools_enable {schemas:true, tools}` |
| `guide {kind:"fillet"}` | One op kind's full schema and examples. | unchanged |
| `guide {group:"model"}` | The area's tools, one line each (the first sentence of its description). | `tools_enable`'s group list |
| `guide {topic, section}` | A worked sequence, or one section of it. | unchanged |
| `guide {}` | The map: areas with their tool counts, and the topics. | the topic list |

Search ranks by words shared with the entry's name parts, description, field names and field descriptions, with name and field-name hits weighted highest, so "couple gears" finds `model_place`'s `gears` field without an alias table. A no-hit query answers with the areas.

`tools_enable` stays and still works (it adds a group to the list for clients that re-read it, and sends `list_changed`); it is no longer listed in the default mode and its reply points at `guide {group}`. Field hints in refusals stay as they are and end with `guide {tool:"…"}` when the field list was cut.

### D3. How it calls what it found

**Both: a generic `call` tool for every client, and native listing on request for those that re-read.**

- `call {tool, args}` runs any tool through the same path as a direct call: validation, lean replies, progress, the long-call detach, autosave, the bridge mirror, inline images. It does **not** open a group or change the list, so a session that uses only `call` never sends `list_changed` and never busts a client's prompt cache.
- A direct `tools/call` of any tool by name still works, listed or not, exactly as today (including opening the tool's group).
- `tools_enable {groups}` still lists a group natively for clients that re-read; it is the opt-in, not the path.

Why not listing tools on demand only: Claude Code did not show re-listed tools in the session (section 1), other clients are unknown, and each list change re-sends the list. Why not a generic tool only: native listing gives a client typed arguments, and some agents and saved prompts call tools by name; keeping it costs nothing.

**A wrong first call is cheap to correct.** Through `call`:

- an unknown tool answers `There is no tool named X. Close: a, b. guide {query} finds tools.` (nearest names by search);
- a wrong field answers with the tool's fields (all of them, or the first 16 and `guide {tool:"x"}` for the rest), in one sentence;
- a wrong op field keeps today's answer (the kind's fields and `guide {kind}`).

### D4. Where descriptions live

**`TOOLS` in `mcp/schema.ts` stays the one place for a tool's description and field descriptions, now written for clarity.** Discovery reads it; so do the native list modes. A tool's area line is the first sentence of its description, so the first sentence of every description must stand alone. Examples live in `mcp/examples.ts`, one or more per tool (kept apart from `TOOLS` so a tool's text and its example can be read on their own, and so this change does not rewrite 2,500 lines that other branches touch).

Restored in the implementation: `model_check`'s gear verdicts (#673); `recipe_run` and its six fields (#670); the eight Model descriptions from `ccf8e8f4`. #674's three trims are restored when #674 is on `main` (if it merges first, in this PR; otherwise in a follow-up of a few lines, which the new tests allow without any budget edit).

The native list modes (`core`, `all`) send these full descriptions, so they grow past today's numbers. That is the cost of opting out of discovery, and it is no longer bounded.

### D5. What replaces the budget test

`mcp/schema.test.ts` keeps:

- **First contact bound:** instructions + default `tools/list` ≤ 1,500 tokens, and exactly the four tools of D1.
- **Reachability:** every listed-or-unlisted tool except deprecated aliases (`plugin`) is in the catalogue; `guide {query:<its name>}` ranks it first; `guide {tool}` answers with a description, a line for every field and an example.
- **Examples:** every tool has an example in `mcp/examples.ts`, and every example passes `validateTool`; every op kind has a summary and at least one example line (`guide {kind}` examples non-empty).
- **Descriptions:** every field has a description (as today), every tool's first sentence ends with a full stop and is under 200 characters (it is the area line).
- **One reply bound per tool:** `guide {tool}` for one tool fits 3,000 tokens. This bounds only that tool's own reply, so adding to one tool never touches another.

Removed: the per-tool budget (750, `model_apply` 900), the flat-list total (18,250) and the 5,650 first-list bound with their history comments.

### D6. Compatibility and cost

Calls that work today keep working:

- Every tool still answers a direct `tools/call` by name, with the same validation and replies.
- `tools_enable` works and still sends `list_changed`; `guide {topic, section, kind}` answer as before.
- `LIME_MCP_TOOL_GROUPS=0` still lists every tool. A new `LIME_MCP_TOOLS` picks the list: `discovery` (default), `core` (today's 31 core tools and `tools_enable`), `all` (every tool, same as `LIME_MCP_TOOL_GROUPS=0`).

Interface text for three tasks, before and after. "Before" assumes the client re-reads the list after `tools_enable`, the cheapest case it had. "After" counts every discovery reply and the `call` wrappers (about 7 tokens a call). Measured by `mcp/bench/discovery-cost.ts`: the lists from before are the numbers in section 1, and every guide reply is measured live.

| Task | Before | After | What the agent reads after |
|---|---|---|---|
| Slice an imported mesh | 6,027 | **2,049** (34 %) | first contact 1,440; `guide {topic:"slice"}` 556; 7 wrappers 53 |
| Build and edit a small model | 13,871 | **3,335** (24 %) | + `guide {query:"build a part"}` 289, `{tool:"model_build"}` 553, `{kind:"hole"}` 403, `{kind:"fillet"}` 289, `{tool:"model_edit"}` 340 |
| Couple and turn a gear train | 15,341 | **4,540** (30 %) | + `guide {query:"gear train"}` 297, `{kind:"gear"}` 1,120, `{kind:"assembly"}` 509, `{kind:"pose"}` 533, `{tool:"model_place"}` 369, `{tool:"pose_animate"}` 222 |

Discovery costs more only when a session reads many tool docs one at a time. More than about ten `guide {tool}` replies for core tools (300–550 tokens each) pass the old 6,027-token core list. The worked guides keep that rare: `guide {topic:"slice"}` names the slice path's fields, and a real client sliced from it with no `guide {tool}` at all (section 4). Anyone who prefers the old trade sets `LIME_MCP_TOOLS=core`.

### D7. Rollout

1. **Ships first, in one PR:** the catalogue, `guide {query, tool, group}`, `call`, `mcp/examples.ts`, the default `discovery` list, the new instructions, the new `schema.test.ts` rules, stdio tests for discovery and compatibility, restored descriptions, `docs/mcp-server.md`.
2. **What an older client sees:** four tools and the map. A client that never re-reads the list does everything through `call` (or `plan_run`). An agent or saved prompt that names `mesh_import` reads the instructions' "any tool by name through call" and calls `call {tool:"mesh_import", args}`; a client that can call unlisted tools by name keeps doing so. Anyone who wants today's list sets `LIME_MCP_TOOLS=core` in their own client config (the server never edits it).
3. **Later, not in this PR:** the open #674 trims restored once it lands; `GROUP_TOOLS_SHORT` and `TOOLS_ENABLE_HELP` reduced to the area lines once `tools_enable` is used only by re-reading clients.

## 3. What the implementation learned (changes to this plan)

- **First contact measures 1,440 tokens**: instructions 401, `tools/list` 1,039 (the four tools; `plan_run`'s step schema is most of it). That is under the 1,500 target.
- **`call` is listed in every mode**, `core` and `all` included, so even a client on the old lists can reach a tool outside them.
- **`tools_enable` accepts `core`**, so a re-reading client can ask for the old core tools natively. `LIME_MCP_TOOLS=core` starts a session with that group open.
- **A direct call of an unknown tool** answers with the close names too, not only one made through `call`.
- **The first sentence of a description is the search and area line**, so 55 descriptions that began "After X." or were a bare noun phrase ("Solve.", "Trees from the last slice.") were rewritten to say what the tool does first. The test requires 20–200 characters and a full stop.
- **Restored text:** `model_check`'s gear verdicts (#673); `recipe_run` and its `path`, `query`, `full`, `profile`, `meshAtEnd`, `plugin`, `keep` (#670); `model_undo`, `model_redo`, `model_drop`, `model_goto`, `model_history`, `model_rename`, `model_commit`, `model_build`, `model_edit {patch}` and `unify` (`ccf8e8f4`). #674 is still open, so its trims of `model_place` are not touched here: that file belongs to the gear-coupling work.
- **The core list and the flat list grow** with the restored and rewritten text: about 6,180 and 19,270 tokens. Nothing bounds them now. They are opt-in.
- **Examples:** `mcp/examples.ts` has 142 examples for 99 tools (the `plugin` alias included), all checked by `validateTool`.

## 4. Clients checked

- **Claude Code 2.1.312, installed server, Code tab.** `tools_enable` sent `list_changed`, but the opened tools never appeared in the session.
- **Claude Code CLI 2.1.312, new server (`claude -p --model haiku`, scratch config, fake engine).** Asked to import a cube, slice it and report time and grams, it loaded `guide`, `call` and `session_info`. It read `guide {topic:"slice"}` and `session_info`, then ran `call` for `mesh_import`, `machine_list`, `machine_select`, `slice_start`, `slice_wait` and `gcode_summary`, all right the first time, with no refusal.
- **MCP SDK client (`mcp/stdio.test.ts`).** Covers discovery and compatibility with a client that reads the list once.
- **Not checked:** Claude Desktop, Cursor, ChatGPT, Grok.

## 5. Non-goals

- No new transport or MCP extension; only `initialize`, `tools/list`, `tools/call`, resources and prompts as today.
- No change to any tool's behaviour or reply (gear coupling in `mcp/session/place.ts` is left alone).
- No embedding search or model calls; ranking is word overlap, deterministic and testable.
