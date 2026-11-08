# Plan: Tandem, a shared working session for a person and an assistant

Status: implementation in progress on `codex/tandem-awareness`. This plan covers the whole app, including Model, Prepare, Pose and animation. It follows the pose-animation work; its first work can proceed while that work finishes review.

Current work: an initial activity indicator and an on-demand human-context summary are being built. The desktop preserves independent changes to mirrored parts while accepting changes to other parts; competing changes to one part pause the snapshot. MCP can inspect a bounded summary of changed desktop poses and explicitly import compatible placements with `tandem_pull`. That pull checks all reported baselines before changing anything and is undoable, but the desktop summary is asynchronous and the pull is not an atomic lock on the human's next edit. The desktop records a bounded asynchronous receipt for each handled plate snapshot, and the originating MCP result can identify the snapshot. Missing receipts mean the outcome is unknown; `diverged` means the desktop preserved an edit that MCP does not yet contain. Settings, editable Model history, initial synchronization and reconnection need their own protection. No milestone is complete until its acceptance conditions below are met.

## 1. Goal

A person can keep working in Lime Slice while an assistant contributes through MCP. Each can see enough of the other's activity to coordinate, and neither silently overwrites the other's work. The person can tell which part the assistant is working on and what changed; the assistant can find out what the person is looking at or editing and work against a current session.

Tandem should feel like a useful companion, not a second application: quiet when idle, responsive when active, and inexpensive in CPU, memory, network traffic and tokens. It is optional and local; normal desktop and headless use continue to work without it.

## 2. Starting point

The existing authenticated, loopback-only bridge sends MCP snapshots to the desktop. It preserves desktop-only plate objects and waits for an active pose gesture, but the MCP and desktop hold separate state. It does not report human activity back to MCP, acknowledge that a snapshot was applied, or prevent an incoming snapshot from replacing a person's changes to a previously mirrored object. An HTTP success means the listener accepted a message, not that the window applied it. Tandem must not mistake this mirror for a shared authoritative session.

## 3. Decisions

### D1. One session, explicit connection

Extend the existing opt-in local bridge and its authentication. Do not add a cloud service, background account, or separate assistant process. A connected window and MCP session identify themselves and their current document; reconnecting or opening another document invalidates the old common baseline. Show when Tandem is connected, disconnected or needs attention. A missing or older peer must degrade clearly, without claiming edits are shared.

### D2. Useful awareness in both directions

The human sees a compact indication of the assistant's current operation and target, with an unobtrusive highlight where the target is visible. Recent completed changes remain discoverable briefly. Avoid flashing for very short operations; clear activity on completion, failure, disconnect and timeout. A concise activity list is preferable to a permanent minimap unless a minimap proves useful for the work.

The assistant can request a bounded current summary: connection/document identity, stage, selected part, active human gesture or edit, and relevant recent changes. Send names and identifiers needed to coordinate, not keystrokes, prompts or arbitrary document contents. Events represent meaningful changes rather than cursor tracking. Read-only observation must not change the document.

### D3. Do not lose either person's work

Mutations need a common revision and an acknowledgement from the window after application, not just transport delivery. Track the baseline at the smallest practical unit, such as a part or setting, and detect concurrent changes before applying a stale result. Independent changes can proceed; conflicting edits must be retained and surfaced with a clear choice or a retry against current state. A gesture or unfinished edit is not interrupted. Never silently pick a winner, claim a failed update succeeded, or discard a Model tree merely to display a stale mesh.

Operations whose state cannot yet be synchronized safely must be explicitly refused or reported as unavailable for shared editing. The scope of support must be discoverable by both participants. Existing non-Tandem headless behavior remains available.

### D4. Share meaningful state, not just presence

Desktop changes must become available to the assistant, and accepted assistant changes must appear in the desktop. Preserve object identity, geometry and editable Model history, assembly and pose data, settings, project state, and undo semantics as each area is supported. A rendered mesh alone is not an editable Model tree. The assistant must know the revision it is editing and get a useful stale-state response rather than a misleading success.

### D5. Keep it nimble

Use bounded messages and on-demand or event-driven updates; no continuous mesh hashing, screenshots, cursor streams or repeated full-project transfers. Reuse cached meshes and existing session machinery. Coalesce transient activity, limit retained history, and keep MCP replies short. Disconnect must not block ordinary work, and failures must be visible without interrupting unrelated editing.

## 4. Delivery

| Milestone | Deliverable | Done when |
| --- | --- | --- |
| M1 | Protocol, connection and awareness | The connected desktop shows assistant activity and target; MCP can read a bounded summary of human context. Off, older-peer, reconnect and failure behavior are explicit. |
| M2 | Safe shared plate work | Human and assistant plate edits synchronize with applied acknowledgements and per-object conflict detection; independent edits survive and conflicts are recoverable. |
| M3 | Model and project work | Editable geometry/history and project lifecycle synchronize safely, or the precise unsupported operation is refused. Undo, save and reopen retain both sides' accepted work. |
| M4 | Pose, settings and animation | Supported operations share the same revision/conflict rules and preserve in-progress human gestures. |
| M5 | Polish and end-to-end exercise | A person and MCP work in the same session, understand each other's actions, recover from a conflict and reconnect, and see no distracting idle UI. Document setup and actual supported scope. |

Milestones may be split into reviewable PRs. A milestone is not complete merely because a status indicator exists or a mesh was mirrored.

## 5. Verification

Test disconnected and older peers, authentication and loopback restrictions, multiple operations and failures, bounded activity, page/server restart and document switch. Exercise simultaneous independent edits, same-object conflicts, deletion, undo, a human gesture in progress, and a rejected or delayed apply. Verify real desktop-to-MCP-to-desktop behavior, including saving and reopening a project. Test the UI for readable, quiet indicators and correct targets. Run focused tests during development and the repository's relevant checks before delivery.

## 6. Non-goals

No multi-user cloud collaboration, live chat, surveillance of every pointer movement, arbitrary remote connections, automatic conflict resolution that loses work, or requirement to use a specific model provider. Tandem complements the existing MCP client; it does not introduce an LLM into the app.
