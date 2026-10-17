/**
 * The release this server belongs to. The bundle has it baked in; a checkout reads package.json.
 */
import { readFileSync } from "node:fs";

/** Set by `tools/mcp/bundle.mjs`. A checkout runs the TypeScript and reads package.json instead. */
declare const __LIME_MCP_VERSION__: string | undefined;

export function appVersion(): string {
  if (typeof __LIME_MCP_VERSION__ === "string") return __LIME_MCP_VERSION__;
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}
