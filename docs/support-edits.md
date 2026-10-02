# Support identity and edits

This is the plan for making tree supports editable without re-slicing the part. The part is primary and supports are subordinate: deleting a branch or a tree, or regrowing supports in a region, must rebuild only the affected support layers, never the part.

## Decisions

- Deleting support that leaves part of the object floating warns and highlights. It does not block.
- When the part is re-sliced, support edits are replayed. Edits that no longer match are flagged.
- Support settings stay tied to the strategy blend by default.
- With no edits, the G-code is byte-identical to the walk as it is today. Every step is checked against the golden set (`tools/golden_ab.sh`).

## Model

**Demand.** The part decides what needs support: overhang regions, the regions where tips are born, the raw interface, and the grid style's sparse region. None of these read tree nodes, so edits never change them.

**Forest.** The walk is recorded as limbs. A limb is one lineage, from the tip where it is born down to where it merges, lands on the part, or reaches the bed. Each layer of a limb is a knot holding the full node state: position, radius, distance fallen, freeze, load, and whether it must reach the bed. A tree is a root limb plus every limb merged into it.

**Identity.**
- **Within one plan:** a limb is addressed by its walk node id. The host of a merge always has the smaller id, and each layer's disks are in ascending id order.
- **Across re-slices:** an edit stores where its tips are born (a position plus the contact height in mm), because walk ids renumber whenever the input changes.

**Edits.**
- `Prune { sites }` removes the limbs born at those sites, then trims whatever no longer carries a surviving tip. Branch and tree are the same operation; the difference exists only in what the user selected.
- `Regrow { region, z }` grows fresh tips for demand inside the region that nothing covers. Kept limbs stay fixed: they are pair targets that never move, obstacles, and merge hosts only when they are already thick enough. An edit never changes a kept knot.
  - `z` is a range, low then high, not a top height. A single height would also regrow every unheld patch below it in the same footprint, including trees the user pruned on purpose. A coverage gap's own range is the natural input.
  - On each layer in the range, the mask is the demanded interface less what the layer prints, inside the region widened by twice the coverage outline tolerance. Pieces under 0.05 mm² are dropped.
  - Tips are born where the overhang reaches its contact inside the mask, and any piece of the mask no new tip covers gets a seeded tip, by the same sampling and packing as the walk.
  - The walk runs the same per-layer step as a build. Kept knots on the layer it steps to are fixed. A new node pairs with a kept knot only if the knot can carry it, which means the same `to_bed` and `section_radius(host.load + guest.load) <= host.radius`. It joins the knot when it also holds the node's disk above. Otherwise it is pushed clear of the kept disk, at most one lean step a layer. A kept knot only counts if its disk stands on that layer.
  - The load in that test counts the regrown tips the kept limb already took, at that layer and below, from this regrow and earlier ones. A knot also takes no more than the tightest lower knot of its limb, where an earlier regrown tip joined, still can. This is worked out from the forest and never written to a kept knot. The load is not followed into the limbs the kept limb merges into.
  - New limbs get ids after every existing one, so a kept host always has the smaller id. A kept limb never merges into a new one.
  - Regrowing a region with nothing unheld in it is `Stale` and changes nothing.
- The interface is derived from the tips that hold it. A deleted tree's interface patch cannot survive on a neighbour's foot and bridge over air.
  - Every edit is numbered, and a pruned limb records the edit that pruned it. Each regrow stores its mask per layer under its own number.
  - A pruned tip's cell is cleared from the interface, less the masks of regrows numbered after its prune. Regrowing a pruned tree's gap therefore prints its interface again, and pruning the regrown tree clears it again.

**Recompute.** Settling disks and dropping unfooted interface read only the finished layer below. They run as one bottom-up pass, starting at the lowest layer an edit changed and stopping once a layer above the change comes out unchanged. Support paths are rebuilt for the layers that changed. A property test checks that the incremental result equals a full rebuild. Each layer prints its skirt and supports as one tour, then the part as its own tour. The part's tour starts where its tour on the layer below ended, and on the first layer where a skirt around the part alone would end, so it never depends on the supports and is planned once with the part. The support tour starts where the nozzle stands, which is the end of the part's tour below, so each layer's support tour is ordered on its own and in parallel. A kept slice also keeps its last plan's joined layers: the support tour, its combing and z-hop, and the travel into the part rerun only on layers whose skirt, support paths, or entry point changed, and `stages.layersReused` counts the rest. G-code emit still runs over the whole print, because E is absolute and every layer above a change writes different E values.

**Coverage.** A warning lists the demanded interface that was dropped because nothing holds it, by layer and area, with a region to regrow. Each edit reports the area it newly left floating.

**Grid style.** Grid supports are one region per layer with no columns, so they get coverage warnings but no identity and no edits.

## Steps

1. One `Disk { xy, r, node }` per tree disk replaces the parallel center and radius lists. No output change.
2. Record the forest in the walk, split out the demand, and fuse the two bottom-up passes. No output change.
3. Report coverage warnings on the response, in the audit, and in the CLI. G-code unchanged.
4. Prune and replay, the interface clip, and the incremental rebuild, with the incremental-equals-full test.
5. Regrow with fixed limbs and masked tip seeding.
6. Wire it up: `support_edits` on the request (omitted when empty, so cache keys do not change), a compact tree outline on the response for picking, and support paths rebuilt only for changed layers. The engine half is done; the UI half picks limbs from the skeleton and sends edits.

## Wire

**Request.** `supportEdits` is an array of edits, applied in order. It is omitted when empty, so a request without edits keeps the cache key it had before. `includeSkeleton: true` asks for the tree outline. Each edit is tagged by `kind`:

- `{"kind": "prune", "sites": [{"xy": [x, y], "z": z}, ...]}`. A site is a limb's birth site from the skeleton, sent back exactly.
- `{"kind": "regrow", "region": [[[x, y], ...], ...], "z": [low, high]}`. The region is a list of closed loops.

The engine refuses a request whose edits are malformed, naming the edit: `supportEdits[1]: a prune needs at least one site`. Limits: 1000 edits, 200000 sites, 100000 region points, every number finite and within 100000 mm, every loop at least 3 points, `z` low at most high.

**Outcomes.** The response carries `supportEdits`, one per edit in request order, omitted when there were none. Each has `status`: `"applied"`, `"rebound"` with `movedMm`, or `"stale"` with `missed`. `changedLayers` counts the layers whose printed support changed and `changedSpan` is `[lowest, highest]` of them by `PreviewLayer.index`, absent when none changed. `newlyFloatingMm2` is the coverage area the edit added, negative for a regrow that held something again. `floating` lists the coverage gaps the edit leaves, specks included. Grid supports have no limbs, so every edit on them is `stale`.

**Skeleton.** `skeleton` is present only when asked for. It holds every limb that still prints as parallel columns in ascending limb id: `id`, `tree` (the root limb's id), `into` (the merge parent's id, 0 for a root), `live` (1 until the limb's own tip is pruned), `siteX` and `siteY` (1 µm), `siteZ` (the band z, exact), and `start` into the knot columns `xs`, `ys`, `zs`, `rs` (0.01 mm, top to bottom). Knots are thinned: an interior disk is dropped when the straight run between its kept neighbours stays within 0.05 mm of it in x, y, and radius. The UI builds a branch's sites from a limb plus every limb whose `into` chain reaches it, and a tree's sites from every limb with the same `tree`.

**Stage clocks.** `stages` gains `objectReused`, `supportBaseReused`, `editsReused`, `editApplyMs`, `editRefreshMs`, and `layersReused`. The clocks of reused work read zero.

**Kept bases.** The desktop app and `serve` call `keep_support_bases(true)`. The engine then keeps the last 3 interactive slices (those with `includePreview`) in memory. Each entry holds the part's slice, its supports planned with no edits, and the last edited state on them. The entry key hashes the mesh, blend, nozzle, and every setting except the edits, the skeleton flag, and the job. A second key leaves out the support-only settings too, so a support setting change reuses the part and plans only supports. Entries for the same part share one copy of it. A request whose edits start with the kept edited state's edits applies only the new ones. Any other edit list, including a shorter one after an undo, replays from the base. Baseline, compare, and Pareto plans never read or evict the kept entries. The CLI `slice`, tests, and golden leave keeping off, and turning it off forgets every entry.

**Partial previews.** A click changes the supports of some layers, and most of each changed layer's paths stay the same. So the reply after a click can carry only what the client lacks.

- Every reply from a kept slice has `previewToken`. It names that preview: a hash of the kept entry's key, the printer profile, and the edits. The same name always means the same preview, because a kept plan equals a cold one.
- A request may send `previewBase`, the token of the preview the client shows. The engine compares it with the preview it last drew from that kept entry. When they match, the reply has `previewPatch` and an empty `layers`. Otherwise, and always when nothing is kept, the reply is whole, as before.
- `previewPatch.base` repeats the token the patch applies to. `previewPatch.layers` lists `PreviewLayer.index` of every layer of the new preview, in order. A layer missing from `previewPatch.changed` is the base's layer with the same index.
- Each changed layer has the usual layer fields. Its `paths` holds only the paths the base layer lacks. Its `order` lists the whole layer in print order: `k >= 0` is the base layer's path `k`, and `-1 - j` is `paths` path `j`. A layer is changed when it was joined again or its layer time moved.
- The engine records the preview it drew only after the reply is built. A slice that stops in between leaves nothing recorded, so the next request gets a whole preview.
- The disk cache leaves `previewBase` out of its key and never stores a patch, so a stored reply is always whole.

The UI sends `previewBase` only while the preview on screen is the one that token names, with its buffers drawn (`src/app/viewer.ts`). It rebuilds the layer list from the patch (`src/preview-patch.ts`), has the geometry worker build buffers for the sent paths only, and copies every other path's geometry from the buffers on screen. If the patch names a layer or path the screen does not hold, it asks again without `previewBase`.
