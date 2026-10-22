/**
 * The one label the Model view and the MCP tools share.
 * The same words are `LABEL` in `crates/lime-sim/src/fields.rs`.
 */
export const LABEL = "In-house estimate";

/** The legend when the bridge solved the part as sliced. */
export const AS_SLICED = "In-house estimate · as sliced";

/** What a provisional card says in the section and on the result. */
export const PROVISIONAL_SENTENCE = "Provisional card, not a measurement.";

/** A fixture with no face and no bed. The solver uses the same sentence. */
export const NOT_HELD = "This part is not held. Fix a face, or the bed.";

/** What Model's Stress asks for while its setup is not done. */
export const HOLD_NEXT = "Hold the part: the bed, or pick faces.";
export const LOAD_FACES_NEXT = "Pick the faces the load pushes on.";

/** Plate undo and the solid's history are different gestures. */
export const UNDO_SENTENCE = "Undo puts the last hold or load back. The solid's history is the History list.";

/** Run, until the desktop calls the bridge. */
export const NOT_WIRED = "The stress solve is not wired to the desktop yet.";
