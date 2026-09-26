/// Build one merged ribbon mesh plus travel lines off the main thread.
/// Layers arrive from the slice worker over a port; buffers go to the main thread.

import { buildPreviewGeometry, type GeomRequest } from "./preview-geom";
import { decodePaths, type PathColumns } from "./preview-wire";

/** Layers as the engine sends them: paths in columns. */
interface WireRequest extends Omit<GeomRequest, "layers"> {
  layers: { z: number; height?: number; paths: PathColumns }[];
}

export type { GeomPath, GeomLayer, GeomRequest } from "./preview-geom";

self.onmessage = (event: MessageEvent<{ slicePort: MessagePort }>) => {
  event.data.slicePort.onmessage = (ev: MessageEvent<WireRequest>) =>
    build({
      ...ev.data,
      layers: ev.data.layers.map((l) => ({ z: l.z, height: l.height, paths: decodePaths(l.paths, l.z) })),
    });
};

function build(msg: GeomRequest) {
  const built = buildPreviewGeometry(msg);
  const ribbonPos = new Float32Array(built.ribbon);
  const ribbonInfo = new Float32Array(built.ribbonInfo);
  const facePos = new Float32Array(built.face);
  const faceInfo = new Float32Array(built.faceInfo);
  const travelPos = new Float32Array(built.travel);
  const travelInfo = new Float32Array(built.travelInfo);
  const payload = { id: msg.id, ranges: built.ranges, kinds: built.kinds, ribbonPos, ribbonInfo, facePos, faceInfo, travelPos, travelInfo };
  (self as unknown as Worker).postMessage(payload, [
    ribbonPos.buffer,
    ribbonInfo.buffer,
    facePos.buffer,
    faceInfo.buffer,
    travelPos.buffer,
    travelInfo.buffer,
  ]);
}
