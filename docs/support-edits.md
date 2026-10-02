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

**Recompute.** Settling disks and dropping unfooted interface read only the finished layer below. They run as one bottom-up pass, starting at the lowest layer an edit changed and stopping once a layer above the change comes out unchanged. Support paths are rebuilt for the layers that changed. A property test checks that the incremental result equals a full rebuild. Travel order and G-code emit still run over the whole print until the separate-tours step.

**Coverage.** A warning lists the demanded interface that was dropped because nothing holds it, by layer and area, with a region to regrow. Each edit reports the area it newly left floating.

**Grid style.** Grid supports are one region per layer with no columns, so they get coverage warnings but no identity and no edits.

## Steps

1. One `Disk { xy, r, node }` per tree disk replaces the parallel center and radius lists. No output change.
2. Record the forest in the walk, split out the demand, and fuse the two bottom-up passes. No output change.
3. Report coverage warnings on the response, in the audit, and in the CLI. G-code unchanged.
4. Prune and replay, the interface clip, and the incremental rebuild, with the incremental-equals-full test.
5. Regrow with fixed limbs and masked tip seeding.
6. Wire it up: `support_edits` on the request (omitted when empty, so cache keys do not change), a compact tree outline on the response for picking, and support paths rebuilt only for changed layers.

After these: order supports and the part as separate travel tours, then keep the part's slice in memory.
