# Model: the reference

The long form of the README's [Model a part](../README.md#model-a-part) section: every tool, how it behaves, and its limits.


Model edits a STEP solid, or starts one from a primitive or a sketch. The desktop release includes the Open CASCADE libraries. A build without them still slices an unedited STEP file, and Model stays off. `.lime` version 4 stores the solid as Open CASCADE's binary brep, so a saved part opens in Model without rebuilding every face from scratch, and gzips its big binary records (meshes, solids, root STEPs) so a file is about a quarter of its version 3 size. The contract is [docs/step-modeler.md](step-modeler.md).

### Sketches and the constraint solver

Sketch on the bed, or on a flat face. Line, rectangle, and the Draw menu (circle, arc, polygon, slot, and the rest) live on the sketch card in the left dock, not on the rail. A rectangle is born with horizontal and vertical constraints.

The solver is in-house (`src/sketch/solve.ts`): Levenberg-Marquardt over the sketch's points, radii, and arc bulges. It is MIT. It is not PlaneGCS or FreeCAD. Constraints are coincident, horizontal, vertical, parallel, perpendicular, tangent, equal, concentric, midpoint, fixed, and the driving sizes distance, length, radius, diameter, and angle. A driving size can be an expression that names a parameter. Dragging a point solves the rest. The readout says when the sketch is fully defined, when a constraint conflicts, and when one repeats another. A size the other constraints cannot meet is refused and the old value stays.

### Extrude, revolve, loft, sweep, and holes

Those five are sketch operations. They are buttons on the sketch card, and keys while a sketch is being edited. There is no rail button for them.

- **Extrude** (E) takes the selected region, or the only outer region, and a signed distance. Join, cut, intersect, or a new object.
- **Revolve** (V) spins that region about the line, construction line, or projected edge under the pointer, or about the plane's U or V axis. The angle runs from a tenth of a degree to a full turn. A profile that crosses the axis is refused.
- **Loft** (Shift+L) blends two or more sections: regions of the open sketch, a pinned sketch, or a flat face. Ruled is a straight blend.
- **Sweep** (W) carries the profile along a path sketch.
- **Holes** (H) only on a sketch drawn on a face. Select points or circle centres and Apply drills one hole at each, with one radius, depth, through, and optional counterbore for the whole set. With no sketch open, H is still the single Hole tool.

Step-by-step examples, with the window at each click, are in [docs/tutorials](tutorials/README.md): three revolves, three lofts, and three sweeps.

The rail's other Model tools are still there: New solid (box, cylinder, sphere, ellipsoid, cone, torus, wedge, polygon, tube, gear, part), fillet, chamfer, shell, split, scale, boolean, pattern, mirror, and the Features menu (pocket, boss, texture, array, ribs, text, Parameters). Part is a hex nut, a socket-head cap screw, a hex-head screw or a washer, from the ISO row for M3 to M24, and also a spacer, a shaft, a collar, a heat-set boss, a plate, an L-bracket, or a GT2 pulley of 12 to 60 teeth with an approximate GT2 groove. The shank is plain. A modelled thread is not available yet. The V pulley waits on the ISO 4183 groove table, which is not in Lime Slice yet. A gear is an involute spur. The card says how it sits against the gear it meshes with, or the nearest gear it reaches: meshing, too close or too far (with the centre distance and the distance they mesh at), teeth crossing, a gear that cannot be built, or a module or pressure angle that does not match. `model_check` reports the same pairs. Measure and Check sit under Inspect. Workplane sits under Frame. Move in design space is Pose's Move (M), a free part included, snapping to the other parts. Undo, Redo, and STEP sit at the foot of the rail.

### Push/pull and edge drag

With no other tool open, hovering a face lights it and seats an arrow on the outward normal. Drag the arrow, or type a distance. The context bar offers Push/Pull, Hole, and Shell for that face. A plain drag moves the face and its neighbours (`moveFaces`): a box gets taller. Alt extrudes that face alone (`faceExtrude`).

Hover an edge and type a radius. Enter fillets that edge. The same gesture with the chamfer tool breaks the edge instead. The context bar is the short row by the pointer, not a second toolbar.

### Parameters, expressions, and History Edit

Parameters live under History in the left dock. Each row is a name and a value, or an expression in other parameters. Type that name into a size field: the field shows the number it evaluates to, with an ƒ mark, and keeps the expression. Change the parameter and Rebuild replays the steps that use it.

History lists every step. Edit step (the row, or Shift+E) reopens that step's panel, including a group of sketch holes. The tree is stored in the `.lime` project. A part an MCP recipe built shows "Built by a recipe" and that line stays read-only: changing the recipe's parameters and rebuilding from them is not in the window yet. Undo and redo walk the same tree.

### Section view

View, on the rail, opens section, colour by step, the bed, and the size readout. A section plane through the part's centre drops the side the normal points at. The cut is red. Offset slides the plane; Flip swaps the side. It changes the drawing only.

### Split to print

A part too large for the printer is cut into pieces that fit. Open it in Model, then **Features → Split to print…**. It is a card of its own, not a rail tool, and it works on the open solid. The card proposes cuts for the part and gives a sentence saying why.

- **Cuts.** Type where a cut goes, drag its plane (Ctrl snaps the number to whole millimetres and a tilt to 15°), or aim it at a face with the Face button, which cuts parallel to a picked flat face. X, Y, and Z cut square to that axis, and Tilt A and Tilt B turn the plane. **Add cut** puts one in the middle of the largest piece. **Fit the bed** proposes the cuts again so every piece fits (it reads **Fit the printer** when the target is a printer Lime Slice does not slice for), and **Clear cuts** starts over.
- **Print on.** The plate's printer comes first. The pieces then become plate objects, laid out on the bed around the objects already there, each with its number cut into a cut face (the Part numbers box turns that off, and **Lay out on the bed** turns the layout off). The library's other printers follow, with the **Formlabs Form 4** last. The Form 4 is export-only: the planner fits each piece upright in its 200 × 125 × 210 mm volume, and turns the part to fit when that gives fewer pieces (one tall cover is 4 pieces rather than 7). The pieces stay in Model, and Prepare says "Split for the Formlabs Form 4 in Model, N parts. The plate prints it whole."
- **Export…** writes the pieces: one STEP named for the source, one 3MF with every piece named, or one STL per piece. A dowelled cut adds `<source>-pins`. The button is on the card, and in the menu of the history row.
- **Connectors.** Tick Connectors on a cut, and choose **Dowel** (a hole in both pieces and a separate pin), **Plug** (a peg fused to one piece and a socket in the other), or **Hardware hole** (holes for a bought pin or magnet). Radius or Diameter, Depth, Count, Margin, and End gap are typed or left on Fit. **Clearance** is Snug, Loose, Press, or Typed. On a filament (FDM) printer, a hole whose axis lies within 45° of horizontal gets a teardrop top, so it does not sag. When fewer connectors fit than were asked for, the card says "N of M fit" and **Use N** takes the number that does. The pins stand upright as their own small object, with the layers along their length.
- **Explode.** The Explode box in View options spreads the pieces apart along the cuts, with their numbers, at the Gap you set (10 mm to start). It is a view and saves nothing.
- **Saving and undo.** The pieces and the pins are saved in the project, and a file saved by 3.8.0 gets its pieces back when it opens. A split is one undo step. Its history row is "Split to print, N parts", and the pencil on the row reopens the card with **Update** in place of Apply.
- **Shaped cuts.** A cut can be Straight, Lap, Zig-zag, Tongue, Dovetail, or follow a Sketch, and the connectors also offer Key and Dovetail. The plan is in [plan-split-connectors.md](plan-split-connectors.md).

### STEP in and STEP out

An unedited STEP is tessellated on load. With the bridge, Open CASCADE reads it. Without the bridge, the pure-Rust [truck](https://github.com/ricosjp/truck) kernel reads planes, cylinders, cones, spheres, tori, and NURBS, and converts file units to millimetres. Each instance of an assembly keeps its placement. A STEP that holds several solids asks first, with "This STEP file holds N solids.": **Open as N pieces** makes one plate object per solid, named from the file and placed as assembled, and each opens in Model as a solid of its own. **Open as one object** keeps the old behaviour, one mesh. On a STEP object already on the plate, **Separate into plate objects** splits it by its solids. The chord tolerance defaults to 0.05 mm (0.01–2 mm) via the Prepare field or `slice --step-tolerance`. Faceted brep and AP242 tessellated solids are rejected with an error.

Model mode opens that STEP as the root of the history tree. The STEP button at the foot of the rail writes the solid on screen as AP214, a manifold solid B-rep. The same write is the MCP tool `model_export_step`.

On a phone (`?layout=compact`, or a window 600 px wide or narrower) the Model rail is one strip along the top. History, Undo, Redo, and STEP sit at the end of that strip.

### Stress estimate

Model → Stress… (also in the command palette) estimates how a part takes a load, solved as it will be printed rather than as a solid block. Pick held faces or the bed, add a force or a pressure, and choose a material card and targets such as a minimum safety factor or a maximum deflection. Run slices the part and solves its real beads, grouped into cells of whole layers. Walls, infill, bead direction, and the bond between layers and between beads all count. The result is painted on the part's own faces, on a flat bed and on a belt alike, with a marker at each hot spot. The legend gives the ramp's two ends and the peak. The deformed shape is off until you tick it, then it states its scale (×N), and it stays on for the next run. With **Check at a finer cell (N mm)** on, the part is solved again at the cell over √2, and the result says what the two gave, for example "Max deflection 0.392 mm at 2 mm cells, 0.475 mm at 1.41 mm (18% apart)"; when the finer cell is too large to solve, it checks a coarser one and says so. When there is nothing to show, the panel says so instead of drawing noise: a part held on the bed and pressed into it bends nothing. One row per target gives the margin and the failure mode that governs it: along a bead, across beads, across layers, or shear. Each mode suggests a different change. A sweep tries walls, infill, or pattern variants, each one sliced and solved. Preview can colour the toolpaths by stress or by safety factor.

**A worked example.** On the Lime 220 with PLA, make a box of 100 × 10 × 10 mm and set its infill to 100 %. In Stress, choose Faces, pick one 10 × 10 end, then pick the other end as the load: 20 N, direction 0, 0, −1. Choose the PLA card, set Advanced → Cell size to 1.5 mm, and Run. The part turns red at the held end and blue at the free end. Beam theory gives σ = P L c / I = 20 · 100 · 5 / 833.3 = 12.0 MPa at the held end; the legend's peak reads 11.9 MPa. The free end drops 4.9 mm against 4.75 mm for a solid beam: the infill's beads cross the beam at ±45°, so the print is a little softer. `mcp/sim-paint.test.ts` checks these numbers on the real engine, and `e2e/stress-cantilever.spec.ts` checks the colours in the window. At the default 5 mm cells this bar is two cells deep, and the two cell sizes disagree too much to draw it.

Trust comes from the second solve: the target nearest its limit, or with no target the largest deflection, within 5 % is `converged`, within 15 % `usable`, and otherwise `rough`. The four material cards (PLA, PETG, ABS, TPU) are placeholders, not measured data, so for now every result is `rough`. A target is met when its value is inside its limit. The solver is `crates/lime-sim`, and `crates/lime-sim-bridge` links it to the slicer. The plans are in `docs/plan-stress-simulation.md` and `docs/plan-stress-sliced.md`.
