---
type: Feature
title: Sketching and features
description: Sketches, constraints, and history ops live in the app and in the Open CASCADE bridge, which the shell loads only when it is built.
tags: [modeler, sketch, features]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
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
---

# Sketch

A sketch is version `"v": 1` JSON: a plane (`origin` and `turn`), an optional `on` (a face, a named plane, or a workplane), shared points, entities, and optional driving dimensions.[1] Entity kinds are `line`, `arc`, `circle`, and `spline`, each of which may be construction geometry.[1]

The solver in `src/sketch/solve.ts` is Levenberg-Marquardt over points, circle radii, and arc bulges. Its header says it is not PlaneGCS or FreeCAD. Constraint kinds it parses are horizontal, vertical, parallel, perpendicular, tangent, equal, concentric, fixed, midpoint, coincident, distance, length, radius, diameter, and angle. A sketch with nothing the solver understands is not touched.[2] The README says a rectangle is born with horizontal and vertical constraints, a driving size can name a parameter, and a size the other constraints cannot meet is refused.[9]

# From a sketch to a solid

History ops in `ModelOp` are `boolean`, `hole`, `split`, `fillet`, `chamfer`, `scale`, `join`, `root`, `extrude`, `revolve`, `loft`, `shell`, `group`, `faceExtrude`, `moveFaces`, and `partition`. Boolean ops are `fuse`, `cut`, and `common`.[3]

Primitive kinds are `box`, `cylinder`, `sphere`, `ellipsoid`, `cone`, `torus`, `wedge`, `polygon`, and `tube`.[4]

Extrude, revolve, and loft can store the sketch on the op. The extrude comment says the kernel never reads that sketch JSON.[3] A sweep is not its own kernel op. `SweepDrawing` is "a sweep remembered on the loft it became," with a profile sketch, a path, and a scale. There is no twist field. The kernel never reads the drawing.[3]

Holes from a sketch are a `group` whose source is sketch holes, and they require a sketch on a face. Push/pull chooses the op: with nothing else held it is `moveFaces` (neighbours follow); Alt is `faceExtrude` (a prism on that face alone).[6]

# Workplanes and the rail

A workplane is a U, V, W frame the part carries. Tools take numbers in that frame. `toSolidOp` stores the op in the solid's own frame. A part with no frame uses model space.[5]

`MODEL_TOOLS` is `create`, `boolean`, `split`, `fillet`, `chamfer`, `hole`, `shell`, `scale`, `measure`, `place`, `workplane`, `check`, `pushpull`, `pocket`, `boss`, `texture`, `array`, `ribs`, `text`, `pattern`, and `mirror`.[8] Pocket, boss, texture, array, ribs, and text expand through `src/modeling` into a group of boolean steps, the same pieces the MCP builds for the same solid and the same spec.[7]

The README says extrude, revolve, loft, sweep, and holes are buttons on the sketch card, not rail buttons.[9]

Open CASCADE is required for Model. See [Engine](../architecture/engine.md). Without the bridge, Model stays off.[9]

# Citations

[1] [src/sketch/model.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/sketch/model.ts)
[2] [src/sketch/solve.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/sketch/solve.ts)
[3] [src/model-tree.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/model-tree.ts)
[4] [src/model-primitive.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/model-primitive.ts)
[5] [src/workplane.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/workplane.ts)
[6] [src/push-pull.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/push-pull.ts)
[7] [src/model-features.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/model-features.ts)
[8] [src/model-drag.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/model-drag.ts)
[9] [README.md](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md)
