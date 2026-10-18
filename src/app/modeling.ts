/**
 * The modelling helpers the MCP server uses, in the app bundle.
 * Later Model tools call them. Nothing here changes what the app does today.
 */
import { hasAnchor } from "../modeling/anchors.ts";
import { expand, isComposite } from "../modeling/compose.ts";
import { evaluate } from "../modeling/expr.ts";
import { expandOps } from "../modeling/macro.ts";
import { sweepSections } from "../modeling/sweep.ts";
import { textStrokes } from "../modeling/text.ts";
import { thinWalls } from "../modeling/thin.ts";

/** True when every shared helper loaded. Keeps each one in the browser bundle. */
export const modelingReady =
  typeof hasAnchor === "function" &&
  typeof expand === "function" &&
  typeof isComposite === "function" &&
  typeof evaluate === "function" &&
  typeof expandOps === "function" &&
  typeof sweepSections === "function" &&
  typeof textStrokes === "function" &&
  typeof thinWalls === "function";
