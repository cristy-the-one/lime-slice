import { labelFaceRegions, REGION_THRESHOLD_DEG } from "./edge-strip";

self.onmessage = (event: MessageEvent<{ id: number; positions: Float32Array }>) => {
  const { id, positions } = event.data;
  const { ids, twin, region, count } = labelFaceRegions(positions, REGION_THRESHOLD_DEG);
  (self as unknown as Worker).postMessage({ id, ids, twin, region, count }, [ids.buffer, twin.buffer, region.buffer]);
};
