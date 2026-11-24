# Plan: one Export, and assemblies made where they are posed

Status: proposed. The owner asked on 2026-11-24, after looking for an STL export: "so, i link in prepare — prepare that is meant only for positioning on the belt/bed, for printing — then i do something in pose and it gets possible to be exported… at least silly". And: "i need a coherent way of interacting with the lime-slice. it seems so blind evolution."

This plan fixes the two places that request found. It is the first plan written to one rule, which a wider interaction-model plan will apply to every stage: **a stage owns one job, and work that is no stage's job (files, export, settings) belongs to the app, reachable from anywhere.**

## 1. What there is today

### Export: six entry points, each in a different place

| Entry | Where | Writes | Shown when |
|---|---|---|---|
| Export | the top bar, Ctrl+E | G-code | after a slice |
| Export 3MF | File menu | the plate as laid out on the bed | always |
| STEP | the Model rail's foot (`#modelStep`) | the open solid | in Model, on a solid |
| STEP | an assembly's header in Prepare's object list | the assembly, flat or tree | the plate has an assembly |
| Export… | the Pose panel, under Parts (`src/app/pose.ts:702`) | STEP tree or flat, glTF, 3MF, STL, OBJ, pose sheet | only if `liveAssemblies()` is not empty |
| Export… | the Pose panel, beside Stop (`src/app/pose.ts:748`) | the same, at the animation frame | an animation is loaded and stopped |
| Split to print's sheet | Model, Split to print | STL, 3MF or STEP per piece | after a split |

None of 3MF, STEP or the Pose export is a command (`src/ui/commands.ts`), so none is in the palette, the shortcut sheet or a key. A plate of free parts has no STL, OBJ or glTF export at all: the Pose dialog (`src/app/pose-export-dialog.ts`) toasts "There is no assembly to export."

The MCP has three tools for the same act: `export_3mf {name, object?, pieces?, stl?}`, `model_export_step {object, name, assembly?, flat?}` and `pose_export {assembly, format, frame?, path?}`.

### Assemblies: made in Prepare, used in Pose

- An assembly is made with **Attach** in Prepare's object list (`attachPlateObject`, `src/app/plate-actions.ts:80`, from `docs/plan-assemblies.md` M5). **Ungroup**, **Lay out** and **STEP** sit on the assembly's header there, and Prepare has a "Print layout | Assembly" view chip.
- Pose's **Link** tool (L) links a child to a parent, but refuses a free parent: "Attach the parent to an assembly in Prepare first." (`src/app/pose.ts:432`). Its hint says the same: "Attach free parts in Prepare."
- So to pose two parts, a person goes to the stage for the bed, uses a tool that does not move anything on the bed, then comes back.

Prepare's job is the print layout: where parts lie on the belt or bed. Attach does not touch the print layout (an assembly is a set of `modelPose`s, `docs/plan-assemblies.md` section 2). It sits in Prepare only because the object list did.

## 2. Goal

1. **One Export**, owned by the app: File → Export…, a palette command and a key, opening one dialog for every format and every scope. Free parts export too.
2. **Assemblies are made in Pose**, where they are used. Pose's Link tool makes the assembly when the parent is free. Prepare keeps only what the print layout needs.
3. **The old entry points stay as shortcuts** into the same dialog, filled in for where they are. Nothing a person knows today disappears without a pointer.

### Non-goals

- No new file format. Every format below is written today by some path (`docs/plan-pose-export.md`, `export_3mf`, Split to print).
- No import of these formats into a rig. Opening a file is unchanged.
- No change to the slice, the print layout, a cache key, or the `.lime` file. `session.assemblies` keeps its shape, so every saved project opens as it does now.
- G-code stays the top bar's Export and Ctrl+E. It is the print, not a model file.

## 3. Decisions

- **D1. Scope, then format.** The dialog asks first what to export, then how:

  | Scope | Means | Formats |
  |---|---|---|
  | Selected part | the selected object, in its own frame | STEP (exact when the part has a solid), STL, 3MF, OBJ, glTF |
  | Assembly | one assembly at Pose's current pose, or at the stopped animation frame | STEP tree or flat, glTF (optionally animated), 3MF, STL one or each, OBJ, pose sheet |
  | Plate, assembled | every object at its `modelPose`; assemblies as sub-trees, free parts at the top level | the same as Assembly, without animation |
  | Plate, print layout | every object as it lies on the bed | 3MF (today's File → Export 3MF), STL one or each |

  The default scope follows the selection: a member selects its assembly, a free part selects itself, nothing selected selects "Plate, assembled". The dialog remembers the last format per scope for the session.
- **D2. Free parts are a loose assembly.** "Plate, assembled" with free parts is written by the same writers as an assembly, each free part a top-level member at its `modelPose` with no joint. No second code path per format.
- **D3. One key: Ctrl+Shift+E** (free today). Palette: "Export…", plus one entry per scope ("Export part…", "Export assembly…", "Export plate…") that opens the dialog on that scope.
- **D4. Shortcuts open the dialog.** File → Export 3MF becomes File → Export… (the dialog, scope "Plate, print layout", format 3MF). The Model rail's STEP opens it on "Selected part", STEP. The assembly header's STEP and Pose's two Export… buttons open it on that assembly (or frame). Split to print's sheet stays as it is: its pieces are not on the plate.
- **D5. Pose makes assemblies.** Link with a free parent makes a new assembly named after the parent, with it as the root, then links the child, which is what Attach does today, in one Undo step. Pose's Parts list gets the assembly header (name, N parts) with **Ungroup** and **Export…**. The hint becomes "Link two parts to pose them together."
- **D6. Prepare keeps what the bed needs.** Prepare's object list still shows each assembly's header and its members (the bed needs to know what moves together), with **Lay out**. Attach, Ungroup and STEP leave Prepare's list: Attach and Ungroup go to Pose, STEP goes to Export. For one release, Prepare's header keeps a small "Edit in Pose" link where Attach was, so a person who looks there finds the new place.
- **D7. The view chip.** Prepare's "Print layout | Assembly" chip stays for now: it is how the bed shows the assembled design next to the layout. The interaction-model plan decides whether Pose shows it instead.
- **D8. One MCP tool, old ones kept.** A new `export {scope, format, object?, assembly?, frame?, name}` does what the dialog does. `export_3mf`, `model_export_step` and `pose_export` keep working unchanged, and their descriptions say "the same as export {scope:…}". An MCP `assembly_link {child, parent}` makes or extends an assembly, as Link does; today a recipe does it with `attach` and an agent outside a recipe has no call.

## 4. Milestones

### X1: one Export

1. `src/app/export-dialog.ts`: the dialog of D1, built from `pose-export-dialog.ts`, whose writers it calls. A scope list, then a format list for that scope, the frame line ("Now" or "Frame 37 of Wave"), the file name, Save.
2. Free parts as a loose assembly (D2) for the assembled scopes, and the print-layout scope through today's 3MF and STL encoders.
3. The command `export-model` (Ctrl+Shift+E) and the three scoped palette entries (D3). File → Export… replaces Export 3MF in the menu (D4).
4. Every old entry point opens the dialog filled in (D4). `showPoseExport` becomes a call into it.
5. MCP `export` (D8), with its guide entry, and the three old tools pointing to it.

Tests:
- `src/export-scope.test.ts` (unit): default scope per selection, formats per scope, a free part's member placement equals its `modelPose`.
- `e2e/export-dialog.spec.ts` (new, in `test:smoke`, three passes with `--repeat-each=3`): a plate of two free parts exports STL each (a ZIP of two), OBJ and STEP; with an assembly, the scope defaults to it; File → Export… with nothing selected offers "Plate, assembled"; the palette finds "Export…"; Ctrl+Shift+E opens it; Pose's Export… opens it on the assembly. Screenshots in the owner's dark 1440×1000 view.
- `e2e/pose-export.spec.ts` and the File menu specs pass with only their clicks changed: no assertion is loosened.
- `mcp/export.test.ts`: each scope and format writes a file; the three old tools give the same bytes as `export` for the same request.

### X2: assemblies made in Pose

1. Link with a free parent makes the assembly (D5), one Undo step, with `frame: "part"` on the attached part as Attach gives it today (`docs/plan-assemblies.md` D2).
2. Pose's Parts list: the assembly header with Ungroup and Export…; free parts listed under "Free parts".
3. Prepare's object list: the header keeps Lay out and gets "Edit in Pose"; Attach, Ungroup and STEP move out (D6).
4. MCP `assembly_link` (D8).

Tests:
- `e2e/assembly.spec.ts`: Attach and Ungroup are done from Pose; every assertion about the group, the view chip, the bed warnings and Undo stays as it is.
- `e2e/pose-link.spec.ts` (new): Link on two free parts makes one assembly of two, both keep their positions, one Undo takes it back.
- `mcp/assembly-link.test.ts`: a link of free parts, a link into an existing assembly, and a refusal for a cycle.

Each milestone updates the docs it touches (`docs/plan-assemblies.md` M5 gets a pointer here, the MCP guide) and the README's sentences about export and Attach.

## 5. Order

X1 first: it is the owner's request and stands alone. X2 next, as its own PR. Both go to main through PRs reviewed on the Claude side.

## 6. For the owner

1. **Ctrl+Shift+E** for Export (D3), or another key?
2. **Prepare's "Edit in Pose" link** (D6): keep it for one release, or leave Prepare's header with Lay out only from the start?
