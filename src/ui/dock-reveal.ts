/**
 * E3. A seam between what needs a dock on screen (a Model tool's panel, the sketch card, Parameters, Inspect) and the
 * shell that owns the docks (`splitters.ts`), so those modules stay free of the shell's imports.
 */
export type DockSide = "left" | "right";

let reveal: (side: DockSide) => () => void = () => () => {};
let open: (side: DockSide) => void = () => {};

/** The shell installs its docks here once mounted. */
export function installDocks(next: { reveal: (side: DockSide) => () => void; open: (side: DockSide) => void }) {
  reveal = next.reveal;
  open = next.open;
}

/** Show a dock for now; the returned function gives it back. See `revealDock` in splitters.ts. */
export function revealDock(side: DockSide): () => void {
  return reveal(side);
}

/** Open a dock as the user's own choice, remembered. */
export function openDock(side: DockSide) {
  open(side);
}
