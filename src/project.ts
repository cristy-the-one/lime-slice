/**
 * A `.lime` project, read whole: the envelope (./project-envelope.ts, where the format is described) with its Model
 * sections decoded by ./project-model.ts. The MCP server and the tests read and write projects through here. The app
 * reads the envelope alone and loads the Model reader only for a file that has Model sections, so its first chunk holds
 * none of Model's tree code: always-loaded app code imports ./project-envelope.ts, never this module.
 */
import { parseProjectDocWith, parseProjectWith, migrations, PROJECT_VERSION, type Migration, type ProjectResult } from "./project-envelope.ts";
import { modelSectionReader } from "./project-model.ts";

export * from "./project-envelope.ts";
export { modelSectionReader, piecesToCut, readModelSections } from "./project-model.ts";

export function parseProject(text: string, steps: readonly Migration[] = migrations, target = PROJECT_VERSION): ProjectResult {
  return parseProjectWith(text, modelSectionReader, steps, target);
}

/** `parseProject` for a document already parsed from JSON, with every binary record as `bytesBase64`. */
export function parseProjectDoc(raw: Record<string, unknown>, steps: readonly Migration[] = migrations, target = PROJECT_VERSION): ProjectResult {
  return parseProjectDocWith(raw, modelSectionReader, steps, target);
}
