/**
 * What one Export writes (docs/plan-export-and-linking.md D1, D2).
 * The dialog, the commands and the MCP tool all read this: the scope follows the selection,
 * each scope has its formats, and a free part is a top-level member of the plate at its modelPose.
 */
import { type Assembly, type Member } from "./assembly.ts";
import { IDENTITY_POSE, type Affine } from "./model-space.ts";

export { exportCommandReason, type ExportAvailability, type ExportCommandId } from "./export-reason.ts";

export type ExportScope = "part" | "assembly" | "plate-assembled" | "plate-print";
export type ExportFormat = "step" | "stl" | "3mf" | "obj" | "glb" | "pose";

export const SCOPE_LABELS: Record<ExportScope, string> = {
  part: "Selected part",
  assembly: "Assembly",
  "plate-assembled": "Plate, assembled",
  "plate-print": "Plate, print layout",
};

export const EXPORT_SCOPES: readonly ExportScope[] = ["part", "assembly", "plate-assembled", "plate-print"];

const FORMATS: Record<ExportScope, readonly ExportFormat[]> = {
  part: ["step", "stl", "3mf", "obj", "glb"],
  assembly: ["step", "glb", "3mf", "stl", "obj", "pose"],
  "plate-assembled": ["step", "glb", "3mf", "stl", "obj", "pose"],
  "plate-print": ["3mf", "stl"],
};

export function formatsFor(scope: ExportScope): readonly ExportFormat[] {
  return FORMATS[scope];
}

export function defaultFormat(scope: ExportScope): ExportFormat {
  return FORMATS[scope][0]!;
}

/** The last format chosen for each scope during this session. A new session starts from each scope's first format. */
const remembered = new Map<ExportScope, ExportFormat>();

export function resetFormatMemory(): void {
  remembered.clear();
}

export function rememberFormat(scope: ExportScope, format: ExportFormat): void {
  if (FORMATS[scope].includes(format)) remembered.set(scope, format);
}

export function formatFor(scope: ExportScope): ExportFormat {
  const kept = remembered.get(scope);
  return kept && FORMATS[scope].includes(kept) ? kept : defaultFormat(scope);
}

export interface ScopeSelection {
  selectedId: string | null;
  /** The assembly the selected object belongs to, when it is a member. */
  memberOf: string | null;
}

/** A member selects its assembly, a free part selects itself, and nothing selected selects the assembled plate. */
export function defaultScope(selection: ScopeSelection): ExportScope {
  if (selection.memberOf) return "assembly";
  if (selection.selectedId) return "part";
  return "plate-assembled";
}

export interface LoosePart {
  id: string;
  modelPose?: Affine;
}

/**
 * The plate as one assembly (D2): each existing assembly stays a sub-tree, and each free part is a top-level
 * member at its modelPose with no joint. The returned poses are those modelPoses.
 */
export function plateAssembled(parts: readonly LoosePart[], assemblies: readonly Assembly[]): { assembly: Assembly; poses: Map<string, Affine> } {
  const claimed = new Set(assemblies.flatMap((assembly) => assembly.members.map((member) => member.object)));
  const members: Member[] = [];
  const poses = new Map<string, Affine>();
  for (const assembly of assemblies) {
    for (const member of assembly.members) members.push({ ...member });
  }
  for (const part of parts) {
    const pose = part.modelPose ?? IDENTITY_POSE;
    poses.set(part.id, pose);
    if (claimed.has(part.id)) continue;
    members.push({ object: part.id, parent: null, offset: [0, 0, 0], turn: [0, 0, 0] });
  }
  return { assembly: { id: "plate", name: "Plate", members }, poses };
}
