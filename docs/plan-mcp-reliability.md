# MCP reliability: long exports, the two interference checks, thin walls at spline windows

Three defects an agent reported while building a printable clock over the MCP server
(`lime-workspace/cute-clock/clock-function-plan.md`, section F7), for 6.8.0. Each was reproduced first; this note says
what was found and what was decided.

## 1. A long `pose_animate` export restarted the server

**Reproduced.** The clock's escapement animation (19 parts) exported with `out.gif` on the fake engine, with a timer
watching the event loop:

| Export | Frames | Event loop held, before | Peak memory, before | Event loop held, after | Peak memory, after |
|---|---|---|---|---|---|
| 640 px, 30 fps, 1 beat | 30 | 21.6 s | 0.99 GB | 0.85 s | 0.98 GB |
| 640 px, 30 fps, 4 beats | 120 | 85.4 s | 1.17 GB | 1.07 s | 1.00 GB |
| 1024 px, 30 fps, 2 beats | 60 | 44.0 s | n/a | 1.00 s, a job at 45 s | n/a |

**Cause.** After the script ran, `poseAnimate` drew every frame, kept every frame's pixels, encoded the GIF and wrote it
in one synchronous run on the server's only thread. For those 85 s nothing else ran: no progress notification went out,
the request's cancel was not read, and `pose_animate` was not a detachable call, so the 45 s job reply could not fire
either. A client with a 60 s timeout gives up and restarts the server, which loses the plate (the autosave keeps it).
Memory grew with the frame count (all frames' pixels and the GIF as a JavaScript number array) and was capped by a
256 MB refusal, but it was not what stopped the server here. The engine is not involved: the frames are drawn by the
TypeScript rasterizer, and the reproduction ran on the fake engine.

**Decided.**
- `pose_animate` is detachable: past `replySeconds()` (45 s) it answers with a job, `slice_wait {job}` returns its result,
  and `slice_cancel` stops it (it is stoppable; it changes no part).
- The work takes a turn of the event loop between frames, in the crossing check (`frameInterference`, a generator) and
  in drawing, so the server answers other calls and hears a cancel.
- The GIF is written a frame at a time. Its palette is fixed (3/3/2, with the background's entry made exact), so it needs
  no frame before the first is written: `gifHead`, `gifFrame`, `GIF_END`, the same bytes `animatedGif` gave. One frame
  is held at a time, and the 256 MB refusal is gone.
- Every file is written as `<name>.partial` and renamed when the last frame is done. A cancel or a failure removes the
  partial files, so nothing is left under the names asked for.

## 2. `pose_animate` warned of intersections on most frames where the exact check found none

**Reproduced, and the two checks were answering about different poses.**

- The clock's `clock-tick` animation (the project as committed at b3534b4): 20 of 36 frames warned that the escape wheel
  intersects the pallet anchor. An independent measure on the same meshes (z-ray intervals, 0.02 mm grid) gives a common
  volume of 0.66 to 2.05 mm³, 0.46 to 1.21 mm deep, on exactly those frames and 0 on the others: real crossings of the
  frames as sampled. The script keys every 1/12 s and turns the escape wheel a whole number of teeth from key to key, so
  every key is in step with the pallets, and the exact check was run at those key poses (the script's own comment says
  so). The report's 30 of 36 came from an earlier state of the parts that the clock project no longer holds; the
  mechanism is the same. But 3 s at 12 fps is
  `round(3 × 12) = 36` frames spread from 0 to 3 s, 3/35 s apart: only the first and last frames fall on keys, and a
  frame between keys turns the wheel part of a tooth into the pallets.
- The gear train (`lime-workspace/gears/compound-gear-train.lime`): "Frame intersects Axle driver" on all 30 frames. The
  frame is a plain 6 mm plate with no holes and the axle stands 2 mm into it: 34.4 mm³ by the mesh, π × 2.35² × 2 =
  34.7 mm³ exactly. The exact check agrees; it is an overlap at rest, said 30 times.
- A real defect in the mesh pass, shown with synthetic meshes: an axle in a round hole of the same radius, each meshed to
  the kernel's 0.05 mm chord. With the same segments it is a touch; turned half a segment (a turning arbor is, on most
  frames) or with another segment count, it is a crossing, though the solids share no volume. The pass took 0.001 mm as
  contact while each mesh is up to 0.05 mm off its surface.
- A second defect: a crossing's `at` point was not on the cut line. It lay on a line through the first triangle's corner
  (the frame and axle pair said x = -96 for an axle at x = -65).

**Decided.**
- `interference(a, b)` keeps its signature and its answers. A third argument, `{ toleranceMm }`, makes overlap up to that
  depth contact: two triangles cross only when each passes more than it through the other's plane, and the points that
  test for a part inside the other sit deeper than it. `MESH_TOLERANCE_MM` = 0.05, the kernel's chord.
- The animation check and `model_check {interference}`'s mesh pass use 0.05 mm and say so. The joint sweep keeps 0.001 mm:
  its candidates are measured by the exact pass anyway.
- A pair that overlaps at rest and keeps that relative pose is said once, as an overlap at rest; frames where it moves and
  still crosses are counted as crossings.
- One warning per pair: the frames it crosses on, the first frame and its time, and which check made it with its
  tolerance (`pair`, `frames`, `firstFrame`, `timeS` beside the sentence).
- When keys fall between frames, the reply says so: frames are `durationS / (frames - 1)` apart, and frames between keys
  are interpolated.
- `at` is a point on the cut line.
- **Not changed, for the owner:** where frames fall. `round(duration × fps)` frames spread over [0, duration] puts frames
  between keys keyed at 1/fps. Frames at 1/fps (one more frame, or the last one before the end) would change every
  animation's frame count and its loop.

## 3. `model_check {minWallMm}` reported knife edges at the seams of spline windows

**Reproduced on the kernel's own meshes**, the plates and wheels as the clock project kept them while their windows were
closed splines (its commits 86aadf5 and c154dc5). At 0.8 mm the scan finds 2 to 8 regions a part, thinnest 0.018 to
0.77 mm. The polyline windows that replaced them give none.

**It is not the seam, and not a kink.** The kernel builds a closed spline (one `spline` segment that ends where it
starts) as one periodic curve, smooth through its start (`closed_spline` and `spline_edge` in
`crates/lime-model-occt/cpp/kernel.cpp`). The regions lie 1.4 to 42 mm from the seams. Every one sits at a rim of a window
wall, within 0.07 mm of the top or bottom face. The wall there is meshed with facets that lean 5° to 25° off vertical
(one is a sliver 0.022 mm tall and 34 mm long along the top edge): the boolean trims the spline wall with new edges at
the top and bottom, and the mesher puts points between them. A ray straight in from such a facet, near the rim, meets
the cap face beside it after 0.02 to 0.77 mm. A polyline window's walls are flat and its facets vertical, so their rays
run parallel to the caps.

**The printed part is not affected**: the walls meet the caps at 90°, and the lean is within the mesh's 0.05 mm chord.

**Decided.** The scan counts a hit as the far side of a wall only when that face turns back toward the face the ray
started from by more than 45°. A wall's two sides face each other, as does a knife edge's (a wedge under 45°); a corner
of 45° or more (a rim at 90°, a facet leaning at it) is not a wall. The real kernel case is an MCP test that runs in CI's
"MCP server against real Open CASCADE" job: a plate with a spline window and the same window as a polyline. It is not
run on this machine, which has no Open CASCADE bridge built.
