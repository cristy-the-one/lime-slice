import { MeshRefs, sendWithMeshes, UnknownMeshRef, unknownMeshRef, type SentMesh } from "./mesh-refs.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? "" : `got ${JSON.stringify(actual)}`);
}

const refs = new MeshRefs();
eq("an unnamed mesh is sent", refs.fields("f1", () => "QUJD"), { dataB64: "QUJD" });
refs.note({ meshId: "id1" }, [{ fingerprint: "f1" }]);
eq("a named mesh is referred to", refs.fields("f1", () => "QUJD"), { meshRef: "id1" });
eq("other bytes are still sent", refs.fields("f2", () => "REVG"), { dataB64: "REVG" });

refs.note({ meshIds: { a: "idA", b: "idB" } }, [
  { object: "a", fingerprint: "fa" },
  { object: "b", fingerprint: "fb" },
]);
eq("plate objects are named by object id", [refs.fields("fa", () => ""), refs.fields("fb", () => "")], [{ meshRef: "idA" }, { meshRef: "idB" }]);
refs.note({}, [{ fingerprint: "f3" }]);
eq("an engine that names nothing keeps the bytes coming", refs.fields("f3", () => "R0hJ"), { dataB64: "R0hJ" });
refs.forget();
eq("forgotten ids send the bytes again", refs.fields("f1", () => "QUJD"), { dataB64: "QUJD" });

check("the engine's unknown-mesh body is recognised", unknownMeshRef('{"error":"meshRef x is not held","code":"unknownMeshRef","meshRefs":["x"]}') instanceof UnknownMeshRef);
eq("another error body is not", unknownMeshRef('{"error":"mesh contains no triangles"}'), null);
eq("a plain message is not", unknownMeshRef("cancelled"), null);

async function main() {
  const engine = new Set<string>();
  const bodies: Record<string, unknown>[] = [];
  const transport = async (body: Record<string, unknown>) => {
    bodies.push(body);
    if (typeof body.meshRef === "string" && !engine.has(body.meshRef)) throw unknownMeshRef(JSON.stringify({ error: "gone", code: "unknownMeshRef" }))!;
    engine.add("id1");
    return { meshId: "id1" };
  };
  const attach = (named: MeshRefs | null) => {
    const sent: SentMesh[] = [{ fingerprint: "f1" }];
    return { body: { layerHeight: 0.2, ...(named ?? new MeshRefs()).fields("f1", () => "QUJD") }, sent };
  };
  const session = new MeshRefs();
  await sendWithMeshes(session, attach, transport);
  await sendWithMeshes(session, attach, transport);
  eq("the second request names the mesh", bodies.map((b) => ("meshRef" in b ? `ref:${b.meshRef}` : "data")), ["data", "ref:id1"]);

  engine.clear();
  bodies.length = 0;
  await sendWithMeshes(session, attach, transport);
  eq("a restarted engine gets the bytes once more", bodies.map((b) => ("meshRef" in b ? "ref" : "data")), ["ref", "data"]);
  await sendWithMeshes(session, attach, transport);
  eq("then the name again", bodies.map((b) => ("meshRef" in b ? "ref" : "data")), ["ref", "data", "ref"]);

  let thrown = "";
  try {
    await sendWithMeshes(session, attach, async () => {
      throw new Error("mesh contains no triangles");
    });
  } catch (err) {
    thrown = (err as Error).message;
  }
  eq("other failures are not retried", thrown, "mesh contains no triangles");

  if (failed) throw new Error(`${failed} mesh-refs checks failed`);
  console.log("mesh-refs ok");
}

void main();
