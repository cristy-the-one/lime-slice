/// Build one merged ribbon mesh plus travel lines off the main thread.
/// Layers arrive from the slice worker over a port; buffers go to the main thread.

import { buildWirePreview, type WireLayer } from "./preview-geom";

export type { GeomPath, GeomLayer, GeomRequest } from "./preview-geom";

/** Layers as the engine sends them: paths in columns. */
interface WireRequest {
  id: number;
  layers: WireLayer[];
  min: number[];
  max: number[];
}

self.onmessage = (event: MessageEvent<{ slicePort: MessagePort }>) => {
  event.data.slicePort.onmessage = (ev: MessageEvent<WireRequest>) => build(ev.data);
};

function build(msg: WireRequest) {
  const built = buildWirePreview(msg);
  const payload = {
    id: msg.id,
    ranges: built.ranges,
    kinds: built.kinds,
    ribbonPos: built.ribbon,
    ribbonInfo: built.ribbonInfo,
    facePos: built.face,
    faceInfo: built.faceInfo,
    travelPos: built.travel,
    travelInfo: built.travelInfo,
  };
  (self as unknown as Worker).postMessage(payload, [
    built.ribbon.buffer,
    built.ribbonInfo.buffer,
    built.face.buffer,
    built.faceInfo.buffer,
    built.travel.buffer,
    built.travelInfo.buffer,
  ]);
}
