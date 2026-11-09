/**
 * `closeCracks` off the UI thread, for the mesh the plate will take when Model is left (src/closed-ahead.ts).
 * The caller sends a copy of the solid's positions, so the solid on screen keeps its buffer.
 */
import { closeCracks } from "./mesh-check.ts";

interface CloseJob {
  id: number;
  positions: Float32Array;
}

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<CloseJob>) => void) | null;
  postMessage(data: { id: number; closed: Float32Array }, transfer: Transferable[]): void;
};

scope.onmessage = (ev: MessageEvent<CloseJob>) => {
  const closed = closeCracks(ev.data.positions);
  scope.postMessage({ id: ev.data.id, closed }, [closed.buffer]);
};
