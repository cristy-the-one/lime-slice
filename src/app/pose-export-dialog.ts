/**
 * Pose's Export… buttons open the one Export dialog, already filled in on this assembly
 * (docs/plan-export-and-linking.md D4). The writers live in that dialog.
 */
import type { PoseAnimationState } from "./pose.ts";

export interface PoseExportContext {
  assemblyId?: string;
  animation: PoseAnimationState | null;
  animationTitle?: string;
  frameIndex?: number;
}

export function showPoseExport(context: PoseExportContext): void {
  void import("./export-dialog.ts").then(({ showExport }) => {
    showExport({
      scope: "assembly",
      format: "step",
      explicitFormat: true,
      assemblyId: context.assemblyId ?? context.animation?.assembly,
      animation: context.animation,
      animationTitle: context.animationTitle,
      frameIndex: context.frameIndex,
      preferFrame: true,
    });
  });
}
