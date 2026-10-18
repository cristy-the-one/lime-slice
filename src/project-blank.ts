/** What File > New puts back. Open uses the same dirty flag; this does not add another. */

export type SaveChoice = "save" | "discard" | "cancel";

/**
 * A clean document does not ask. A dirty one keeps the dialog's answer.
 * `null` is a dismissed dialog, which cancels.
 */
export function replaceChoice(dirty: boolean, answer: SaveChoice | null): SaveChoice {
  if (!dirty) return "discard";
  return answer ?? "cancel";
}

export interface BlankLaunch {
  /** Stage the window is in when New is chosen. Model stays, so a new solid can start there. */
  stage: string;
  layerHeight: number;
  profileName: string;
}

export interface BlankDocument {
  mesh: null;
  result: null;
  plateCount: 0;
  selectedId: null;
  title: null;
  dirty: false;
  query: "";
  poseHud: "";
  sectionOn: false;
  layer: 0;
  slicedHash: "";
  error: "";
  historySteps: 0;
  supportEdits: 0;
  paint: 0;
  layerActions: 0;
  printOrder: "all-at-once";
  layerHeight: number;
  profileName: string;
  stage: string;
}

/** The blank document. Settings and the printer name come from first launch, not from the file that was open. */
export function blankDocument(launch: BlankLaunch): BlankDocument {
  return {
    mesh: null,
    result: null,
    plateCount: 0,
    selectedId: null,
    title: null,
    dirty: false,
    query: "",
    poseHud: "",
    sectionOn: false,
    layer: 0,
    slicedHash: "",
    error: "",
    historySteps: 0,
    supportEdits: 0,
    paint: 0,
    layerActions: 0,
    printOrder: "all-at-once",
    layerHeight: launch.layerHeight,
    profileName: launch.profileName,
    stage: launch.stage === "model" ? "model" : "preview",
  };
}

/** Calibration towers are not part of a project. New drops them. */
export const LAUNCH_CALIBRATION = {
  paStart: 0,
  paEnd: 0.08,
  paStep: 0.005,
  paBands: [] as readonly unknown[],
  paGcode: "",
  flowStart: 0.9,
  flowEnd: 1.1,
  flowStep: 0.05,
  flowBands: [] as readonly unknown[],
  flowGcode: "",
  tempStart: 190,
  tempEnd: 230,
  tempStep: 5,
  tempBands: [] as readonly unknown[],
  tempGcode: "",
  retractStart: 0.2,
  retractEnd: 1.2,
  retractStep: 0.2,
  retractBands: [] as readonly unknown[],
  retractGcode: "",
};
