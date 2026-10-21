/**
 * The one label the Model view and the MCP tools share.
 * The same words are `LABEL` in `crates/lime-sim/src/fields.rs`.
 */
export const LABEL = "In-house estimate";

/** What a provisional card says in the section and on the result. */
export const PROVISIONAL_SENTENCE = "Provisional card, not a measurement.";

/** A fixture with no face and no bed. The solver uses the same sentence. */
export const NOT_HELD = "This part is not held. Fix a face, or the bed.";

/** Plate undo and the solid's history are different gestures. */
export const UNDO_SENTENCE = "Undo puts the last hold or load back. The solid's history is the History list.";
