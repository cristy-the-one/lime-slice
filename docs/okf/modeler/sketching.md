---
type: Feature
title: Sketching and features
description: Sketches, constraints, and history ops live in the app and in the Open CASCADE bridge, which the shell loads only when it is built.
tags: [modeler, sketch, features]
status: draft
generated: { by: claude/opus, at: 2026-11-20T12:00:00Z }
sources:
  - id: sketch
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/sketch/model.ts
    title: src/sketch/model.ts
  - id: solve
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/sketch/solve.ts
    title: src/sketch/solve.ts
  - id: tree
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/model-tree.ts
    title: src/model-tree.ts
  - id: primitive
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/model-primitive.ts
    title: src/model-primitive.ts
  - id: workplane
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/workplane.ts
    title: src/workplane.ts
  - id: pull
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/push-pull.ts
    title: src/push-pull.ts
  - id: features
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/model-features.ts
    title: src/model-features.ts
  - id: drag
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/model-drag.ts
    title: src/model-drag.ts
  - id: readme
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md
    title: README.md
  - id: draft
    resource: https://github.com/cristy-the-one/lime-slice/blob/03b1c1d6fcdd995bf5b67cf9b65f5ecabfe1a289/src/model-tree.ts
    title: src/model-tree.ts (03b1c1d6)
  - id: draft-kernel
    resource: https://github.com/cristy-the-one/lime-slice/blob/03b1c1d6fcdd995bf5b67cf9b65f5ecabfe1a289/crates/lime-model-occt/cpp/kernel.cpp
    title: crates/lime-model-occt/cpp/kernel.cpp (03b1c1d6)
  - id: organic-ops
    resource: https://github.com/cristy-the-one/lime-slice/blob/main/crates/lime-model-occt/src/tree/ops.rs
    title: crates/lime-model-occt/src/tree/ops.rs (feature/organic-surfaces)
  - id: organic-plan
    resource: https://github.com/cristy-the-one/lime-slice/blob/main/docs/plan-organic-surfaces.md
    title: docs/plan-organic-surfaces.md (feature/organic-surfaces)
  - id: organic-file
    resource: https://github.com/cristy-the-one/lime-slice/blob/main/src/model-tree-file.ts
    title: src/model-tree-file.ts (feature/organic-surfaces)
  - id: s6-ops
    resource: https://github.com/cristy-the-one/lime-slice/blob/main/crates/lime-model-occt/src/tree/ops.rs
    title: crates/lime-model-occt/src/tree/ops.rs (organic-surfaces/s6-nurbs-surface)
  - id: s6-tool
    resource: https://github.com/cristy-the-one/lime-slice/blob/main/src/app/model/nurbs-sculpt.ts
    title: src/app/model/nurbs-sculpt.ts (organic-surfaces/s6-nurbs-surface)
---

# Sketch

A sketch is version `"v": 1` JSON: a plane (`origin` and `turn`), an optional `on` (a face, a named plane, or a workplane), shared points, entities, and optional driving dimensions.[^sketch] Entity kinds are `line`, `arc`, `circle`, and `spline`, each of which may be construction geometry.[^sketch]

The solver in `src/sketch/solve.ts` is Levenberg-Marquardt over points, circle radii, and arc bulges. Its header says it is not PlaneGCS or FreeCAD. Constraint kinds it parses are horizontal, vertical, parallel, perpendicular, tangent, equal, concentric, fixed, midpoint, coincident, distance, length, radius, diameter, and angle. A sketch with nothing the solver understands is not touched.[^solve] The README says a rectangle is born with horizontal and vertical constraints, a driving size can name a parameter, and a size the other constraints cannot meet is refused.[^readme]

# From a sketch to a solid

History ops in `ModelOp` are `boolean`, `hole`, `split`, `fillet`, `chamfer`, `scale`, `join`, `root`, `extrude`, `revolve`, `loft`, `shell`, `group`, `faceExtrude`, `moveFaces`, and `partition`. Boolean ops are `fuse`, `cut`, and `common`.[^tree]

Since 6.13.0 `ModelOp` also has `draft`: `{kind: "draft", faces, angleDeg, pull?, neutral?}` tilts 1 to 50 existing flat, cylindrical or conical faces by −30° to 30° (not 0). A positive angle opens them toward `pull` (default +Z) about the neutral plane: a flat face, an `{origin, normal}` plane, or by default the plane through the faces' lowest point along the pull. History labels it "Draft 2 walls 3°".[^draft] The kernel builds it with `BRepOffsetAPI_DraftAngle`, refuses a floor and a face it cannot draft, naming the face by its index on the solid, and a group cannot contain one.[^draft-kernel] The app's face menu and the `model-draft` command open the Draft tool (angle and pull). A project saved with a `draft` step opens in 6.12 as a mesh with its History dropped, since 6.12 cannot read the op.[^draft]

Since 7.2.0 (organic surfaces S1 to S5) the kernel also has `sweep` along a 3D spine (`Curve3D`: polyline, spline, nurbs, segments or edges), `sheet`, `sew`, `thicken`, `trimSplit`, `replaceFace`, `splitFace`, `patch` and `blendSurface`; a profile loop takes a `nurbs` segment; a loft takes apex sections, guides, start and end conditions, `closed`, `smoothing` and `maxDegree` 2 to 10; and a fillet takes `continuity` g1, g2 or conic, `rho` and `variable` stations.[^organic-ops] In the app these are the Look menu's Zebra, Curvature and Surface grid, the Sketch spline's control-point mode, the Fillet panel's Profile and Variable radius, and the open-sheet bar (Thicken, Cap & Sew) with Patch (G0 or G1; a side asked G2 is refused) and Blend (G1 or G2); creating a sheet, the spine sweep, the loft options and trim, replace and split face are MCP and recipe only. G2 and conic fillets are built only on a straight edge between two flat faces, and a loft end is free, normal or tangent. S6 (a direct NURBS surface, below) is in 7.2.0 too.[^organic-plan] A project with one of the new step kinds or fields, or an object marked an open sheet, is saved as version 5, which 7.1.2 and older refuse before reading ("This project is version 5. This app opens up to version 4.").[^organic-file]

Primitive kinds are `box`, `cylinder`, `sphere`, `ellipsoid`, `cone`, `torus`, `wedge`, `polygon`, and `tube`.[^primitive]

Extrude, revolve, and loft can store the sketch on the op. The extrude comment says the kernel never reads that sketch JSON.[^tree] A sweep is not its own kernel op. `SweepDrawing` is "a sweep remembered on the loft it became," with a profile sketch, a path, and a scale. There is no twist field. The kernel never reads the drawing.[^tree]

Holes from a sketch are a `group` whose source is sketch holes, and they require a sketch on a face. Push/pull chooses the op: with nothing else held it is `moveFaces` (neighbours follow); Alt is `faceExtrude` (a prism on that face alone).[^pull]

Since 7.2.0 (S6) `ModelOp` also has `nurbsSurface`: a grid of 2 to 64 poles each way, weights, degree 1 to 8 in U and V, and clamped or periodic knots, built as an open sheet; it starts a part as a feature root.[^s6-ops] The Model tool's NURBS panel makes one (New NURBS surface, an 8 × 8 grid) and shapes it by pole, row or column drags along the part's axes or the normal, with falloff, symmetry about the part's X = 0 plane, and an Exact NURBS drawer for weight, degree, knot insertion and creases; History Edit reopens it. Over MCP `solid_new {feature}` starts a part from a NURBS surface or a sheet.[^s6-tool]

# Workplanes and the rail

A workplane is a U, V, W frame the part carries. Tools take numbers in that frame. `toSolidOp` stores the op in the solid's own frame. A part with no frame uses model space.[^workplane]

`MODEL_TOOLS` is `create`, `boolean`, `split`, `fillet`, `chamfer`, `hole`, `shell`, `scale`, `measure`, `place`, `workplane`, `check`, `pushpull`, `pocket`, `boss`, `texture`, `array`, `ribs`, `text`, `pattern`, and `mirror`.[^drag] Pocket, boss, texture, array, ribs, and text expand through `src/modeling` into a group of boolean steps, the same pieces the MCP builds for the same solid and the same spec.[^features]

The README says extrude, revolve, loft, sweep, and holes are buttons on the sketch card, not rail buttons.[^readme]

Open CASCADE is required for Model. See [Engine](../architecture/engine.md). Without the bridge, Model stays off.[^readme]

[^sketch]: src/sketch/model.ts
[^solve]: src/sketch/solve.ts
[^tree]: src/model-tree.ts
[^primitive]: src/model-primitive.ts
[^workplane]: src/workplane.ts
[^pull]: src/push-pull.ts
[^features]: src/model-features.ts
[^drag]: src/model-drag.ts
[^readme]: README.md
[^draft]: src/model-tree.ts (03b1c1d6)
[^draft-kernel]: crates/lime-model-occt/cpp/kernel.cpp (03b1c1d6)
[^organic-ops]: crates/lime-model-occt/src/tree/ops.rs (feature/organic-surfaces)
[^organic-plan]: docs/plan-organic-surfaces.md (feature/organic-surfaces)
[^organic-file]: src/model-tree-file.ts (feature/organic-surfaces)
[^s6-ops]: crates/lime-model-occt/src/tree/ops.rs (organic-surfaces/s6-nurbs-surface)
[^s6-tool]: src/app/model/nurbs-sculpt.ts (organic-surfaces/s6-nurbs-surface)
