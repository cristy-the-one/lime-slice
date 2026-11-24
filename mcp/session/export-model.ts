/**
 * One export tool (docs/plan-export-and-linking.md D8).
 * Assembly formats call pose_export's writer. A part's STEP calls exportStep. Print-layout 3MF calls export3mf.
 * Print-layout STL uses the same STL encoder as a mesh on the bed.
 */
import { writeFileSync } from "node:fs";
import { zipSync } from "fflate";
import type { Assembly } from "../../src/assembly.ts";
import { formatsFor, plateAssembled, type ExportFormat, type ExportScope } from "../../src/export-scope.ts";
import { encodeStl } from "../../src/mesh-place.ts";
import { IDENTITY_POSE, type Affine } from "../../src/model-space.ts";
import { NEXT, refuse } from "../refusals.ts";
import { resolveWrite } from "../workspace.ts";
import type { Session } from "../session.ts";
import { writePoseAssembly } from "./pose-export.ts";
import { openSheetRefusal } from "./sheet.ts";
import type { CallMeta, ToolHandler } from "./shared.ts";

const SCOPES = new Set<ExportScope>(["part", "assembly", "plate-assembled", "plate-print"]);

async function exportModel(this: Session, input: Record<string, unknown>, meta?: CallMeta): Promise<Record<string, unknown>> {
  const scope = typeof input.scope === "string" ? input.scope : "";
  if (!SCOPES.has(scope as ExportScope)) {
    return refuse("bad-argument", "scope must be one of part, assembly, plate-assembled, plate-print.");
  }
  const format = typeof input.format === "string" ? input.format : "";
  const allowed = formatsFor(scope as ExportScope);
  if (!allowed.includes(format as ExportFormat)) {
    return refuse("bad-argument", `format must be one of ${allowed.join(", ")} for scope ${scope}.`);
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return refuse("bad-argument", "name is the file to write.");

  if (scope === "plate-print" && format === "3mf") return this.export3mf(name);
  if (scope === "plate-print") return exportPrintStl(this, name, input.stl === "each" ? "each" : "one");
  if (scope === "part" && format === "step") {
    const obj = partOf(this, input.object);
    if (!obj) return refuse("no-object", "Select a part to export, or pass object.", undefined, NEXT.plate);
    return this.exportStep(obj, name);
  }
  if (scope === "assembly") {
    return this.poseExport({
      assembly: input.assembly,
      format,
      frame: input.frame,
      animation: input.animation,
      path: name,
      chordMm: input.chordMm,
      step: input.step,
      stl: input.stl,
    }, meta);
  }
  if (scope === "part") {
    const obj = partOf(this, input.object);
    if (!obj) return refuse("no-object", "Select a part to export, or pass object.", undefined, NEXT.plate);
    const assembly: Assembly = {
      id: "part",
      name: obj.name,
      members: [{ object: obj.id, parent: null, offset: [0, 0, 0], turn: [0, 0, 0] }],
    };
    return writePoseAssembly.call(this, assembly, { ...input, format, path: name }, meta, new Map<string, Affine>([[obj.id, IDENTITY_POSE]]));
  }

  const present = new Set(this.objects.map((obj) => obj.id));
  const assemblies = this.assemblies
    .map((assembly) => ({ ...assembly, members: assembly.members.filter((member) => present.has(member.object)) }))
    .filter((assembly) => assembly.members.length > 0);
  const built = plateAssembled(this.objects.map((obj) => ({ id: obj.id, modelPose: obj.modelPose })), assemblies);
  if (!built.assembly.members.length) return refuse("plate-empty", "The plate is empty.", undefined, NEXT.empty);
  return writePoseAssembly.call(this, built.assembly, { ...input, format, path: name }, meta, built.poses);
}

function partOf(session: Session, object: unknown) {
  if (typeof object === "string" && object) return session.find(object) ?? null;
  return session.selectedObject();
}

async function exportPrintStl(session: Session, name: string, mode: "one" | "each"): Promise<Record<string, unknown>> {
  if (session.objects.length === 0) return refuse("plate-empty", "The plate is empty.", undefined, NEXT.empty);
  const refused = (await session.commitAll())[0];
  if (refused) return refuse("commit-failed", `${refused.name} (${refused.object}): ${refused.reason}`, { object: refused.object });
  const sheet = openSheetRefusal(session.objects, "exported to STL");
  if (sheet) return sheet;
  const parts = session.objects.map((obj) => ({
    name: obj.name.replace(/\.(stl|3mf|step|stp)$/i, "") || obj.id,
    positions: session.placed(obj).positions,
  }));
  let bytes: Uint8Array;
  let ext = ".stl";
  if (mode === "each" && parts.length > 1) {
    const files: Record<string, Uint8Array> = {};
    for (const part of parts) {
      let file = `${part.name}.stl`;
      let n = 2;
      while (files[file]) file = `${part.name}-${n++}.stl`;
      files[file] = new Uint8Array(encodeStl(part.positions, part.name));
    }
    bytes = zipSync(files, { level: 6 });
    ext = ".zip";
  } else {
    const total = parts.reduce((sum, part) => sum + part.positions.length, 0);
    const combined = new Float32Array(total);
    let at = 0;
    for (const part of parts) {
      combined.set(part.positions, at);
      at += part.positions.length;
    }
    bytes = new Uint8Array(encodeStl(combined, "plate"));
  }
  const path = resolveWrite(name, ext);
  writeFileSync(path, bytes);
  return {
    ok: true,
    path,
    bytes: bytes.byteLength,
    format: "stl",
    note: `Wrote ${parts.length} object${parts.length === 1 ? "" : "s"} as ${mode === "each" && parts.length > 1 ? "STL ZIP" : "STL"}.`,
  };
}

export const exportModelMethods = { exportModel };
export const exportModelHandlers: Record<string, ToolHandler> = {
  export: (session, input, meta) => session.exportModel(input, meta),
};
