# Seam paint

Disks on the mesh that pull a wall's start into the painted ball. The list is omitted when empty, so a slice that does not paint a seam keeps the picker's start, the cartesian G-code, and the request cache key.

## Decisions

- One ordered list, `seamPaint`, next to `supportPaint`. A disk is `{ p, n, r }` in the object's mesh frame, the same frame support paint uses. There is no kind: every disk pulls the seam. The later disk does not override an earlier one; the start is the vertex closest to a disk centre among the vertices that sit inside any disk.
- The picker stays the default. Paint runs after the picker has chosen a start, and only on closed `outer`, `wall`, and `inner` loops. A loop with no vertex inside a disk keeps the picker's start. Infill, tops, supports, and the skirt are left alone.
- A disk meets a layer when its ball meets that layer's band. The circle on the layer is the ball's cross-section. The normal is stored and normalised, and is not used to place the seam.
- The chosen start is marked fixed, so travel ordering does not walk it back to the nearest corner. Fuzzy skin, when it is also on, still runs after that start.
- Radius, finiteness, and the 20000 disk cap match support paint. A refusal names the field, as `seamPaint[0].r`.
- On a plate the list is `objects[i].seamPaint`. A top-level `seamPaint` beside `objects` is refused. A one-object request with no `objects` array carries the list at the top level, and omits it when empty.
- A belt slice refuses seam paint. The belt rotates the mesh after the disks are posed, so a disk would not land on the wall it was painted on. Support paint is already refused on a belt for the same class of reason.
- `classic` does not clear the list. The picker still runs, and paint still moves the start.
- Contour keys ignore the list, because the cut does not move. Toolpath keys keep it. The support grow and support-paint keys ignore it, because those paths are not wall loops.

## Cache keys

The disk cache hashes the client JSON. Leaving `seamPaint` out of that JSON leaves the disk key unchanged. An empty list is omitted on the way back out, and a request that sends `[]` slices to the same G-code as one that omits the field.

In-memory stage keys hash `Debug` of `SliceSettings`. Adding `seam_paint` changes that text once, including when the list is empty. That is process memory. It does not change a stored request or a cartesian file.

## UI

A Prepare rail tool, Paint seam, separate from Paint supports. The brush leaves amber disks. Radius is 0.5 to 20 mm, step 0.5, default 3. Off, the slice body does not carry the field. Nothing on this path is mocked.
