/** Shared state of the Model view: the types, constants, and the module-level values more than one model module reads or writes. */
import { type Bounds, type Mat3 } from "../../mesh-place";
import { type Affine, type ObjectFrame, type Turn } from "../../model-space";
import { type EditPanel, type ToolLink } from "../../model-edit";
import type { ModelPick } from "../../model-view";
import { type ParsedSolid } from "../../model-reply";
import { type ProbeView } from "../../model-feasibility";
import { expandFeature } from "../../model-features";
import { type ModelOp, type NodeId, type Vec3 } from "../../model-tree";
import type { PluginValue } from "../../model-tree";
import { type PullController } from "../../push-pull-ui";
import { type PluginFileInfo } from "../../plugin-file";
import { type PluginEnv, type RowKey } from "../../model-history";
import { type HoleTarget } from "../../sketch/holes.ts";
import { type SketchData } from "../../sketch/model.ts";
import { type Workplane } from "../../workplane";

export type Body = Record<string, unknown>;

/** The tree in the view, the plate object it belongs to, and the solid of its current node. */
export interface Opened {
  objectId: string;
  key: string;
  solid: ParsedSolid;
}

export const VIEW_ONLY = "Surfaces only. This file can be measured but not edited.";

export const BROKEN = "This step could not be rebuilt, so it and the steps after it are unavailable.";

export const ROOT_BROKEN = "This solid's primitive builds differently in this modeler, so its history cannot be rebuilt.";

/** Ops that name edges or faces by the solid's own numbering: they build only on a step the history built. */
// --- P1: a face pull names faces, so a seed solid is rebuilt before the step, as a fillet is. ---
export const NAMES_TOPOLOGY = new Set<string>(["fillet", "chamfer", "shell", "faceExtrude", "moveFaces", "transition"]);

export const solids = new Map<string, ParsedSolid>();

/** Mesh tokens whose plate objects already carry that shape's solid (`brep`), or whose mesh is the STEP file itself. */
export const stepKnown = new Set<string>();

/** Solid exports on their way, by mesh token, so a save during the write after leaving Model waits for it. */
export const writing = new Map<string, Promise<ArrayBuffer | string>>();

/** Kernel answers by `probeKey`. */
export const answers = new Map<string, ProbeView>();

/**
 * A tree from a project saved before version 3, whose `brep` is STEP, until the engine has the whole of it. Once `live`,
 * the engine holds the plate's step (`node`), read from that step's STEP, as its root: enough to look and measure.
 * An edit, or a call on any other step, first opens the whole tree from its root STEP and ops
 * (`whole`, while that is on its way). Every call waits for that, and for a read of the step's STEP
 * (`reading`) after an engine restart.
 */
export interface Seed {
  node: NodeId;
  /** The steps the engine holds while the seed is live: the plate's step, and the steps applied on it since. */
  held: Set<NodeId>;
  live: boolean;
  whole: Promise<string | null> | null;
  reading: Promise<void> | null;
}

export const seeds = new Map<string, Seed>();

/** Solids the engine answered from a seed's STEP-read step: shown only while that seed stands alone. */
export const readSolids = new WeakSet<ParsedSolid>();

/** A Place step: the pose, and since M11 the frame, the open object had before it. */
type PlaceStep = { pose: Affine; frame: ObjectFrame };

/** A typed or scrubbed Place number is one step once it rests this long. A drag ends its own step. */
export const PLACE_SETTLE_MS = 400;

/**
 * The open object's workplane steps in this visit: its frame as the object stores it, and its plate orient, which only
 * Print with W up changes. One gesture is one Prepare step, and Undo here steps them while the Workplane tool is open.
 */
export type WorkplaneStep = { plane: Workplane | undefined; orient: Mat3 };

/** Mesh tokens of objects whose STEP opened as surfaces with no closed solid: never a join's tool. */
export const surfacesOnly = new Set<string>();

/** Trees on their way for objects picked as a join's tool before Model ever opened them, by object id. */
export const toolOpens = new Map<string, Promise<{ key: string; node: NodeId } | string>>();

export const STILL_WORKING = "The modeler is still working. Try again in a moment.";

/**
 * A step being edited: its tool is open on the step's parent, which the view shows, with the step's own numbers.
 * `parent` is where the edit builds (the root itself for a new solid's root); `from` is the step shown before, where
 * Cancel goes back to; `replay` the steps that replay under the edit, oldest first. `opened` is the op the panel said
 * when it opened, so an untouched panel offers no Update.
 *
 * A tool's step, edited from the open solid's History, is in the tool's tree (`key`), reached through `joins` from the
 * open tree (`target`); `from` and `replay` are the open tree's, and `row` names the step in History. For the open
 * solid's own step, `key` is `target` and `joins` is empty.
 */
export interface Editing {
  key: string;
  target: string;
  row: RowKey;
  joins: ToolLink[];
  node: NodeId;
  parent: NodeId;
  from: NodeId;
  replay: NodeId[];
  op: ModelOp;
  panel: EditPanel | null;
  opened: string | null;
  /**
   * P2. Set while an edge drag is editing the step it just made. The HUD is the editor, so no fillet
   * or chamfer panel opens, and `editOp` returns this rather than the panel's fields.
   */
  edgeOp?: ModelOp;
  /**
   * --- F1/E1. Set while a sketch extrude is the editor. `featureOp` is the extrude Apply will
   * replay. `sketch` marks the session so Cancel returns to the step instead of opening a panel.
   */
  featureOp?: ModelOp;
  sketch?: true;
  /**
   * --- A6. Ops for this one edit, earliest first. Set by a parameter rebuild so the replay
   * uses the new numbers without rewriting the old branch.
   */
  supplied?: ModelOp[];
}

/**
 * A tool's step on screen in place of the open solid's: what a click on a tool's row in History shows, read-only, and
 * what an edit of a tool's step builds on. It sits where the joins put it (`pose`), and `open` stays the open solid's
 * shown step throughout, so the plate, Undo and a save never see it. `row` names it in History; `key` and `node` in
 * the engine.
 */
export interface Lens {
  row: RowKey;
  key: string;
  node: NodeId;
  joins: ToolLink[];
  pose: Affine;
  solid: ParsedSolid;
}

/** A few checked shapes, by `probeKey`: going back to numbers just checked shows their shape at once. */
export const previews = new Map<string, ParsedSolid>();

/** The answers that came with a shape, so one whose shape left `previews` is asked again rather than shown without it. */
export const shaped = new Set<string>();

/** An object Model made, with the Prepare step that added it to the plate. */
export interface MadeObject {
  id: string;
  step: object | null;
}

export const MADE_KEPT = 20;

// ---------------------------------------------------------------------------
// --- Plugins (docs/plan-recipe-plugins.md D13, milestone 7): the panel's Preview and Apply, Use vN, Save as plugin….
// ---------------------------------------------------------------------------

/** Use vN: the library's newer version runs in place of the stamped code, with the stamped values carried by name. */
export interface LibrarySwap {
  file: PluginFileInfo;
  sha256: string;
  params: Record<string, PluginValue>;
  /** Which values the new version no longer takes, for the readout. */
  note: string;
}

/** Trees from a project that the engine has not been sent yet: the first call opens them, rather than ask and be told. */
export const unopened = new Set<string>();

/** What the readout says with a tree's step when it next shows one: why its saved solid was refused. */
export const seedNotes = new Map<string, string>();

/** The steps of each whole tree the engine said it holds a solid for, from its last answer with `held`. */
export const engineHeld = new Map<string, Set<NodeId>>();

/** Mutable state that more than one model module reads or writes. The rest stays private to its module. */
export const S = {
  ticket: 0 as number,
  picks: [] as ModelPick[],
  busy: false as boolean,
  /** A `goto` for `jumpTarget` is on its way. A newer jump takes over from it (`jumpSerial`); edits, Undo, and STEP are off until it lands. */
  jumping: false as boolean,
  jumpSerial: 0 as number,
  jumpTarget: null as NodeId | null,
  probeTimer: 0 as number,
  // --- P1: a face drag's dry-run. While set, the panel's probe waits. ---
  pullProbe: false as boolean,
  pendingProbe: null as (() => Promise<void>) | null,
  open: null as Opened | null,
  /** The plate object Model last opened, so a selection change elsewhere can tell it moved. */
  shownFor: null as string | null,
  /** A tree resumed above its broken committed step: the plate keeps that step's mesh until the user moves. */
  parked: null as string | null,
  /** The object the camera last framed. A new solid of the same object keeps the user's view. */
  framedFor: null as string | null,
  /** Place moves of the open object in this visit, for Undo and Redo while Place is open. One gesture is one step. */
  placeUndo: [] as PlaceStep[],
  placeRedo: [] as PlaceStep[],
  /** The turn the Place fields last showed or took, so they read the same turn the same way (`steadyTurn`). */
  shownTurn: null as { id: string; turn: Turn } | null,
  /** The pose a Place gesture started from, while it is under way. */
  placeBefore: null as Affine | null,
  placeTimer: 0 as number,
  wpUndo: [] as WorkplaneStep[],
  wpRedo: [] as WorkplaneStep[],
  /** Where a workplane gesture started, while it is under way. */
  wpBefore: null as WorkplaneStep | null,
  wpTimer: 0 as number,
  /** The object drawn as the join's ghost rather than grey, and the readout's last account of the join. */
  ghosted: null as string | null,
  joinSaid: "" as string,
  /** Counts the plates Model has forgotten, so a tree opened for an earlier one is let go. */
  plateEra: 0 as number,
  editing: null as Editing | null,
  /** --- E1. A feature-root edit is not a sibling fork. Undo waits until the sketch closes. --- */
  sketchRootEdit: false as boolean,
  /** P2. The idle edge knob. Null until the view is bound. */
  edgeDrag: null as { sync(): void; picksChanged(): void; holding(): boolean; end(): void } | null,
  /** --- S2 sketch --- redraws the grid when the solid on screen changes. */
  sketchUi: null as { sync(): void } | null,
  /** --- F4. The points H snapped, and the sketch as it was then. Held while the Hole panel is that layout. --- */
  sketchHoleDraft: null as { sketch: SketchData; points: HoleTarget[] } | null,
  /** Set while the panel is opening, so closing the previous tool does not drop the draft. */
  holdSketchHoles: false as boolean,
  endPullDrag: null as (() => void) | null,
  /** P1. The face push, for the panel's Diameter field on one picked cylinder. */
  pullPanel: null as PullController | null,
  lens: null as Lens | null,
  /** The last edit, so Undo goes from its tip back to the step shown before it, and Redo forward again. */
  editBack: null as { key: string; tip: NodeId; back: NodeId; undone: boolean } | null,
  /**
   * --- A7 model check --- A probe's hollows and loose pieces, drawn in model space.
   * A check still in flight keeps the boxes already drawn.
   */
  locatedNow: null as Bounds[] | null,
  // --- A3 composite features ---
  featureMemo: null as { key: string; value: ReturnType<typeof expandFeature> } | null,
  /**
   * --- Text on a cylinder or a cone. Where the person clicked on the face, in model space: the text is centred there. Null puts it in
   * the middle of the face, across from its seam. It belongs to one face and is dropped when another is picked.
   */
  textAnchor: null as { face: number; point: Vec3 } | null,
  /**
   * Objects Model made, one batch per feature (separate regions make one object each), newest last. Undo at the start of
   * the newest one's history takes its batch's Prepare steps back while they are still the newest steps, so the objects
   * leave the plate, as undoing the first feature of a new body does in Fusion. Redo puts them back the same way.
   */
  madeBatches: [] as MadeObject[][],
  /** Set while one feature makes several objects, so they are one batch. */
  makingBatch: null as MadeObject[] | null,
  /** Replay the shown branch from the earliest step a parameter change reaches, as one edit. */
  /** --- D21. A rebuild still asking the engine for a solid: a second Rebuild waits for it. */
  rebuilding: false as boolean,
  /** Prepare asked to check this object. The tool opens once that solid, or its mesh, is on screen, and not for another. */
  checkQueued: null as string | null,
  /** --- Plugin steps (D9). The project's plugin copies, checked against their hashes once per opened project. */
  pluginEnvFor: null as [Record<string, string> | undefined, Record<string, unknown> | undefined] | null,
  /** The env the History card shows, kept for a rebuild to read the same copies. */
  pluginEnvNow: null as PluginEnv | null,
  measureSeq: 0 as number,
  readoutText: "" as string,
  /** Prepare's Re-aim for an object: Model opens on it, and the steps are re-aimed once its solid is on screen. */
  reaimQueued: null as string | null,
};
