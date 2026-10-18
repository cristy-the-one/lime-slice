# Plan B: sketches, features, and push/pull in the app

Status: plan, for implementation by agents. Written 2026-10-18 against `main` at v2.8.1.
Companion: `docs/plan-gui-mcp-parity.md` (Plan A). This plan needs Plan A's A0 (shared `src/modeling/`) and A1 (group
ops). Read Plan A sections 2 and 3 first: they describe how a Model tool is put together in this app.

## 1. Goal

A person can make a solid the way CAD programs do:

- draw a 2D shape on a plane or on a face of the part;
- turn the shape into a solid by extruding, revolving, lofting or sweeping it;
- shape the solid further by pushing and pulling faces and edges directly on the part.

They should never need the transform gizmo on the right side of the view, and never need to type coordinates in a
panel unless they want an exact number.

The interaction model is direct manipulation, in the spirit of SketchUp's Push/Pull and Onshape's and Fusion's
in-canvas arrows and heads-up dimension input:

- **Hover shows what a click will do.** The face, edge or region under the pointer lights up, with a hint line.
- **Drag does it.** An arrow drawn on the thing itself, not a gizmo elsewhere, follows the pointer. A live preview
  and a live dimension label follow the drag.
- **Type to be exact.** While dragging or drawing, typing a number sets the dimension, Tab moves to the next one, and
  Enter commits. The input box sits at the pointer.
- **Every result is a history step,** previewed by the kernel's dry run, applied as one undo step, and editable later
  by reopening the same in-canvas interaction.

## 2. What exists to build on

- **Kernel ops** (`crates/lime-model-occt`): `extrude`, `revolve`, `loft` (circle, ellipse or profile sections),
  `shell`, `boolean`, `hole`, `fillet`, `chamfer`, `split`, `scale` and `join`. Profiles are one closed outline of
  `[u, v]` points, straight edges or splines (`smooth` plus `corners`). They have no holes and no true arcs.
- **The plane model**: `Workplane` (`origin`, `turn`; columns U, V, W) in `src/workplane.ts`, plus
  `workplaneOnFace`, `facePlane` (`src/model-plane.ts`) and `planePrimitive`. A profile's plane is exactly a
  workplane.
- **The view** (`src/model-view.ts`):
  - three.js with `OrbitControls`;
  - face and edge picking (`ModelPick`), highlight;
  - ghosts (`ModelGhost`) and the kernel preview mesh (`setPreview`);
  - drag handles (`DragHandle` kinds `axis`, `ring`, `surface`);
  - the workplane drawn in the view.
- **Probe and apply**: debounced probes, a preview mesh, `applyOp`, and history nodes. A step's edit reopens its
  panel (`src/model-edit.ts`).
- **Sweep layout** (`src/modeling/sweep.ts` after A0): sections along a smooth path, caps, frames without twist.
- **Not there yet**: no 2D drawing, no 2D geometry library, no snapping, no heads-up numeric input, no
  profiles with holes, no extrude "up to" or with draft, no way to start a solid from a sketch (a new solid is always
  a primitive), and no direct face move.

## 3. Architecture decisions

### D1. A sketch is the editing state of a feature, not a separate history node

Parametric CAD keeps sketches as their own features. This app's history is a tree of ops, each self-contained (an
extrude carries its plane and profile). Keep that:

- While drawing, a `Sketch` object lives in the client.
- On "Extrude" (or Revolve, Loft, Sweep), the chosen regions become the op's profile loops, and the sketch's
  entities are kept in the op as `sketch?: SketchData`. The kernel never reads that field; strip it before the
  engine call, as Plan A strips `exprs`.
- Editing that history step reopens the sketch editor with its entities, then the feature's drag. On Apply, it
  replaces the node and replays the chain (the existing edit machinery).
- One sketch can feed several features: "Extrude" leaves the sketch open (a pinned "Sketch 1" card) until the user
  closes it, and each feature stores its own copy of the entities it used. This needs no cross-node references,
  keeps the file format simple, and can be revisited later.

### D2. Profile v2 in the kernel: loops, true arcs, holes

A sketch has circles, arcs and shapes with holes (a washer, a window frame). Extend `ProfileSpec`
(`crates/lime-model-occt/cpp/kernel.h`) and the ops, keeping the old `profile` field working.

```jsonc
// on extrude, revolve, and each loft section, in place of `profile`
"loops": [
  { "segments": [                       // the first loop is the outer boundary; the rest are holes
      { "kind": "line",   "to": [u, v] },
      { "kind": "arc",    "through": [u, v], "to": [u, v] },   // three-point arc from the previous end
      { "kind": "spline", "through": [[u, v], ...], "to": [u, v] }
    ],
    "start": [u, v] },
  { "start": [...], "segments": [...] }
]
```

- **Kernel** (`kernel.cpp`):
  - edges come from `BRepBuilderAPI_MakeEdge`, using `GC_MakeArcOfCircle` for arcs and `GeomAPI_Interpolate` for
    splines (already used for `smooth`);
  - one wire per loop;
  - the face is `BRepBuilderAPI_MakeFace(outerWire)` with `Add(innerWire)` for each hole;
  - holes are oriented opposite to the outer loop (fix with `ShapeFix_Wire` / `ShapeFix_Face`).
- **Checks, refused in plain words**:
  - each loop is closed (end equals start within 1e-6 mm);
  - loops don't cross;
  - holes lie inside the outer loop;
  - an arc's three points aren't collinear.
- **Rust**: `Op::Extrude`, `Op::Revolve` and `LoftSection` gain `loops: Vec<Loop>` (skipped when empty). Exactly one
  of `profile` or `loops` must be given.
- **TypeScript**: `ExtrudeOp`, `RevolveOp` and `LoftSection` gain `loops?: Loop[]`. Update the readers and writers in
  `src/model-tree-file.ts` and the anchors' `opBox` (use the loops' points plus arc extremes).

### D3. Starting a solid from a sketch: a feature root

A new solid today is always a primitive root. A sketch drawn on the ground, with no solid yet, must extrude into a
new solid.

- `ModelRoot` gains `{ kind: "feature"; op: ExtrudeOp | RevolveOp | LoftOp }`.
- The kernel's `open` builds the op against nothing: in `combine_profile`, when there is no current shape, the result
  is the tool itself, after the same validity checks.
- New objects come from it the way `newSolidRequest` creates a primitive object (`src/app/model.ts`
  `createSolid`), placed with `newSolidPose`.
- Saved as `rootFeature` in `modelTree`, beside `rootPrimitive` and `rootStep` (`src/model-tree-file.ts`,
  `src/project.ts`).
- Edit: like editing a root primitive today (`editRoot`), the root feature's edit reopens its sketch.
- A sketch extruded with mode "New object" while a solid is open also makes a new object, through the same path.

### D4. Push/pull: two kernel ops

1. **`faceExtrude`**, which adds or removes a prism on a face:

   ```jsonc
   { "kind": "faceExtrude", "face": FacePick, "distance": mm, "draftDeg": 0, "upTo"?: FacePick }
   ```

   - The face is a planar face, or any face, for extrusion along its average normal.
   - `BRepPrimAPI_MakePrism(face, n * distance)`, then fuse when the distance is positive and cut when negative.
   - With `draftDeg`, use `BRepFeat_MakeDPrism`.
   - With `upTo`, use `BRepFeat_MakePrism` `Perform(untilFace)`.
   - The face is stored as a reference `{index, mid, areaMm2}`, matched on rebuild as shell's `openFaces` are.
2. **`moveFaces`**, a direct move where the neighbours follow:

   ```jsonc
   { "kind": "moveFaces", "faces": [{ "face": FacePick, "distance": mm }] }
   ```

   - `BRepOffset_MakeOffset` with `SetOffsetOnFace(face, distance)` for the moved faces and 0 for the rest
     (`BRepOffset_Skin`, `GeomAbs_Intersection`).
   - The adjacent faces extend or trim, so pulling the top of a box makes the box taller, and pulling a hole's wall
     makes the hole wider.
   - When OCCT can't do it (its offset algorithm refuses some topologies), refuse in a sentence and suggest
     `faceExtrude`: "This face cannot move with its neighbours here. Push or pull adds material instead: hold Alt."

- Both are probed like any op. The preview mesh shows the result live after a short pause. A client-side ghost (D6)
  shows it at once while dragging.
- History labels: "Pull face 5 mm", "Push face 3 mm", "Move 2 faces 1.5 mm".

### D5. Edge push/pull is fillet and chamfer, dragged on the edge

There are no new kernel ops for edges.

- Dragging an edge away from its solid sets a fillet radius.
- With Alt held, it sets a chamfer size.
- With several edges selected, they move together.

The fillet's largest size (`maxMm` from the probe) clamps the drag, with the readout saying why.

### D6. Interaction primitives (`src/interact/`), shared by sketches and push/pull

New modules, view-agnostic where possible, so each is unit-testable without WebGL:

- **`hud.ts` (heads-up input).** A floating DOM element at the pointer, showing one to three live dimensions ("12.5
  mm · 30°").
  - Typing digits (including `-`, `.` and expressions) edits the active dimension. Tab cycles dimensions. Enter
    commits and Esc cancels.
  - Expressions are evaluated with `src/modeling/expr.ts` against the project's parameters (Plan A, A6).
- **`snap.ts` (snapping).** Given a 2D point on a plane and context, it returns the snapped point and the snap kind,
  for a hint glyph. In priority order, within an 8 px screen tolerance:
  1. sketch points: endpoints, midpoints, centres, intersections;
  2. projected solid vertices and edge midpoints on the plane;
  3. on-curve, on sketch entities and projected solid edges;
  4. inference: horizontal or vertical with the last point, parallel or perpendicular to the last segment, along a
     projected edge;
  5. the grid, whose spacing follows zoom: 1, 2, 5 × 10ⁿ mm, so the grid never draws closer than 12 px.
- **`drag-axis.ts` (one-axis drags).** It maps a pointer ray to a distance along a 3D line: closest approach of the
  ray to the line, as `lineParam` in `src/model-drag.ts` does today, plus snapping of that distance to:
  - round numbers (Ctrl);
  - other faces' heights along the same axis ("to this face", with a dotted line to the face it aligns with);
  - the previous distance (double-click repeats it, as SketchUp does).
- **`in-place-arrow.ts`.** A single arrow drawn on the face or region at the pointer, along the normal, with no
  gizmo. It's a thin wrapper around the existing `DragHandle` rendering in `model-view.ts`, seated at the hover point.

### D7. Live preview cost

- **While the pointer moves**: only client-side ghosts.
  - A face prism: the face's triangles moved along the normal, plus side quads from its boundary loop.
  - A sketch region extrude: the region triangulated (earcut, already used, or a small ear-clipper) plus walls.
  - Revolve: a lathe of the region's outline with 48 steps.
  - Fillet: the existing `blend` ghost.
  - These are pure functions in `src/interact/ghosts.ts` with unit tests.
- **After 300 ms still** (`PROBE_WAIT_MS`): the kernel probe with preview, as today.
- **On release**: the probe if one isn't already pending. Apply on Enter, on a click away, or at once if
  "Apply on release" is on (a preference, default on for push/pull and off for sketches). Undo reverts it.

## 4. The sketch editor (`src/sketch/`)

### 4.1 Data model (`src/sketch/model.ts`)

```ts
type Pt = [number, number];                       // u, v in the sketch plane, millimetres
interface SketchData {
  plane: { origin: Vec3; turn: Vec3 };            // a workplane; part frame
  on?: { kind: "face"; face: FaceRef } | { kind: "plane"; name: "XY" | "XZ" | "YZ" } | { kind: "workplane" };
  points: { id: number; at: Pt; fixed?: true }[];
  entities: (
    | { id: number; kind: "line"; a: number; b: number; construction?: true }
    | { id: number; kind: "arc"; a: number; b: number; through: Pt; construction?: true }   // a → b through `through`
    | { id: number; kind: "circle"; centre: number; radius: number; construction?: true }
    | { id: number; kind: "spline"; through: number[]; construction?: true }
  )[];
  dims?: Dimension[];          // phase S4: driving dimensions and constraints
}
```

- Points are shared: entities refer to point ids, so a rectangle's corners are joined and dragging a corner moves two
  lines.
- Kept in the feature op as `sketch` (D1). Plain JSON, versioned with `"v": 1`.

### 4.2 Geometry library (`src/sketch/geom.ts`, `src/sketch/regions.ts`)

Pure TypeScript with exhaustive unit tests:

- **Primitives**: intersections (line/line, line/arc, arc/arc, line/circle, circle/circle), projection onto
  entities, arc from 3 points, tangent arc, and spline sampling (a centripetal Catmull-Rom matching
  `GeomAPI_Interpolate` closely enough to draw; the kernel draws the real one).
- **Regions**: the closed areas a sketch encloses, from its non-construction entities.
  1. Split entities at every intersection to get a planar graph.
  2. Trace the faces of the graph, using the smallest left turn at each vertex.
  3. Drop the unbounded face.
  4. Nest the faces by containment: a region's holes are the faces directly inside it. Hole regions are themselves
     selectable, as in Fusion: a washer gives two regions, the ring and the hole.
  5. A circle on its own is a closed loop with no vertices: handle it as a single-edge face.
- **Region to profile v2** (`toLoops(region)`): the outer loop and holes as D2 `loops`, arcs kept as arcs, the outer
  loop counter-clockwise and holes clockwise.
- **Edits**: trim (remove the segment between the nearest intersections either side of the click), extend, offset
  (lines and arcs exactly; splines by sampling), and a corner fillet (an arc tangent to two lines). Mirror, and
  linear and polar copy, of selected entities.

### 4.3 Entering and leaving

- **Start a sketch:**
  - the "Sketch" toolbar button (S): click a flat face, or one of three ghost origin planes shown at the part's
    origin, or the workplane;
  - or double-click a flat face;
  - or, on an empty plate, the "New solid" card gains a "Sketch on the bed" button.
- **On entering:**
  - the camera turns to look straight at the plane (animate 250 ms) and orbit is locked to a turn about the plane
    normal; middle-drag still pans and the wheel zooms;
  - "Look around" (O) unlocks the orbit;
  - the solid is drawn dimmed;
  - the face's outline and the solid's edges that cross the plane are projected as faint reference geometry, which
    snaps but isn't part of regions unless "Use" (U) converts them.
- The sketch plane draws its adaptive grid (D6).
- **Leaving**: "Finish sketch" (Esc twice, or the card's ✓) keeps the sketch pinned as a card until a feature uses it
  or it's discarded. A sketch with no feature isn't saved.

### 4.4 Drawing tools

Keyboard shortcuts in brackets. Every tool shows its hint line in the readout.

| Tool | Gesture | Heads-up fields |
|---|---|---|
| Line / polyline (L) | click, click, … double-click or Esc to end; click on the start point to close | length, angle |
| Rectangle (R) | corner, corner; Ctrl at the start: from the centre | width, height |
| Circle (C) | centre, radius point | diameter |
| Arc (A) | start, end, a point on the arc; or Shift: tangent arc from the last line's end | radius, sweep angle |
| Polygon (N) | centre, corner; the sides count in the HUD (default 6) | across corners/flats, sides |
| Slot (Shift+S) | first centre, second centre, width | length, width |
| Spline (B) | click through points; double-click ends; click on the start closes it | none |
| Trim (T) | click a segment to remove it | none |
| Offset (F) | pick a chain, drag | distance |
| Fillet corner (G) | click two lines near a corner | radius |
| Construction (X) | toggles the selected entities' construction flag | none |
| Use (U) | projects the picked solid edges or face outline into real sketch entities | none |

- **Select and move**: click selects an entity; box-select (left-to-right for enclosed, right-to-left for crossing);
  drag a point or an entity to move it; Delete removes.
- **Undo and redo inside the sketch**: Ctrl+Z / Ctrl+Y act on the sketch while it's open, separately from the
  Model history.
- **Rendering**: entities as three.js `Line2` (fat lines, `three/examples/jsm/lines`) on the plane, a 2 px offset
  toward the camera to avoid z-fighting, and points as screen-size dots. Regions are filled translucent on hover,
  and solid accent when selected.

### 4.5 Constraints and driving dimensions (phase S4, after the rest works)

- **Start without a solver**: inference snaps (D6) give horizontal and vertical lines, and the HUD gives exact sizes.
  That covers most printable parts.
- **Then add**:
  - geometric constraints: coincident (implied by shared points), horizontal, vertical, parallel, perpendicular,
    tangent, equal, concentric, fixed, midpoint;
  - driving dimensions: distance, length, radius/diameter, angle;
  - a solver that's either (a) a small Levenberg-Marquardt over point coordinates in `src/sketch/solve.ts`, which is
    enough for tens of entities, or (b) `@salusoft89/planegcs` (FreeCAD's PlaneGCS compiled to WASM, LGPL-2.1+).
    Prefer (a) to avoid a licence question; the app's licences are MIT plus the dynamically linked LGPL OCCT, and a
    statically bundled LGPL WASM needs a legal check first. Record the decision in `docs/`;
  - dimensions drawn as editable labels in the sketch: click to edit, expressions allowed, and they change colour
    when the sketch is fully defined.

## 5. Features from a sketch

All of them start from the open sketch's selected regions, or the single region under the pointer if none is
selected. All of them use one in-place arrow (D6), a HUD and the probe.

### 5.1 Extrude (E)

- Hovering a region shows an arrow at its centroid along the plane's normal. Drag sets the distance, and the region's
  extruded ghost follows.
- Live mode, inferred from the direction and shown in the HUD, overridable with the M key or the card:
  - **New object**: there's no solid, or the sketch isn't on or touching the solid.
  - **Join (fuse)**: pulled out of the solid.
  - **Cut**: pushed into it.
  - **Intersect (common)**: chosen in the card.
- HUD fields:
  - distance;
  - optional second-side distance (Tab adds it, which is symmetric when equal);
  - draft angle (Tab again).
- "Up to face": while dragging, hovering a face of the solid snaps to it (dotted line), and that sets `upTo`.
- **Op**:
  - `extrude` with `loops`, plane, depth, `symmetric`, and the new fields `depth2?`, `draftDeg?` and `upTo?`, all
    added to the kernel op;
  - several regions are several loops sets; if they are disjoint, emit a `GroupOp` (Plan A, A1) of one extrude per
    region;
  - "New object" uses the feature root (D3).
- **Kernel additions**: `depth2` (two-sided, unequal: a prism from -depth2 to depth), `draftDeg`
  (`BRepFeat_MakeDPrism`) and `upTo` (`BRepFeat_MakePrism::Perform(face)`).

### 5.2 Revolve (V)

- Pick the axis: a sketch line, a construction line, a projected solid edge, or one of the sketch plane's U and V
  axes (shown as dashed lines while choosing).
- A ring handle around the axis at the region's centroid; drag the angle. HUD: angle (360 by default; typing "360"
  snaps to it).
- Op: `revolve` with `loops`, `axisOrigin`/`axisDir` from the picked line in plane coordinates, and `angleDeg`. A
  region that crosses the axis is refused, as the kernel already does; draw the region red while hovering it.

### 5.3 Loft (Shift+L)

- Pick two or more regions in order, from different sketches (each pinned sketch card stays available) and/or flat
  faces of the solid. A face counts as a section: its outline loops, from the kernel via a new tree call
  `faceLoops {key, node, face}`, which returns D2 loops in the face's plane.
- An optional "ruled" toggle. The ghost is a coarse client loft: interpolate the sampled outlines with matched point
  counts.
- Op: `loft` with sections as `{origin, turn, loops}` (D2 makes loft sections accept `loops`).

### 5.4 Sweep (W)

- Pick a region (the profile) and a path: an open chain in another sketch, or a chain of solid edges (picked with
  Shift).
- Op, two options for the implementer:
  - (a) reuse `src/modeling/sweep.ts`: sample the path, place copies of the profile as loft sections. This works now,
    but a sharp corner needs fillets;
  - (b) add a kernel `sweep` op with `BRepOffsetAPI_MakePipeShell` along a real wire (lines, arcs and splines from
    the path sketch). This is exact and handles corners with `BRepBuilderAPI_RightCorner`.
  - Start with (a); add (b) as phase F3 if users sweep along sharp paths. Twist and scale per point follow the MCP
    `sweep` fields.

### 5.5 Hole from a sketch point

Points (or circle centres) in a sketch on a face can be turned into holes in one go: select the points, press H, and
the Hole panel opens with a "one hole per point" layout. The result is one `GroupOp` of hole steps; holes are allowed
in groups (Plan A D2).

## 6. Push/pull on the solid (no sketch needed)

### 6.1 The Push/Pull tool (P), which is also the default when nothing else is active

The aim is for the most common operations to need no tool at all.

- **Hover a face**: it lights up, with a small arrow at the hover point along the face normal. The readout says
  "Drag to push or pull · Alt: add material · double-click: repeat 5 mm".
- **Press on the face and drag**: a distance along the normal (`drag-axis`, D6).
  - Default: `moveFaces`, so the neighbours follow. A box gets taller. A boss on a plate gets taller. A hole's wall
    moved outward gets wider.
  - Alt: `faceExtrude`, which adds a new prism (out) or a pocket (in) on that face only. That's SketchUp's
    behaviour, and it's how you add a step onto a face.
  - Snap: other faces' levels along the normal (dotted line to the face it aligns with), round numbers with Ctrl, and
    the last distance.
  - Ghost: the client prism (D7) during the drag; the kernel preview after a pause.
- **Release**: Apply immediately (one undo step), then the readout shows "Pulled 5 mm · Tab to edit". Tab within 3
  seconds reopens the HUD on that step (an edit of the just-made node).
- **Several faces**: Shift-click to select faces first; dragging any of them moves all of them along their own
  normals by the same distance (`moveFaces` with several entries). Faces that aren't parallel move
  normal-by-normal, which is what users expect from an "offset faces" command.
- **Curved faces**: cylinders, cones and spheres move radially with `moveFaces` (offset), so dragging a fillet face
  changes its radius, and dragging a cylinder boss changes its diameter. The HUD shows the resulting diameter for
  cylindrical faces (the kernel's face description carries `radiusMm`).

### 6.2 Edges

- **Hover an edge**: it lights up, with a small knob on the edge's midpoint pointing into the angle between its two
  faces (the bisector of the outward normals, from the mesh, as `outwardFromMesh` in `src/model-blend.ts` does).
- **Drag the knob**: fillet radius. Alt: chamfer. Several selected edges: all of them.
- **Live**: the existing blend ghost, then the probe. `maxMm` clamps the drag, with the readout saying why.
- **Release**: apply, as for faces.

### 6.3 The context bar (replaces trips to the toolbar)

After a click (selection), a small floating bar appears near the selection, 24 px above the pointer, never covering
it. It fades after 3 s of no movement and comes back on hover. Its contents depend on the selection:

| Selection | Buttons |
|---|---|
| One flat face | Push/Pull · Sketch on face · Hole · Shell (open this face) · Pocket/Boss/Text… (Plan A features) |
| Several faces | Move faces · Shell (open these) · Pattern… |
| Curved face (cylinder) | Change diameter · Hole through axis · Use as axis |
| One or more edges | Fillet · Chamfer · Use as axis (revolve, polar pattern) |
| Nothing (empty space) | Sketch on bed · New primitive ▾ · Paste |

Each button runs the same code as its toolbar entry. Keyboard shortcuts are shown in the button tooltips, which
teaches them.

### 6.4 Not the gizmo

The transform gizmo on the right side of the view stays for Place (moving whole objects) and Workplane. None of the
sketch, feature or push/pull interactions use it. They all use the in-place arrow, the knob or the ring, drawn on the
geometry being changed.

## 7. Editing features later

- **History row → Edit**:
  - an extrude, revolve, loft or sweep with a `sketch` field reopens the sketch editor (D1) with its entities, then
    the feature's drag, prefilled; Apply replaces the node and replays the chain;
  - `faceExtrude` and `moveFaces` reopen the push/pull HUD on the referenced face (matched by its stored reference);
  - fillet and chamfer reopen the edge drag.
- Remove extrude, revolve, loft and shell from `editRefusal` (`src/model-edit.ts`) as each gains its editor.
- Ops without a stored `sketch` (made by the MCP, or by older files) open the sketch editor with entities rebuilt
  from their `loops`/`profile`: a polyline with arcs. They stay fully editable, just without the original
  construction lines.

## 8. Work packages

The same rules as Plan A section 4: one PR each, a version bump, unit tests, Playwright where there's UI, docs in
`docs/step-modeler.md`, and plain-sentence refusals.

### Foundations

- **K1. Kernel: profile v2 (loops, arcs, holes)** (D2).
  - Files: `kernel.cpp`/`kernel.h`, `tree.cpp`, `tree.rs`; `src/model-tree.ts`, `src/model-tree-file.ts`,
    `src/model-request.ts`; MCP schema (`loops` on extrude, revolve and loft sections).
  - Tests:
    - a washer (circle with a circular hole) extruded 5 mm → π(R²−r²)·5;
    - a rounded rectangle with four arcs → the exact area;
    - refusals for open loops, crossing loops and a hole outside.
- **K2. Kernel: feature root** (D3).
  - Files: tree `open`, `src/model-tree.ts` (`ModelRoot`), `src/model-tree-file.ts` (`rootFeature`),
    `src/project.ts`, and `src/app/model.ts` `createSolid` path.
  - Tests: open with an extrude root → volume; save and reopen; edit the root.
- **K3. Kernel: extrude `depth2`, `draftDeg` and `upTo`** (5.1).
  - Tests: draft 5° on a 10 mm square extruded 10 → the frustum volume; up to a slanted face → volume against a hand
    computation.
- **K4. Kernel: `faceExtrude` and `moveFaces`** (D4), plus a tree call `faceLoops`.
  - Tests:
    - pull a box's top face 5 → the box is taller (volume);
    - `moveFaces` on a hole wall widens it;
    - `faceExtrude` out on a side face adds a prism;
    - a refusal case has its sentence;
    - replay matches the face by reference after an earlier step renumbers faces.
- **I1. Interaction primitives** (D6, D7), in `src/interact/`: `hud.ts`, `snap.ts`, `drag-axis.ts`,
  `in-place-arrow.ts` and `ghosts.ts`, with unit tests for snapping order, drag mapping and ghost meshes. No feature
  uses them yet; add a dev-only demo hook if useful.

### Push/pull (can ship before sketches)

- **P1. Face push/pull** (6.1), on K4 and I1.
  - Playwright:
    - drag a box's top face up 10 (simulated pointer) → history "Pull face 10 mm" → height 30;
    - Alt-drag a side face → a prism;
    - Tab edit → 12.
- **P2. Edge drag to fillet or chamfer** (6.2), on I1 only (kernel ops exist).
- **P3. Context bar** (6.3), after P1 and P2. It extends as Plan A features and Plan B sketch tools land.

### Sketches

- **S1. Sketch model and geometry** (4.1, 4.2): pure TypeScript, no UI. This is the largest test suite: regions,
  nesting, toLoops, trim and offset.
- **S2. Sketch editor shell** (4.3): enter and leave, camera, plane grid, reference projection, entity rendering,
  selection, in-sketch undo. Tools: Line and Rectangle only.
- **S3. Drawing tools** (4.4): Circle, Arc, Polygon, Slot, Spline, Trim, Offset, Fillet corner, Construction, Use.
- **S4. Constraints and dimensions** (4.5), optional for the first release.

### Features

- **F1. Extrude from sketch** (5.1), on K1, K2, K3, I1 and S2. Playwright: sketch a rectangle on the bed, extrude 20
  → a new object; sketch a circle on its top, push it in 5 → a cut.
- **F2. Revolve from sketch** (5.2).
- **F3. Loft and Sweep from sketches** (5.3, 5.4), on K1 loft sections with loops; option (b) for sweep if needed.
- **F4. Holes from sketch points** (5.5), on Plan A A1.
- **E1. Editing** (7): reopen sketch and feature editors from history. It lands with F1 for extrude and extends with
  each feature.

## 9. Order and parallel work

```text
Plan A: A0, A1 ─────────────────────────────┐
K1 ─┬─────────────── F1 ── F2 ── F3          │
K2 ─┤                 │                      │
K3 ─┘                 E1                     │
K4 ── P1 ── P3                               │
I1 ─┬─ P1, P2                                │
    └─ S2 ── S3 ── S4                        │
S1 ──── S2                                   │
F4 (needs A1) ───────────────────────────────┘
```

- Wave 1, in parallel: K1, K2, K3 and K4 (kernel, disjoint functions in `kernel.cpp`; one agent per op, rebasing
  before the PR because they share `tree.rs`'s `Op` enum), I1 and S1.
- Wave 2: P1 and P2 (push/pull ships first, the quickest visible win), then S2.
- Wave 3: F1 plus E1, P3, S3.
- Wave 4: F2, F3, F4, S4.

## 10. Quality bar

- **Every interaction works with mouse only and with keyboard:** HUD input, Tab, Enter and Esc. Every tool has a
  readout hint line.
- **Performance:**
  - a ghost redraws within one frame while dragging (target 60 fps on the 3,000-face test parts in
    `e2e/model-speed.spec.ts`);
  - the kernel preview arrives 300 ms after the pointer stops;
  - no probe while the pointer moves.
- **Accessibility:** the HUD is an `aria-live` region; context-bar buttons are focusable with labels;
  `data-*` attributes on the canvas expose sketch state for tests, as existing Model tests use `data-solid`,
  `data-context`, and so on.
- **File format:** every new field is optional, older files open unchanged, and an older app opening a newer file
  shows the steps it can't build as broken with a sentence, not a crash. That's the existing broken-node path.
- **The MCP gets the kernel features too:** K1 (`loops`), K3 (draft, two-sided, up to) and K4 (`faceExtrude`,
  `moveFaces`) are added to the MCP op schema in the same PRs, with `ops` guide examples, so Claude can model the
  same way people can.
