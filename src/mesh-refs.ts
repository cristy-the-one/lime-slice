/**
 * Meshes the engine already holds. A slice reply names each mesh it read,
 * `meshId` for the request's own mesh and `meshIds` by object id for a
 * plate's. The next request names the same bytes by `meshRef` instead of
 * sending them as `dataB64`. Ids are kept by the bytes' fingerprint, so
 * changed bytes are sent again. See docs/mesh-refs.md.
 */

/** `code` of the engine's reply to a `meshRef` it does not hold. */
export const UNKNOWN_MESH = "unknownMeshRef";

/** The engine restarted or evicted a mesh this request named. Send the bytes again. */
export class UnknownMeshRef extends Error {}

/** One mesh a request carried: the object it belongs to, absent for the request's own. */
export interface SentMesh {
  object?: string;
  fingerprint: string;
}

export interface MeshIdsReply {
  meshId?: string;
  meshIds?: Record<string, string>;
}

export type MeshFields = { meshRef: string } | { dataB64: string };

export class MeshRefs {
  private ids = new Map<string, string>();

  /** `meshRef` when the engine holds these bytes, else their `dataB64`. */
  fields(fingerprint: string, base64: () => string): MeshFields {
    const id = this.ids.get(fingerprint);
    return id ? { meshRef: id } : { dataB64: base64() };
  }

  /** Keep the ids `reply` gave the meshes the request carried. */
  note(reply: MeshIdsReply, sent: readonly SentMesh[]) {
    for (const mesh of sent) {
      const id = mesh.object === undefined ? reply.meshId : reply.meshIds?.[mesh.object];
      if (id) this.ids.set(mesh.fingerprint, id);
    }
  }

  forget() {
    this.ids.clear();
  }
}

/** The `UnknownMeshRef` an engine error body stands for, else `null`. */
export function unknownMeshRef(text: string): UnknownMeshRef | null {
  try {
    const body = JSON.parse(text) as { code?: unknown; error?: unknown };
    if (body?.code === UNKNOWN_MESH) return new UnknownMeshRef(typeof body.error === "string" ? body.error : UNKNOWN_MESH);
  } catch {
    /* not an engine error body */
  }
  return null;
}

/**
 * Send `request` with its meshes named where the engine holds them. An
 * unknown `meshRef` forgets every id and sends once more with the bytes.
 */
export async function sendWithMeshes<T extends MeshIdsReply>(
  refs: MeshRefs,
  attach: (refs: MeshRefs | null) => { body: Record<string, unknown>; sent: SentMesh[] },
  transport: (body: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const once = async (named: MeshRefs | null) => {
    const { body, sent } = attach(named);
    const reply = await transport(body);
    refs.note(reply, sent);
    return reply;
  };
  try {
    return await once(refs);
  } catch (err) {
    if (!(err instanceof UnknownMeshRef)) throw err;
    refs.forget();
    return once(null);
  }
}
