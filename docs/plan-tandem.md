# Plan: Tandem, a shared working session for a person and an assistant

Status: implementation in progress on `codex/tandem-awareness`. This plan covers the whole app, including Model, Prepare, Pose and animation. It follows the pose-animation work; its first work can proceed while that work finishes review.

The separately tagged Tandem beta uses product name `Lime Slice Tandem Beta`, executable `lime-slice-tandem-beta`, and app-data identifier `com.limeslice.slicer.tandem-beta`. Its bundled MCP uses the same separate plugin library. It does not register the production file associations or Windows Explorer handler. When enabled, its local bridge defaults to port 43129; set `LIME_MCP_BRIDGE` to `http://127.0.0.1:43129/` and provide matching bridge tokens. The beta is experimental and should be tested with project copies.

Current work: an initial activity indicator and an on-demand human-context summary are being built. The desktop preserves independent changes to mirrored parts while accepting changes to other parts; competing changes to one part hold that part back while the rest of the snapshot applies. MCP can inspect a bounded summary of changed desktop poses and explicitly import compatible placements with `tandem_pull`. That pull checks all reported baselines before changing anything and is undoable, but the desktop summary is asynchronous and the pull is not an atomic lock on the human's next edit. The desktop records a bounded asynchronous receipt for each handled plate snapshot, and the originating MCP result can identify the snapshot. Missing receipts mean the outcome is unknown; `diverged` means the desktop preserved an edit that MCP does not yet contain. Settings, editable Model history, initial synchronization and reconnection need their own protection. No milestone is complete until its acceptance conditions below are met.

Until Model histories can be reconciled, the desktop refuses a mirrored mesh replacement or removal that would discard a Model history already held by the desktop. This is a preservation guard, not editable Model synchronization.

The placement pull also refuses while another MCP operation is in flight or the desktop has not acknowledged the latest MCP plate sequence. This closes those stale-snapshot cases but does not lock the desktop against a new human gesture after its context is published.

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

On 2026-11-08, a separate Windows desktop from this branch and a real MCP stdio server with the 6.1.0 native engine exercised a disposable STL project. A human changed X from 110 to 130 in the desktop; `tandem_pull` brought MCP to X 130. A competing desktop X 140 and MCP X 150 left both versions intact, produced a `conflict` receipt, and refused a stale pull. After undoing MCP's competing change, two copies of the same STL were loaded; a desktop move of the first and an MCP move of the second both survived, the receipt said `diverged`, and a pull brought MCP to both positions. The native engine reported OCCT unavailable; this placement exercise used STL and did not require it. Save/reopen, real Model geometry, gestures in flight, and desktop restart still need end-to-end coverage.

A subsequent Windows test saved an STL project at X 135, opened a new project and reopened it; the desktop showed X 135. Restarting the desktop while retaining the MCP session restored the same part and position after the next MCP call. With the installed OCCT library explicitly configured, MCP created and drilled a solid and the live desktop showed its committed shape. The live mirror exposed that shape as a mesh, with no editable Model history; opening the MCP-saved `.lime` in a fresh desktop restored both the solid and its hole history. During this test `app_open` reported success before a dirty desktop had accepted its discard prompt; its result now calls this a delivered request rather than a confirmed open. Gestures in flight, editable live Model synchronization, and broader restart/conflict cases still need end-to-end coverage.

The separately installed Windows beta was also tested with its bundled MCP and OCCT: a real box was committed, a desktop move was pulled into MCP, and a competing move generated a conflict while preserving both poses. The beta reported the conflict as `tandem-busy` when asked to pull; the branch now reports `tandem-conflict` so the agent knows to reconcile rather than wait. Undoing the MCP move and pulling the desktop position restored agreement.

### Findings from the beta (2026-11-09) and what changed

The installed v6.1.0-tandem-beta.3 (tag on a503ef5f) and its bundled MCP were tested with real OCCT. A person made "Sphere 1" in the window and saved it; MCP opened that project, fused 107 small spheres onto it and committed (held: the window holds Sphere 1's Model history), then made and committed a "Duck".

- **A. A pose nobody chose.** As the Duck arrived, the window showed Sphere 1 upside down, and the context reported it as the person's change (orient about 174° about Y: a lay-flat onto a near-top face of the fused mesh, against MCP's identity). The person did nothing. The exact line that turned it was not reproduced: no desktop path writes a non-selected part's pose during a mirror apply, and the only producers of such a matrix are the lay-flat and settle helpers. Whatever ran it, two rules were missing, and both are now in place. (1) A person's change is one the window's Undo would take back: every human edit of the plate is an undo step, so `src/app/history.ts` tells the bridge which parts each step (or the gesture still open, an undo, a redo, a cancelled grab) changed, and only those parts count as `humanChanges`, preserve a desktop version, or hold anything back. A difference the window reached by itself is not reported, and MCP's next snapshot puts it right. (2) After the mirror writes the plate and the window's own follow-ups run (placing, Model following the selection), any mirrored part whose pose is no longer the one written is put back, with a console warning naming it, so the person never sees a pose neither side chose.
- **B. One conflict froze the plate.** The guard skipped the whole snapshot when one part conflicted, and after the Duck's history was adopted from MCP every later MCP commit of the Duck was a "conflict" too, so every MCP step (a duplicate, a place, an arrange) came back `conflict`. Now only the conflicting parts are held: each keeps the window's version (mesh, pose, history; a held part MCP removed stays), its shared baseline stays the version both last agreed on, and every other row applies, new parts included. The receipt lists the held parts (`held: [{object, name, kind}]`), and the context lists each with a reason that says what clears it (undo in the window, `plate_undo` in MCP, or `project_save` from MCP and reopen in the window). A hold clears as soon as the window and MCP's latest version of that part stop conflicting. A Model history that came from MCP and was not touched here is MCP's: its next commit replaces mesh and history together. #650's preservation rules for the conflicting part are unchanged. The window no longer asks for a full resend after a conflict; a held mesh it later needs arrives through the existing missing-mesh path.
- **C. Ingredients could not move between libraries over MCP.** `nugget save {kind:"ingredient", from:"<file>.rs"}` read `from` only as a recipe run. It now imports a kept ingredient file as plugin files import: checked, built alone, marked imported, a clash kept beside as `<id>-2` or replaced with `replace:true`.

Proof: `src/bridge.test.ts` (A: a drifted pose is not a human change, holds nothing back and is healed by a snapshot that adds a part; a snapshot adding a part leaves another mirrored part's pose alone and reports nothing; the same turn made by a person is kept and reported. B: one part held for its Model history while a duplicate, an edit of another part, an arrange and a removal apply; a both-changed hold with another part's move applying), `mcp/tandem-pull.test.ts` (a per-part reason in the refusal), the Rust receipt test (bounded `held` list), and `mcp/ingredient-import.test.ts` (real lust: release library to beta library, then a recipe that `use ingredients::involute_gears::*` builds). Not run here: a real desktop and MCP stdio session repeating the beta's sequence; the desktop wiring (history to bridge, the put-back after an apply) is covered by type checks and the pure functions it calls, not by an end-to-end run.

Out of scope, noted: pulling a part created in the window into MCP (`tandem_pull` answers "not the same mirrored session" for it), and live sync of an editable Model history.

## 6. Non-goals

No multi-user cloud collaboration, live chat, surveillance of every pointer movement, arbitrary remote connections, automatic conflict resolution that loses work, or requirement to use a specific model provider. Tandem complements the existing MCP client; it does not introduce an LLM into the app.
