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
import { base64ToBytes, bytesToBase64Async } from "./base64.ts";
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

/** At most this many records are packed or unpacked at once: each holds its bytes, its stream, and its text. */
const CONCURRENCY = 3;

async function eachLimited<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    for (let i = next++; i < items.length; i = next++) await work(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, lane));
}

/** A project taken for writing: everything but the packing is already fixed, so later changes to the project do not reach it. */
export interface PreparedProject {
  wire: Row;
  /** The records to pack, each paired with the base64 text of its bytes. */
  jobs: { record: Row; bytesBase64: string }[];
}

/**
 * The synchronous half of `encodeProject`: the document as a value, each binary record standing as a named record with
 * empty `data`, beside the bytes it will hold. The document is a copy, so a caller that packs later (an autosave queued
 * behind a write) writes the project as it was now.
 */
export function prepareProject(project: LimeProject): PreparedProject {
  const wire = projectWire(project);
  const sources = new Map<Row, string>();
  // `projectWire` built every holder fresh, but a record it shares with the project is replaced here, never changed.
  const swaps = new Map<Row, Row>();
  for (const record of binaryRecords(wire)) {
    if (typeof record.bytesBase64 !== "string" || swaps.has(record)) continue;
    const { bytesBase64, ...rest } = record;
    const stand: Row = { ...rest, encoding: canCompress() ? ENCODING_GZIP : ENCODING_PLAIN, data: "" };
    swaps.set(record, stand);
    sources.set(stand, bytesBase64);
  }
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
  // The stand-ins hold no bytes, so copying the document now is cheap, and nothing in it can change afterwards.
  const copy = structuredClone(wire);
  // A record two objects share is one record in the copy too (a clone keeps shared references), packed once.
  const jobs: PreparedProject["jobs"] = [];
  const queued = new Set<Row>();
  const originals = binaryRecords(wire);
  binaryRecords(copy).forEach((record, i) => {
    const bytesBase64 = sources.get(originals[i]!);
    if (bytesBase64 === undefined || queued.has(record)) return;
    queued.add(record);
    jobs.push({ record, bytesBase64 });
  });
  return { wire: copy, jobs };
}

/** The asynchronous half: pack each record, then write the text. */
export async function finishProject(prepared: PreparedProject): Promise<string> {
  await eachLimited(prepared.jobs, async ({ record, bytesBase64 }) => {
    if (record.encoding === ENCODING_PLAIN) {
      record.data = bytesBase64;
      return;
    }
    const bytes = base64ToBytes(bytesBase64);
    if (!bytes) {
      // Not base64: written as it is, for the reader to call damaged, as version 3 did.
      record.encoding = ENCODING_PLAIN;
      record.data = bytesBase64;
      return;
    }
    record.data = await bytesToBase64Async(await gzip(bytes));
  });
  return JSON.stringify(prepared.wire, null, 2);
}

/** The text of a project file: version 4, its binary records compressed. */
export const encodeProject = (project: LimeProject): Promise<string> => finishProject(prepareProject(project));

/** Turn every encoded record of a parsed document back into `bytesBase64`. A damaged one loses its bytes and reads as damaged. */
async function inflateRecords(doc: Row): Promise<string | null> {
  const state: { refused: string | null } = { refused: null };
  await eachLimited([...new Set(binaryRecords(doc))], async (record) => {
    if (record.encoding === undefined && record.data === undefined) return;
    const { encoding, data, ...rest } = record;
    for (const key of Object.keys(record)) delete record[key];
    Object.assign(record, rest);
    if (encoding === ENCODING_PLAIN) {
      if (typeof data === "string") record.bytesBase64 = data;
    } else if (encoding === ENCODING_GZIP) {
      const packed = typeof data === "string" ? base64ToBytes(data) : null;
      if (!packed) return;
      if (!canCompress()) {
        state.refused = "This project is compressed, and this system cannot unpack it.";
        return;
      }
      try {
        record.bytesBase64 = await bytesToBase64Async(await gunzip(packed));
      } catch {
        // Left without bytes: the reader says the mesh or the solid is damaged.
      }
    } else {
      state.refused = `This project stores its data as "${String(encoding)}", which this app does not know. Update the app to open it.`;
    }
  });
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
  // A file from a newer app is refused by its version, before anything in it is unpacked.
  if (typeof raw.version === "number" && raw.version > target) return parseProjectDoc(raw, steps, target);
  const refused = await inflateRecords(raw);
  if (refused) return { ok: false, message: refused };
  return parseProjectDoc(raw, steps, target);
}
