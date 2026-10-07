/// Build the Prepare outline off the main thread: 0.26 s on a 475k-triangle mesh.

import { sharpEdges } from "./mesh-edges";

self.onmessage = (event: MessageEvent<{ id: number; positions: Float32Array; thresholdDeg: number }>) => {
  const { id, positions, thresholdDeg } = event.data;
  const edges = sharpEdges(positions, thresholdDeg);
  (self as unknown as Worker).postMessage({ id, edges }, [edges.buffer]);
};
