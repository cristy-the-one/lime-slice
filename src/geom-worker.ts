/// Build one merged ribbon mesh plus travel lines off the main thread.

import { buildPreviewGeometry, type GeomRequest } from "./preview-geom";

export type { GeomPath, GeomLayer, GeomRequest } from "./preview-geom";

self.onmessage = (event: MessageEvent<GeomRequest>) => {
  const msg = event.data;
  const built = buildPreviewGeometry(msg);
  const ribbonPos = new Float32Array(built.ribbon);
  const ribbonCol = new Float32Array(built.ribbonColor);
  const facePos = new Float32Array(built.face);
  const faceCol = new Float32Array(built.faceColor);
  const travelPos = new Float32Array(built.travel);
  const travelCol = new Float32Array(built.travelColor);
  const payload = { id: msg.id, ranges: built.ranges, ribbonPos, ribbonCol, facePos, faceCol, travelPos, travelCol };
  (self as unknown as Worker).postMessage(payload, [
    ribbonPos.buffer,
    ribbonCol.buffer,
    facePos.buffer,
    faceCol.buffer,
    travelPos.buffer,
    travelCol.buffer,
  ]);
};
