/// Build the compact preview off the main thread.
/// Layers arrive from the slice worker over a port; buffers go to the main thread.

import { buildWirePreview, type WireLayer } from "./preview-geom";

/** Layers as the engine sends them: paths in columns. `kinds` seeds the kind slots. */
interface WireRequest {
  id: number;
  layers: WireLayer[];
  min: number[];
  max: number[];
  kinds?: string[];
}

/** The slice worker's port, once, then builds from the main thread for partial previews. */
self.onmessage = (event: MessageEvent<{ slicePort: MessagePort } | WireRequest>) => {
  const msg = event.data;
  if ("slicePort" in msg) msg.slicePort.onmessage = (ev: MessageEvent<WireRequest>) => build(ev.data);
  else build(msg);
};

function build(msg: WireRequest) {
  const built = buildWirePreview(msg);
  const buffers = built.chunks.flatMap((c) => [c.beads.xyz.buffer, c.beads.style.buffer, c.beads.at.buffer, c.travel.xyz.buffer, c.travel.style.buffer, c.travel.at.buffer]);
  (self as unknown as Worker).postMessage({ id: msg.id, geom: built }, buffers);
}
