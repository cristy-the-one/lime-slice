# Plan: one interaction model for Lime Slice

Status: approved on 2026-11-24 with every proposal in section 6 ("Yes, all proposals"). The owner on 2026-11-24: "i need a coherent way of interacting with the lime-slice. it seems so blind evolution. I don't like it."

Lime Slice grew one feature at a time, and each one landed where its author was working. This plan writes down what each part of the window is for, audits every action against it, and sets the rules a new feature follows. `docs/plan-export-and-linking.md` (X1, X2) is the first piece of it.

The audit read `src/ui/commands.ts` (150 commands), the top bar and File menu (`src/app/markup.ts`), the Model rail and its Features menu (`src/app/model/markup.ts`), the Prepare and Pose rails, the Pose panel (`src/app/pose.ts`) and the object list, on `main` at `b0921251`.

## 1. The model

### Two spaces

Every part has two positions, and the app already stores both (`docs/plan-assemblies.md` section 2):

- **Design space:** where the part sits in the thing being designed (`modelPose`). Model edits a part in it. Pose moves parts in it and joins them into assemblies. Exports for other programs read it.
- **Print layout:** where the part lies on the belt or bed to print (orient, offset). Prepare edits it. The slicer and G-code read it.

Today both spaces are edited from several stages and called several names: Prepare's Move and Rotate, Model's Place, Pose's turn, MCP `object_place` and `model_place`. The rule below gives each space one owner.

### Five stages, and the app

| Stage | Its one job | What it may change | What it never changes |
|---|---|---|---|
| **Model** | shape one part | the part's solid and its history | the print layout, other parts |
| **Pose** | put parts together and move them | design space: `modelPose`, assemblies, joints, animations | a solid's shape, the print layout |
| **Prepare** | lay parts out to print | the print layout, paint (supports, seam, reinforce), print settings per part | design space, a solid's shape |
| **Preview** | check the sliced result | supports after slicing, the layer shown | the plate |
| **G-code** | read and send the print | nothing; it reads | anything |

**App level**, reachable from every stage, owned by none: files (new, open, add, save, samples), **export** of any model file, printers and filaments, settings and profiles, the palette, help and the shortcut sheet, undo and redo, theme and window layout.

The stages follow the work: **design (Model, Pose), then print (Prepare, Preview, G-code).** Today the tabs read Prepare 1, Preview 2, G-code 3, Model 4, Pose 5: the slicer came first and the modeler was added after it (D1).

## 2. Rules

- **R1. One job per stage.** An action lives in the stage whose job it serves. If it serves no stage's job, it is app level.
- **R2. One home per action.** Every action has one home: a menu entry or a rail tool. Every other way to reach it (a button elsewhere, a context menu) opens that same home, already filled in. Two dialogs never do one job.
- **R3. Every action is a command.** Anything a person can do has an entry in `COMMANDS`, so the palette finds it and the shortcut sheet lists it. A key is optional; a command is not.
- **R4. One concept, one key.** Where one idea appears in two stages, it has the same key in both: rotate is R, scale is S, move is M, measure is Shift+M, the views are T, Y and I. A letter may mean different things in different stages only for ideas that exist in one stage.
- **R5. Nothing hidden by state.** An action that cannot run now is shown disabled with the reason in its tip. It is never missing until some other step is done elsewhere. (The Pose Export… button that appears only after Attach in Prepare breaks this.)
- **R6. One undo per stage, one key.** Ctrl+Z undoes the last change in the stage you are in, whatever made it: a rail button, a panel, the MCP. A stage may keep its own history, but its Undo is reached by the same key and command.
- **R7. One vocabulary.** The UI label, the command id, the MCP tool and the guide use one word per idea. Where the MCP keeps an older name, the guide says what it is in the window.
- **R8. Print concerns stay out of design stages, except the shape they need.** An operation that changes a solid for printing (Split to print, a print transition) stays in Model, because it is a history step. It is listed under "For printing" and reachable from Prepare's object menu.

## 3. Audit

Verdicts: **ok** (right place, has a command); **cmd** (right place, needs a command, R3); **move** (wrong stage); **merge** (a second home for one job, R2); **key** (breaks R4); **name** (breaks R7); **show** (hidden by state, R5).

### App level

| Action | Today | Verdict |
|---|---|---|
| New, Open, Add to plate, Save, Samples | File menu, Ctrl+N/O/Shift+O/S | ok |
| Export 3MF | File menu, no command | merge → File → Export… (X1) |
| STEP of a solid | Model rail foot, no command | merge → Export… (X1) |
| STEP of an assembly | Prepare's assembly header | merge → Export… (X1) |
| Pose Export… (STEP, glTF, 3MF, STL, OBJ, pose sheet) | Pose panel, only with an assembly | merge, show → Export… (X1) |
| Split to print's export sheet | Model, Split to print | ok: its pieces are not on the plate |
| Calibrate… | File menu | move → Prepare: it adds test parts to the plate (D3) |
| Printers and filaments…, printer chip | File menu and top bar | ok as app level; the menu entry moves to a **Printers** item beside File (D3) |
| Settings profile save, rename, duplicate, delete, import, export | Settings drawer, commands | ok |
| Theme, settings level, rail labels, captions | the top bar's ⋯ menu, commands | ok |
| Tandem bridge (MCP link) | top bar | ok |
| Undo, Redo | Ctrl+Z and Ctrl+Shift+Z (Ctrl+Y) are one command each. Model reads the open part, and the rail buttons are that command. Pose, Prepare, Preview and G-code read the plate. The palette names the step when it is known. An open sketch keeps its own undo | ok (R6, I4). Place's own stack is gone (I5) |

### Model

| Action | Today | Verdict |
|---|---|---|
| New solid, Sketch, Push/Pull, Fillet, Chamfer, Shell, Draft, Split, Boolean, Pattern, Mirror, Hole, Pocket | rail, commands | ok |
| Pattern, Mirror, Shell, Draft | no key | ok: keys are optional (R3 holds) |
| Scale solid | X | key: Prepare's Scale is S; S is Sketch in Model (D2) |
| Place in model space | was Shift+P | ok: it is Pose's Move, M (D4, I5). Shift+P is free. Model keeps Workplane |
| Boolean with another object | Shift+G | ok: it changes this solid's shape |
| Workplane, Measure, Check, View (zebra, curvature, isoparms) | rail, commands | ok |
| Parameters, Plugins, Auto ribs, Stress | Features menu, commands | ok |
| Split to print, Print transition | Features menu | ok (R8): label the group "For printing"; Print transition needs a command |
| History, Undo, Redo | rail foot buttons, the same Ctrl+Z | ok (R6, I4): the buttons stay as views of the part's history |
| STEP | rail foot | merge → Export… (X1) |

### Pose

| Action | Today | Verdict |
|---|---|---|
| Select, Turn joint, Reach, Joint, Move | rail, V/R/G/J/M | ok: Move is design space (D4, I5) |
| Link | L; refuses a free parent | show: makes the assembly (X2) |
| Animations: play, stop, keep frame, save, keep in library | panel buttons, no commands | cmd |
| Export… | panel, only with an assembly | merge → Export… (X1) |
| Attach, Ungroup | in Prepare | move → Pose (X2) |
| Assembly view (assembled poses) | Pose's view | ok: Prepare's chip is gone (D5, I5) |

### Prepare

| Action | Today | Verdict |
|---|---|---|
| Move, Rotate, Scale, Pivot, Lay flat | rail, M/R/S/F | ok |
| Arrange, Duplicate, Remove | A, Ctrl+D, Del | ok |
| Paint supports, Paint seam, Reinforce, brush size | rail, B/K/N, [ ] | ok |
| Section | C | ok, and the same key in Preview and G-code |
| Strategy (Speed … By region) | Shift+1…5 | ok |
| Lay out one assembly | assembly header | ok: it moves the print layout |
| Attach, Ungroup, STEP | assembly header | ok: Attach and Ungroup are Pose's (X2). The view chip is gone (D5, I5). STEP merges (X1) |
| Height ranges, modifiers, per-part overrides | object list and drawer, no commands | cmd |

### Preview and G-code

| Action | Today | Verdict |
|---|---|---|
| Slice, Force re-slice, Cancel | Ctrl+Enter, Ctrl+Shift+Enter, Esc | ok |
| Export G-code, Send to printer | Ctrl+E, top bar | ok |
| 2D, split, 3D; layer up and down | V, arrows, PgUp/PgDn, Home/End | ok |
| Edit supports | E | ok |
| Colour by, features shown, bed opacity | flyouts, no commands | cmd |

### Keys across stages (R4)

| Idea | Prepare | Model | Pose | Verdict |
|---|---|---|---|---|
| Move | M (Move) | — | M (Move) | ok: same key, same idea (D4, I5). Shift+P is free |
| Rotate | R | — | R (Turn joint) | ok |
| Scale | S | X | — | key (D2) |
| Select | Esc clears | Esc clears | V | ok: Pose's V is a tool, the others have none |
| Measure | Shift+M | Shift+M | — | ok |
| Views T, Y, I | yes | yes | yes | ok |

### Words (R7)

| Idea | Window | MCP | Verdict |
|---|---|---|---|
| print-layout position | Move, Rotate (Prepare) | `object_place` | ok, and the guide says "Prepare's Move" |
| design-space position | Move (Pose) | `model_place` | ok: the window says Move, `model_place` kept (D4, I5) |
| join two parts | Attach (Prepare), Link (Pose) | `s.attach` in recipes, no MCP call | name: one word, **Link**, everywhere (X2 adds `assembly_link`) |
| export | six entries | `export_3mf`, `model_export_step`, `pose_export` | merge: **Export** and `export` (X1) |

## 4. Milestones

| Id | What | From |
|---|---|---|
| X1 | One Export: File → Export…, Ctrl+Shift+E, scope then format, free parts too | `plan-export-and-linking.md` |
| X2 | Link makes assemblies in Pose; Attach and Ungroup leave Prepare | `plan-export-and-linking.md` |
| I1 | Stage order: design then print (D1) | this plan |
| I2 | Every action a command (R3): animation controls, Print transition, height ranges, modifiers, overrides, preview flyouts; a test that every rail button and menu item has a command | this plan |
| I3 | Keys (R4): Scale (D2), Move in Pose (D4); the shortcut sheet grouped by stage | this plan |
| I4 | Undo (R6): Ctrl+Z routes to the stage's own history in Model and Pose, with a test per stage | this plan |
| I5 | Pose owns design space (D4, D5): Place moves to Pose as Move, the assembly view is Pose's view, Prepare shows only the print layout | this plan, after X2 |
| I6 | Calibrate in Prepare, a Printers menu (D3) | this plan |

X1 first, then X2. I2 and I3 can go in parallel with them; I5 waits for X2. Each one is its own PR into `main`, reviewed on the Claude side, with:
- its e2e specs in `test:smoke`, passing three times with `--repeat-each=3`;
- no test loosened: a spec whose clicks move keeps every assertion;
- screenshots in the owner's dark 1440×1000 view;
- README sentences, the MCP guide and the `/lime-slice` skill updated where they name a moved action.

A test guards the rules once I2 lands: `src/ui/commands.test.ts` checks that every rail tool and menu entry in the markup has a command (R3), and that a key used for one idea in two stages is the same key (R4, from a short table of shared ideas).

## 5. The checklist for a new feature

This is in `CLAUDE.md` ("Where a feature goes"), and every feature plan and PR answers it:

1. **Which stage's job is it?** Name the stage from section 1, or "app level". If it changes design space, it is Pose. If it changes the print layout, it is Prepare.
2. **Where is its one home?** A rail tool or a menu entry. Any other button opens that home.
3. **Its command:** id, label, group, and a key if it is used often. If a shared idea already has a key, use that key.
4. **When it cannot run:** it is shown disabled, with the reason in its tip.
5. **Its word:** the same in the label, the command, the MCP tool and the guide.
6. **Undo:** Ctrl+Z in its stage takes it back.

## 6. Decisions

The owner took every proposal on 2026-11-24: "Yes, all proposals".

1. **D1. Stage order:** Model 1, Pose 2, then a thin divider, then Prepare 3, Preview 4, G-code 5. The number keys move with the tabs (I1).
2. **D2. Scale's key:** Model's Scale solid moves from X to Shift+S. Inside a sketch Shift+S stays Slot, because sketch keys only work while a sketch is open (I3).
3. **D3. Calibrate and printers:** Calibrate becomes a Prepare rail button that adds test parts. Printers and filaments gets its own top-bar menu beside File (I6).
4. **D4. Place:** Model's "Place in model space" becomes Pose's Move (M), so design space has one owner. Model keeps Workplane (I5).
5. **D5. The assembly view:** Prepare's "Print layout | Assembly" chip goes, because Pose draws design space (I5).
