/** S6: the NURBS sculpt tool's code loads the first time the tool opens, not with Model. */
import { openModelTool } from "../../ui/model-chrome";

type Tool = typeof import("./nurbs-sculpt.ts");

let loading: Promise<Tool> | null = null;

/** The tool's module, loaded and installed once. */
export function nurbsTool(): Promise<Tool> {
  loading ??= import("./nurbs-sculpt.ts").then((tool) => {
    tool.installNurbsSculpt();
    return tool;
  });
  return loading;
}

/** The panel says the tool opened or closed: once its code is in, it follows every time. */
export function installNurbsStub() {
  document.addEventListener("lime-nurbs", () => {
    if (!loading && openModelTool() !== "sculpt") return;
    void nurbsTool().then((tool) => tool.syncNurbsTool());
  });
}
