/**
 * How a `.lime` file is stored on disk: version 4 keeps its settings, history, and parameters as readable JSON text, and
 * its big binary records compressed. The app (browser and Tauri) and the MCP server (Node) both save and open through
 * these two functions, so they read and write the same bytes.
 *
 * A binary record is a plate object's `mesh`, its `brep` (the solid), and a `modelTree.rootStep` that carries its bytes.
 * In `src/project.ts` such a record holds `bytesBase64`. On disk it keeps `name`, `byteLength`, and `hash` (of the
 * original bytes, as ever) and holds the bytes as
 *
 *   { "encoding": "gzip+base64", "data": "<base64 of the gzip stream>" }
 *
 * in place of `bytesBase64`. `encoding` names how `data` turns back into bytes, so a later format can change it:
 *   - `gzip+base64`: base64, then gzip.
 *   - `base64`: the bytes as they are, base64. Written only where the platform has no `CompressionStream`.
 * A record with `bytesBase64` (a version 3 file) is read as it was. An encoding this code does not know is refused by name.
 * Compression is the platform's own: `CompressionStream` / `DecompressionStream` (WebView2, WebKitGTK, WKWebView, Node).
 */
import { base64ToBytes, bytesToBase64 } from "./base64.ts";
import { parseProjectDoc, projectWire, type LimeProject, type Migration, type ProjectResult, migrations, PROJECT_VERSION } from "./project.ts";

export const ENCODING_GZIP = "gzip+base64";
export const ENCODING_PLAIN = "base64";

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);

/** True where the platform can compress and decompress gzip. */
export function canCompress(): boolean {
  return typeof CompressionStream === "function" && typeof DecompressionStream === "function";
}

async function through(bytes: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const source = new Blob([bytes as BlobPart]).stream() as ReadableStream<Uint8Array>;
  const out = source.pipeThrough(transform as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export const gzip = (bytes: Uint8Array) => through(bytes, new CompressionStream("gzip"));
export const gunzip = (bytes: Uint8Array) => through(bytes, new DecompressionStream("gzip"));

/** The records of a wire document that hold bytes, in file order. */
function binaryRecords(wire: Row): Row[] {
  const out: Row[] = [];
  const take = (value: unknown) => {
    if (isRow(value)) out.push(value);
  };
  const holders = [...(Array.isArray(wire.objects) ? wire.objects : []), ...(Array.isArray(wire.modelTools) ? wire.modelTools : [])];
  for (const holder of holders) {
    if (!isRow(holder)) continue;
    take(holder.mesh);
    take(holder.brep);
    if (isRow(holder.modelTree)) take(holder.modelTree.rootStep);
  }
  return out;
}

/** The text of a project file: version 4, its binary records compressed. */
export async function encodeProject(project: LimeProject): Promise<string> {
  const wire = projectWire(project);
  const compress = canCompress();
  // Records are rewritten in place on this copy of the wire: `projectWire` built every holder object fresh, and a record
  // it shares with the project is replaced here by a new one rather than changed.
  const swaps = new Map<Row, Row>();
  await Promise.all(
    binaryRecords(wire).map(async (record) => {
      if (typeof record.bytesBase64 !== "string") return;
      const { bytesBase64, ...rest } = record;
      if (!compress) {
        swaps.set(record, { ...rest, encoding: ENCODING_PLAIN, data: bytesBase64 });
        return;
      }
      const bytes = base64ToBytes(bytesBase64);
      if (!bytes) return;
      swaps.set(record, { ...rest, encoding: ENCODING_GZIP, data: bytesToBase64(await gzip(bytes)) });
    }),
  );
  const replaced = (value: unknown) => (isRow(value) ? (swaps.get(value) ?? value) : value);
  const swapHolder = (holder: unknown) => {
    if (!isRow(holder)) return holder;
    const next: Row = { ...holder };
    if ("mesh" in next) next.mesh = replaced(next.mesh);
    if ("brep" in next) next.brep = replaced(next.brep);
    if (isRow(next.modelTree) && isRow(next.modelTree.rootStep)) next.modelTree = { ...next.modelTree, rootStep: replaced(next.modelTree.rootStep) };
    return next;
  };
  for (const key of ["objects", "modelTools"]) {
    const rows = wire[key];
    if (Array.isArray(rows)) wire[key] = rows.map(swapHolder);
  }
  return JSON.stringify(wire, null, 2);
}

/** Turn every encoded record of a parsed document back into `bytesBase64`. A damaged one loses its bytes and reads as damaged. */
async function inflateRecords(doc: Row): Promise<string | null> {
  const state: { refused: string | null } = { refused: null };
  await Promise.all(
    binaryRecords(doc).map(async (record) => {
      if (record.encoding === undefined && record.data === undefined) return;
      const { encoding, data, ...rest } = record;
      for (const key of Object.keys(record)) delete record[key];
      Object.assign(record, rest);
      if (encoding === ENCODING_PLAIN && typeof data === "string") {
        record.bytesBase64 = data;
      } else if (encoding === ENCODING_GZIP) {
        const packed = typeof data === "string" ? base64ToBytes(data) : null;
        if (!packed) return;
        if (!canCompress()) {
          state.refused = "This project is compressed, and this system cannot unpack it.";
          return;
        }
        try {
          record.bytesBase64 = bytesToBase64(await gunzip(packed));
        } catch {
          // Left without bytes: the reader says the mesh or the solid is damaged.
        }
      } else {
        state.refused = `This project stores its data as "${String(encoding)}", which this app does not know. Update the app to open it.`;
      }
    }),
  );
  return state.refused;
}

/**
 * The JSON of a file with its binary records unpacked to `bytesBase64`, for a test or a tool that reads the document
 * itself. Throws on text that is not JSON.
 */
export async function plainDocument(text: string): Promise<Record<string, unknown>> {
  const doc = JSON.parse(text) as Record<string, unknown>;
  await inflateRecords(doc);
  return doc;
}

/** `parseProject` for the text of a file: version 3 as ever, or version 4 with its records unpacked first. */
export async function decodeProject(text: string, steps: readonly Migration[] = migrations, target = PROJECT_VERSION): Promise<ProjectResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: "This file is not a Lime Slice project." };
  }
  if (!isRow(raw)) return { ok: false, message: "This file is not a Lime Slice project." };
  const refused = await inflateRecords(raw);
  if (refused) return { ok: false, message: refused };
  return parseProjectDoc(raw, steps, target);
}
