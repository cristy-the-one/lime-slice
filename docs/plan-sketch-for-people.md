# Plan: sketch tools a person can use without the manual

Status: plan, for review. Written 2026-11-02 against `main` at v4.9.0 (`a3548da2`). Nothing here is built yet.
Companions: `docs/plan-gui-cad-modeling.md` (the sketch editor and features, sections 4 and 5) and
`docs/step-modeler.md` (Sketch, as built). It runs beside the recipe plans (`docs/plan-recipes.md`,
`docs/plan-recipe-plugins.md`, `docs/plan-recipe-ingredients.md`); section 7a says where they meet. The small sweep wording fix on `claude/sweep-refusal-wording` is the
first example of section 3's rule and is not repeated here.

The owner, on 2026-11-02, after trying the sketch card: "no idea how to use these. i did not manage, so far, to
do more that 'extrude' and 'revolve' ... rest? no idea", and on Sweep: "these ops are MCP friendly only." Asked
for: an easier, more human way to do each operation, without breaking the MCP tools.

## 1. Goal

A person who has used any CAD or drawing app can, with no tutorial open:

- tell what each button on the sketch card is **for**, not only which clicks it takes;
- see **why** a Make button is greyed out, in words about their drawing ("these two ends don't meet"), and
  fix it from there;
- do Loft, Sweep, Holes, Trim, Offset, Fillet corner, Construction, Use and Constrain on the first try,
  starting from the drawing they would naturally make;
- never meet a refusal that says what is wrong without saying what to do next.

### Non-goals

- **No change to the MCP.** Tool names, schemas, op kinds, replies and `lime://guide/*` stay as they are.
  Every new UI path produces an op the MCP can already make (`extrude`, `revolve`, `loft`, `hole`, …), with
  the same fields. `mcp/schema.test.ts`'s budget does not move.
- **No change to saved files.** A `.lime` saved before this opens and rebuilds byte for byte the same. New
  drawing aids live in the sketch's `drawing` copy only where an existing field already holds them.
- No new kernel ops. A pipe along a real wire (`BRepOffsetAPI_MakePipeShell`) stays the follow-up in
  `plan-gui-cad-modeling.md` §5.4 (b).
- No video, no external help site, no network. Help is in the app and in the repo.
- No new rail buttons. The sketch card stays the one place, as `step-modeler.md` decided for 1440 px.

### Words used here

| Word | Meaning |
|---|---|
| shape | What the UI says instead of "region": an area closed by lines, that Extrude, Revolve and Loft can use. The code keeps `Region`. |
| route | What the UI says instead of "path" where it helps: the open line a sweep follows. |
| reason | The sentence on a greyed button, in the status line and under the size box. |
| demo | A small ready-made sketch the How popover opens, showing the tool working (section 4). |

## 2. Where things stand

What a person meets today (desktop, Model, sketch open):

| Tool | What works | Where people stall |
|---|---|---|
| Card layout | Draw icons, Edit row, Make row, `?` How popover with steps (`src/sketch/hints.ts`) | Edit and Make buttons are words with no idea of what they are for. The How steps say which clicks, not why. |
| Extrude, Revolve | Used successfully by the owner | Greyed with "Select a region to extrude." when the lines don't close; nothing shows **where** they fail to close. |
| Trim | Removes the piece between crossings | Nothing shows which pieces exist until hover; no hint that this is how you "close" a drawing. |
| Offset | Copies a chain at a distance | Only one side; making a wall from one line takes Offset, two lines to close the ends, then Extrude. |
| Fillet corner | Two lines that meet, then a radius | You must click both lines; clicking the corner itself does nothing. |
| Construction | Toggles a line to a helper line | The name says nothing about why you'd want it (revolve axes, symmetry lines). |
| Use | Copies a reference edge into the sketch | "Use" is not a verb people connect with "copy the edge of my part". The faint edges are easy to miss. |
| Constrain | A menu of 15 rules and dimensions | You must know the rule names first. Nothing is inferred while drawing, apart from the rectangle's sides. |
| Loft | Two or more sections on different planes | Needs a second sketch on an offset plane, set up by hand. Nothing says so until the refusal "its sections lie in one plane". |
| Sweep | Profile in one sketch, path in another, profile plane square to the path start | Drawing both in one sketch (the natural first try) is refused. Sharp corners are refused. |
| Holes | Points or circles in a face sketch, then H | Greyed unless the sketch is on a face; no reason says so. |

The reasons on greyed buttons come from `featureBlocked()` in `src/app/sketch.ts`. Refusals come from the
builders in `src/sketch/*.ts` (for example `SHARP_CORNER` and the along-path refusal in `src/sketch/sweep.ts`,
`CROSS_REFUSAL` for revolve).

### B0. Broken today: Draw-menu tools draw blind

Reported by the owner on 2026-11-02: with **Circle**, nothing is drawn until the second click, and the diameter
can't be typed (no size box in the viewport), unlike Line and Rectangle. `step-modeler.md` promises both ("The
box shows the diameter").

The tool layer has them: `drawHud` returns the Diameter field (`src/sketch/tools.ts:179`), and the ghost samples
exist (`src/sketch/tools.ts:338`). The gap is in how `src/app/sketch.ts` shows a Draw-menu tool's ghost and size
box. Arc, Polygon and Slot go through the same Draw-menu path and must be checked too.

**Done when**, for each of Circle, Arc, Polygon, Slot and Spline:
- the ghost follows the pointer after the first click;
- the size box opens at the pointer with the tool's fields (Circle: diameter);
- typing a size and pressing Enter commits it.

An e2e spec per tool checks this in `test:smoke`. This is milestone 0, before anything else in this plan.

## 3. Rules every tool follows

These apply to every item in sections 4 to 6, and to anything added to the sketch card later.

- **R1. Every reason says the next action.** A refusal or a greyed button names what is missing **in the
  person's drawing** and the click or key that fixes it. "Select a region to extrude." becomes "Your lines
  don't close a shape yet. The two red ends need to meet: drag one onto the other, or press T and trim the
  overhang." Every sentence is checked by a unit test, as the sweep wording is.
- **R2. Show, don't only say.** Where a reason is about geometry, the viewport marks it: open ends as red
  dots, a crossing as a red cross, the profile plane as a faint square, the start of a route as an arrow.
- **R3. Accept the natural drawing.** If a person's drawing is unambiguous, the tool works out the rest
  (Sweep in one sketch, Loft from one shape, Fillet on a corner point) instead of refusing. The stored op is
  the same op the strict path makes.
- **R4. Say what it is for.** Every Edit and Make button has a one-line purpose on hover, before the key:
  "Construction: helper lines for axes and symmetry, not part of the shape (X)".
- **R5. One example per tool.** The How popover's first line is a **Show me** button that opens that tool's
  demo (section 4) in a new sketch, which Discard throws away.
- **R6. MCP untouched.** Each item ends by naming the op it stores. The schema, tool list and `mcp/` tests
  are not touched by any milestone.

## 4. Discoverability on the card

### P1. Purpose tooltips

Every Edit and Make button gets `dataset.tipIdle` with a purpose line (R4), shown on hover and read by screen
readers; the existing reason replaces it while the button is greyed. The status-bar title in `STATUS_HINTS`
keeps the click line it has today.

| Button | Purpose line |
|---|---|
| Select | Pick and drag lines and points. Drag across empty space to pick several. |
| Trim | Cut away the part of a line between crossings, to clean up a drawing. |
| Offset | Copy a line or outline at a distance, for walls and borders. |
| Constrain | Lock how lines relate (level, square, same length) and set exact sizes. |
| Construction | Helper lines for axes and symmetry. They snap but aren't part of the shape. |
| Fillet corner | Round off a corner where two lines meet. |
| Use | Copy an edge of your part into the sketch, to draw from it. |
| Extrude | Push a shape into a solid, or cut it into the part. |
| Revolve | Spin a shape around a line, like a lathe: cups, knobs, wheels. |
| Loft | Blend between shapes at different heights: square to round, a bottle neck. |
| Sweep | Carry a shape along a route: pipes, handles, cable guides. |
| Holes | Drill a hole at each point or circle you drew on a face. |

**Done when** every Edit and Make button has a purpose tip, a unit test lists them against the card's
buttons so a new button can't ship without one, and the Make tips read the same greyed or not, apart from the
reason line.

### P2. Show me demos

Each Make tool and the less obvious Edit tools (Trim, Offset, Fillet corner, Construction, Use) get a demo:
a small sketch as JSON in `src/sketch/demos/` (the same `SketchData` the editor saves), opened by **Show me**
in the How popover on the plane the person is on. The demo is ready for the tool's next click: Trim opens on a
cross with an overhang, and the status line says "Click the red piece."

The tutorials' sketches (`docs/tutorials/`) are the starting set: Revolve's cup, Loft's duct, Sweep's bent
pipe. The demo sketch is never saved unless the person keeps it.

**Done when** each listed tool's Show me opens a sketch on which that tool's next click succeeds, checked by
an e2e spec per tool in `test:smoke`.

### P3. Reasons in the person's words

`featureBlocked()` and every builder refusal in `src/sketch/` are rewritten to R1, with a viewport mark (R2)
where the reason is geometric:

| Today | Becomes | Mark |
|---|---|---|
| Select a region to extrude. | Your lines don't close a shape yet. The red ends need to meet: drag one onto the other, or trim the overhang (T). | red dots on open ends |
| Select a region to revolve. | Click the shape to spin, then the line to spin it around. | — |
| The profile crosses the revolve axis. Keep it on one side. | The shape crosses the axis. Pick a line beside the shape, or move the shape off it. | red where it crosses |
| Pick at least two sections to loft. | A loft needs a second shape at another height. Press "Add a shape above" (L2), or click another sketch. | — |
| The loft has no volume: its sections lie in one plane. | Both shapes are on the same plane. Put the second one higher: "Add a shape above". | — |
| This path has a sharp corner. … | The route turns sharply here. Round it (radius on the card), or draw the bend as an arc. | red dot at the corner |
| (Holes greyed, no reason) | Holes go into a face. Start the sketch on a face of the part, then draw points where the holes go. | — |

**Done when** every reason string in `src/sketch/` and `featureBlocked()` passes a unit test that it ends with
an action, and an open-ends sketch shows its red dots in an e2e screenshot.

## 5. Make operations, done the natural way

### E1. Extrude: close the shape for me

When Extrude is greyed only because a chain's two ends are within 1 mm, the card offers **Close the gap**.
It adds the joining line (or moves the end onto the other) as one sketch undo step, and Extrude lights up.

Stores: the same `extrude` op. **Done when** a near-closed L-shape extrudes after one click on Close the gap.

### V1. Revolve: say what the axis is

When Revolve opens, the card lists the axis candidates in words ("Spin around: this line · the vertical axis ·
the horizontal axis") as buttons, next to today's hover picking. A construction line drawn earlier is listed
first, named "your helper line".

Stores: the same `revolve` op. **Done when** a revolve can be made with no hover, by clicking a listed axis.

### L1. Loft: Add a shape above

With one closed shape in the open sketch, Loft offers **Add a shape above**. A field, "Height", defaults
to 20 mm. It opens a new sketch on the plane offset by that height along the sketch normal (what the card's
Offset does today by hand), with a copy of the first shape, so the person only edits it: scale it, swap it for
a circle, move it. Finish returns to the loft with both sections picked.

Stores: the same `loft` op with two sketches in `drawing.sketches`. **Done when** square-to-round takes
Loft, Add a shape above, draw a circle, Apply, without touching an origin plane or the Offset field.

### S1. Sweep in one sketch

If the open sketch has exactly one closed shape and one open chain on the same plane, Sweep accepts both
(R3). It takes the chain end nearer the shape as the start, copies the shape, centres it there and turns it to
face along the route. The preview shows the copy standing up, and a card toggle reads "Profile: stood up
at the start / as drawn". "As drawn" brings today's refusal back, with today's wording.

Stores: the same sweep (`loft` with `drawing.sweep`). The stood-up profile is stored as a sketch on its own
plane in `drawing.sweep.profile`, as a two-sketch sweep stores it today, so History Edit reopens it.
**Done when** the owner's screenshot (a circle and a curve on one face) sweeps with W then Apply, and every
existing two-sketch sweep in the tests builds exactly as before.

### S2. Pipe mode

With an open route and no closed shape, Sweep opens as **Pipe** with Diameter (and an optional Wall for a
hollow tube). The circle is generated at the start, facing the route.

Stores: the same sweep, with a circle profile (and a second circle as a hole for Wall). **Done when** the
tutorial's bent pipe takes: line, tangent arc, W, type 8, Apply.

### S3. Round sharp corners for me

A route with a corner over 25° is no longer only refused: the card shows **Round corners** with a radius
already filled in (the smallest the profile fits, at least the profile's radius), and the preview shows the
rounded route. The person's sketch is untouched until Apply, which applies the fillet as one undo step with the
sweep.

Stores: the sketch gains the fillet arcs (as Fillet corner would add them), and the sweep is today's.
**Done when** an L-shaped route sweeps in one Apply.

### H1. Holes from anywhere

On a sketch that isn't on a face, Holes stays greyed with P3's reason, plus a button **Start on a face** that
closes this sketch (keeping it) and arms face picking. On a face sketch with nothing selected, H asks
"Drill at every point and circle centre in this sketch?" and does so on Yes.

Stores: the same hole group. **Done when** H on a face sketch with three circles, nothing selected, drills
three holes after one Yes.

## 6. Edit tools, done the natural way

### T1. Trim shows its pieces

When Trim is active, each trimmable piece is drawn slightly separated at its ends, and the one under the
pointer turns red before the click. A piece with no crossing says "Nothing crosses this line. Delete removes
it."

### O1. Offset makes walls

Offset gets **Both sides** and **Close the ends**. A single open line offset both sides with closed ends
becomes a slot-like wall shape, ready to extrude. The original can be kept as construction (a checkbox,
on by default when Close the ends is on).

### F1. Fillet the corner I click

Fillet corner accepts a click on the corner point itself, and a box selection of several corners for one
radius. Two lines that meet are still accepted as today.

### C1. Construction, named for what it does

The button reads **Helper line** in the UI (the key stays X, the field stays `construction`). Drawing a line
with Shift+X held draws it as a helper line from the start. Revolve's axis list (V1) shows helper lines first.

### U1. Use, named for what it does

The button reads **Copy edge** (key U). When it's active, reference edges brighten under the pointer, and a
click on a face's inside copies its whole outline, as clicking the outline does today.

### K1. Constraints while drawing

While a line is drawn, the app shows the rule it would infer (a small H or V near horizontal and vertical, ⊥
square to the line before, = the same length as the line before, a dot on a reference edge), and keeps it on
the click. Ctrl while clicking skips the inference. The Constrain menu stays for everything else, and the
rules it shows are the ones that fit what is selected.

All of T1–K1 store the same sketch data (`SketchData`) as today. The rename keeps ids, keys and saved fields.
**Done when** each has a unit test for its behaviour, and the saved sketch round-trips unchanged for the
paths that existed before.

## 7. MCP safety

- No file under `mcp/` changes in any milestone. CI's MCP jobs and `mcp/schema.test.ts` run unchanged.
- Each new UI path has a unit test that the op it stores equals the op the strict path stores for the same
  geometry. For example, S1's sweep equals the two-sketch sweep with the profile drawn stood up by hand.
- The renames (C1, U1) are labels only. `data-sketch-tool` values, command ids in `src/ui/commands.ts` and
  saved field names stay.

## 7a. Fits with the other plans

This plan is the app side of modelling; the recipe plans are the agent side. They share no files and no data
formats, and this section keeps them from drifting apart.

| Here | There | Rule |
|---|---|---|
| U1 Copy edge copies a face's whole outline into the sketch (TypeScript, from the plate mesh and B-rep edges the card already has) | Ingredients I5 `face_outline` and I7 plane frames read the same outline from the kernel for recipes | Both mean the same boundary in the same plane frame. When I5 lands, a test compares Copy edge on a fixture face with `face_outline` (same loops within 0.05 mm). Copy edge may later call it; it doesn't have to. |
| O1 Offset makes walls (Both sides, Close the ends) in `src/sketch/` | Ingredients I1 `geom2d::offset` and `round_corners` in `lime-recipe` (Rust) | Two implementations in two runtimes. They agree on corners: an outside corner is rounded with the offset distance, an inside corner stays sharp, and a corner whose edges are too short is reduced, not refused. Each side's tests include the same three fixtures. |
| S1 Sweep in one sketch, S2 Pipe mode, S3 rounded corners | Recipes call `sweep` with the same fields | No new op and no new field (section 7). A recipe and the card build the same sweep for the same geometry. A real pipe along a wire stays the follow-up in `plan-gui-cad-modeling.md` §5.4 (b), in neither plan. |
| P1 purpose tips, P2 Show me demos, the card layout | Plugins D13, the Plugins panel in the Model tab (plugin milestone 7), and "Save as plugin…" on a History row | No new rail buttons in either plan. The Plugins panel is designed after milestones 1 and 5 here land, so it follows the card's tip and demo style and fits the 1440 px layout. |
| P3 reasons in the person's words, red marks where the problem is | Ingredients I8 (selectors say which face they picked) and the recipe refusals | The same rule on both sides: a reason names the next action and points at the place. A recipe refusal names the face; a card reason marks it in the viewport. |
| Saved sketches unchanged (section 1) | Recipes saved in the `.lime` (`mcpModel.rustRecipes`, #527), plugin stamps (plugin D8) | Neither plan rewrites the other's part of the project file. |

**Order.** Milestones here run in their own lane, beside the recipe lanes (host fixes, `geom2d`, kernel reads),
which touch `mcp/`, `crates/lime-recipe` and the kernel only. Milestone 6 here (O1, U1) lands after ingredients
I1 and I5 if they are ready, so the shared fixtures can be checked; it doesn't wait for them otherwise.

## 8. Risks

- **Guessing wrong (R3).** Sweep in one sketch could pick the wrong end of the route. Mitigation: the arrow
  and the stood-up preview show the choice before Apply, and the toggle restores "as drawn".
- **Inferred constraints surprise people.** Mitigation: they show while drawing, Ctrl skips them, and undo
  removes the line with its constraints in one step.
- **Card height.** Purpose tips add no height, and the new buttons appear only in the mode they belong to.
  Check at 1440 × 900 for each milestone.

## 9. Questions for the owner

- **Q1. Renames.** "Helper line" for Construction and "Copy edge" for Use (C1, U1), or keep the CAD names and
  rely on the purpose tips? The plan's choice: rename, since the tips can't fix a label people skip.
- **Q2. Inferred constraints (K1).** On by default (Fusion, Onshape), or a setting that starts off? The plan's
  choice: on, with Ctrl to skip.
- **Q3. Demos (P2).** Ship all eleven in the first milestone, or Make tools first? The plan's choice: Make
  tools first, with the milestone that changes each Edit tool bringing its demo.

## 10. Milestones

Each is one PR to `main`, smallest useful first, and each updates `docs/step-modeler.md` and the matching
tutorial.

0. **B0**: Draw-menu tools show their ghost and size box while drawing (a bug fix, not a feature).
1. **P1 + P3**: purpose tips and every reason rewritten, with red marks for open ends and sharp corners.
2. **S1 + S2**: Sweep in one sketch and Pipe mode, the owner's blocked case.
3. **L1 + E1**: Add a shape above, and Close the gap.
4. **S3 + H1 + V1**: rounded corners, Holes from anywhere, axis buttons.
5. **P2**: Show me demos for the Make tools.
6. **T1 + O1 + F1 + C1 + U1**: Edit tools, each with its demo.
7. **K1**: constraints while drawing.

## 11. Done for the whole plan

- A person with no tutorial makes, on the first try: a square-to-round loft, a pipe along a bent route, a
  cup by revolve, four holes in a face, and a 2 mm wall from one line. An e2e spec drives each one with the
  clicks a person would make.
- No reason in `src/sketch/` or `featureBlocked()` lacks a next action.
- `git diff main -- mcp/` is empty across all milestones, and every `.lime` in the test fixtures rebuilds
  unchanged.
