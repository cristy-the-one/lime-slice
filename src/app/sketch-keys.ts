/**
 * The sketch's key work stays in `sketch.ts`. The registry calls in through here so the two modules
 * do not import each other.
 */
type SketchKeyHandler = (id: string, ev: KeyboardEvent) => boolean;

let handler: SketchKeyHandler = () => false;
let active: KeyboardEvent | null = null;
let handled = false;

export function setSketchKeyHandler(next: SketchKeyHandler) {
  handler = next;
}

/** The key event `runSketchKey` reads. Set for the duration of `runCommand`. */
export function setActiveSketchEvent(ev: KeyboardEvent | null) {
  active = ev;
}

export function runSketchKey(id: string): boolean {
  if (!active) {
    handled = false;
    return false;
  }
  handled = handler(id, active);
  return handled;
}

export function sketchKeyWasHandled(): boolean {
  return handled;
}
