# Local workplane

A Creo-style U, V, W frame for Model mode. The UV plane is the face or plane you are working on, and W is its normal. Hole, Boolean and Split are typed in that frame, from its origin, and W is the way a hole drills and a box grows. The math is `src/workplane.ts`; the panel and the dock gizmo are the Workplane tool (toolbar, Shift+U).

A workplane is a frame for typing numbers. Like every Model tool it follows the model-space rule in `docs/step-modeler.md`: nothing done with it changes the plate, the mesh, or the slice. The one exception is a button, Print with W up, that the user presses ("On the plate").

## The frame

A workplane is an origin and a turn (degrees about X, then Y, then Z, the order a primitive and Place use). The turn's columns are U, V and W. It is not a kernel op and not a history node: a plate object keeps it, as `workplane`.

**It belongs to its part.** The object keeps the frame in its own frame, the frame its solid and its `modelPose` start from, so the frame moves with the part: Place, Reset in the Position row, a duplicate (which takes the copy's pose), and a split piece (which takes its parent's pose and frame). Tools see it in model space (`workplaneIn`). Separate shells drops it, since its pieces are meshes Model does not open. Datum planes in Creo, Onshape and Fusion belong to their part the same way.

| Source | Frame |
| --- | --- |
| Global | Model space: U = X, V = Y, W = Z at the model origin. A part with no frame stored has this one, and every number is what it was before workplanes. |
| Bed | The same axes, the origin at the middle of the part's footprint on its lowest point in model space. W points up. |
| Face | The origin at the area-weighted middle of a picked flat face, W its outward normal. U and V are the face's in-plane axes as Split works them out (`inPlaneAxes` in `src/model-plane.ts`), from the face in the part's own frame, so they run along the part's own axes however it is turned. A curved face is refused with Split's sentence, "Pick a flat face. This one is curved.", and the frame stays where it was. |

The source says how the frame was set. A typed number keeps the source; the numbers are what tools read.

## The Workplane tool

- **The panel** has Global, Bed and Face, then the origin (X, Y, Z) and the turn (Turn X, Y, Z) in model space, the fields Place has, and Print with W up beside Done. It has no Apply: it moves as it goes.
- **Face** turns Face picking on. With no flat face picked, the button stays on and the note says "Click a flat face to put the frame on it."; the next flat face picked takes the frame, and so does each face picked after it while Face is on.
- **The dock** has three arrows that slide the origin along U, V and W, and three rings that turn it about X, Y and Z, as Place's do. A field or a handle changes only its own numbers: the others keep the frame's exact values, not the rounded ones shown, so a slide never nudges the turn. Shift and Ctrl slow and snap as on every handle.
- **Steps.** A drag until the pointer lets go, a typed or scrubbed number once it rests 400 ms, a source button, and Print with W up are each one step. While the tool is open, Undo and Redo (the buttons, Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y) step them, and the solid's history waits until it closes, as for Place. Each is also a Prepare step, folded into the visit like an edit.
- **The view.** The frame is drawn as a square in the UV plane, the size of the solid, lifted a hair along W off the face it sits on and faint where the solid hides it, and a U, V, W triad in the axis colours drawn over everything, so it reads inside a part too. It shows while the tool is open and whenever the part has a frame, also under Hole, Boolean and Split, and not while a step is edited. While the tool is open, a picked face is tinted teal rather than the accent. The lines are drawn once per solid size and theme and moved by a matrix, so moving the frame or the part rebuilds nothing.

## What reads it

```
fields (U, V, W) → model space (the workplane) → solid frame (toSolidOp) → engine
```

The first arrow is this feature; with the global frame it is the identity, value for value, so every op is the one sent before workplanes. The second is unchanged.

- **Hole.** The origin fields are U, V, W, named so. With no face picked the hole drills along −W ("Along −W; click a face to drill into it."), and a hole opened on a workplane whose typed point is off the part starts at the frame's origin. A picked face still drills into that face. Through all and the counterbore follow the drill axis, whichever it is, as before.
- **Boolean with a primitive.** The origin and the turn are U, V, W. The primitive turns about its own centre (`turnCentre`), so its centre goes through the frame and its turn takes the frame's turn (`planePrimitive`, through `fromSolidOp`, as `toSolidOp` takes an op into a solid's frame): a box grows from its origin along U, V, W, so one typed at 0, 0, 0 on a face stands on it. The dock's arrows, knobs and rings follow U, V, W.
- **Split.** X, Y and Z are U, V and W, named so on the buttons and in the field: the number is where the plane crosses that axis from the frame's origin, and the plane's pivot is on that axis. Face mode and the tilts are unchanged. The op stored is still only a pivot and a normal.
- **Unchanged:** Boolean with an object (Place moves its tool), New solid (it places itself), fillet, chamfer, scale, measure and Place.

Apply bakes the op into the solid's own frame, as every Model step does. A frame moved later moves only what is still typed in it, never a step already cut.

**Edit step.** While a step is edited, its tool's fields are the op's own numbers in model space (X, Y, Z), as `fromSolidOp` opens them, and the frame is not drawn. The step was baked in the solid's frame at Apply, and the frame may have moved since, so the frame the numbers were typed in is gone; the op's own numbers are the ones that are exact: an untouched field sends its stored number, and with no pose the panel is the op number for number. Closing the edit brings the frame back.

## On the plate

A workplane never changes the plate pose (`orient`), the mesh, or the slice. Turning the frame, putting it on a side face, or undoing it moves no part on the bed. The owner decided this on 2026-10-16, to keep with how Model works so far: CAD sketch planes in Creo, Onshape and Fusion do not move print placement either.

**Print with W up** is the explicit way. It sets the object's `orient` so W points up and U runs along +X: the plate mesh is the part's own frame lowered, so the orient is the inverse of the frame's turn as the part keeps it (`printOrient`), whatever the part's model-space pose. The placer then drops the part onto the bed as for any turn. With the global frame it is the file's own way up. It is off while the plate already prints W up. It is one step, like Prepare's Lay flat: Undo in the Workplane tool takes it back, and so does Prepare undo.

## Saved

`.lime` keeps `workplane: {source, origin, turn}` on each object, in its own frame, and leaves it out for the untouched global frame, so an older file opens as it did. A frame with an unknown source or a number that is not finite is a damaged file. One object with a workplane is written as version 2; an older app ignores the key, drops it on the next save, and the part still slices as it did.

## Cost

Nothing here asks the engine. The model-space frame is composed from the stored one and the pose when a tool reads it, a few multiplications. The datum is drawn once per solid size and theme. The split plane's cache key includes the frame, so a frame change works the plane out once.
