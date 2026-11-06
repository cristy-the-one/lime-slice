/**
 * How a `.lime` file is stored on disk (./project-pack.ts, where the encoding is described), read whole: the MCP server
 * and the tests save and open through here. `decodeProject` decodes the Model sections too (./project-model.ts). The
 * app's always-loaded code imports ./project-pack.ts instead, so Model's tree code stays out of its first chunk.
 */
import { decodeProjectWith } from "./project-pack.ts";
import { migrations, PROJECT_VERSION, type Migration, type ProjectResult } from "./project-envelope.ts";
import { modelSectionReader } from "./project-model.ts";

export * from "./project-pack.ts";

/** `parseProject` for the text of a file: version 3 as ever, or version 4 with its records unpacked first. */
export function decodeProject(text: string, steps: readonly Migration[] = migrations, target = PROJECT_VERSION): Promise<ProjectResult> {
  return decodeProjectWith(text, modelSectionReader, steps, target);
}
