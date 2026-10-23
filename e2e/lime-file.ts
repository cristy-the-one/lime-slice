import { gunzipSync } from "node:zlib";

type Row = Record<string, unknown>;

/**
 * A saved `.lime` as a spec reads it: the same JSON with every version 4 binary record (`encoding`, `data`) unpacked to
 * `bytesBase64`, as version 3 wrote it. Unpacked with Node's zlib, not the app's own reader, so a spec that reopens the
 * raw file still tests the app's reader, and one that reads the unpacked copy sees the bytes the file holds.
 */
export function unpackLime(file: Buffer): Buffer {
  const doc = JSON.parse(file.toString("utf8")) as Row;
  const holders = [...((doc.objects as Row[] | undefined) ?? []), ...((doc.modelTools as Row[] | undefined) ?? []), ...((doc.heldPieces as Row[] | undefined) ?? [])];
  for (const holder of holders) {
    const tree = holder.modelTree as Row | undefined;
    for (const record of [holder.mesh, holder.brep, tree?.rootStep] as (Row | undefined)[]) {
      if (record?.encoding !== "gzip+base64") continue;
      record.bytesBase64 = gunzipSync(Buffer.from(String(record.data), "base64")).toString("base64");
      delete record.encoding;
      delete record.data;
    }
  }
  return Buffer.from(JSON.stringify(doc));
}
