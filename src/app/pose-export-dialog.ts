/**
 * Pose Export dialog (docs/plan-pose-export.md, D5).
 * Lazy-loaded when the person presses Export… in Pose so the first chunk does not grow.
 * Exports the chosen assembly at its current pose or at the animation frame the player is stopped on,
 * in STEP (AP242 tree or flat), glTF binary (.glb, optionally with the active animation), 3MF assembly,
 * STL (one file or a ZIP per member), OBJ + MTL, or Pose sheet (.json). Never mutates the assembly.
 */
import type { Assembly } from "../assembly.ts";
import { IDENTITY_POSE, type Affine } from "../model-space.ts";
import { meshSeat, meshTokenOf, modelPoseOf } from "../plate.ts";
import {
  configLabel,
  defaultMemberColor,
  encodePose3mf,
  encodePoseGlb,
  encodePoseObjMtl,
  encodePoseSheet,
  encodePoseStl,
  orderExportMembers,
  poseExportFileName,
  type PoseExportConfig,
  type PoseExportFormat,
} from "../pose-export.ts";
import { pushToast } from "../ui/toasts.ts";
import { liveAssemblies } from "./assemblies.ts";
import { livePlate } from "./files.ts";
import { saveBytes, saveBytesToFolder } from "./save-bytes.ts";
import { state } from "./state.ts";
import { loadModel, modelApi } from "./workspaces.ts";
import type { PoseAnimationState } from "./pose.ts";

export interface PoseExportContext {
  assemblyId?: string;
  animation: PoseAnimationState | null;
  animationTitle?: string;
  frameIndex?: number;
}

const FORMATS: readonly [PoseExportFormat, string][] = [
  ["step", "STEP (.step)"],
  ["glb", "glTF binary (.glb)"],
  ["3mf", "3MF assembly (.3mf)"],
  ["stl", "STL (.stl)"],
  ["obj", "OBJ + MTL (.obj)"],
  ["pose", "Pose sheet (.json)"],
];

const MESH_FORMATS = new Set<PoseExportFormat>(["glb", "3mf", "stl", "obj"]);

function partPositionsInOwnFrame(sourcePos: Float32Array, seat: number): Float32Array {
  if (!seat) return sourcePos;
  const shifted = sourcePos.slice();
  for (let i = 2; i < shifted.length; i += 3) shifted[i] = shifted[i]! + seat;
  return shifted;
}

export function showPoseExport(context: PoseExportContext): void {
  const assemblies = liveAssemblies();
  if (!assemblies.length) {
    pushToast("There is no assembly to export.", "error");
    return;
  }

  const dialog = document.createElement("dialog");
  dialog.className = "pose-animation-save pose-export-dialog";
  dialog.setAttribute("aria-label", "Export pose");
  dialog.dataset.poseExportDialog = "";

  const heading = document.createElement("h2");
  heading.textContent = "Export pose";
  dialog.append(heading);

  const addRow = (labelText: string, control: HTMLElement): HTMLLabelElement => {
    const wrap = document.createElement("label");
    wrap.textContent = labelText;
    wrap.append(control);
    dialog.append(wrap);
    return wrap;
  };

  // Assembly picker
  const assemblySelect = document.createElement("select");
  assemblySelect.setAttribute("aria-label", "Assembly");
  assemblySelect.dataset.poseExport = "assembly";
  for (const row of assemblies) {
    const opt = document.createElement("option");
    opt.value = row.id;
    opt.textContent = row.name;
    assemblySelect.append(opt);
  }
  const initialAssembly =
    (context.assemblyId && assemblies.some((a) => a.id === context.assemblyId) && context.assemblyId)
    || (context.animation && assemblies.some((a) => a.id === context.animation!.assembly) && context.animation.assembly)
    || assemblies[0]!.id;
  assemblySelect.value = initialAssembly;
  addRow("Assembly", assemblySelect);

  // Configuration picker (Now, or active animation frame)
  const configSelect = document.createElement("select");
  configSelect.setAttribute("aria-label", "Configuration");
  configSelect.dataset.poseExport = "config";
  addRow("Configuration", configSelect);

  // Format picker
  const formatSelect = document.createElement("select");
  formatSelect.setAttribute("aria-label", "Format");
  formatSelect.dataset.poseExport = "format";
  for (const [value, label] of FORMATS) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    formatSelect.append(opt);
  }
  formatSelect.value = "step";
  addRow("Format", formatSelect);

  // STEP option: Assembly tree (AP242) vs Flat (7.0)
  const stepLayoutSelect = document.createElement("select");
  stepLayoutSelect.setAttribute("aria-label", "STEP layout");
  stepLayoutSelect.dataset.poseExport = "step";
  for (const [value, label] of [["tree", "Assembly tree (AP242)"], ["flat", "Flat (one solid per part)"]]) {
    const opt = document.createElement("option");
    opt.value = value!;
    opt.textContent = label!;
    stepLayoutSelect.append(opt);
  }
  const stepRow = addRow("STEP structure", stepLayoutSelect);

  // GLB option: Include animation
  const includeAnimInput = document.createElement("input");
  includeAnimInput.type = "checkbox";
  includeAnimInput.setAttribute("aria-label", "Include animation");
  includeAnimInput.dataset.poseExport = "animation";
  const animRow = addRow("Include animation", includeAnimInput);

  // STL option: One file vs One STL per member (.zip)
  const stlModeSelect = document.createElement("select");
  stlModeSelect.setAttribute("aria-label", "STL layout");
  stlModeSelect.dataset.poseExport = "stl";
  for (const [value, label] of [["one", "One file"], ["each", "One STL per member (.zip)"]]) {
    const opt = document.createElement("option");
    opt.value = value!;
    opt.textContent = label!;
    stlModeSelect.append(opt);
  }
  const stlRow = addRow("STL layout", stlModeSelect);

  // Mesh detail (chord tolerance in mm, 0.01 to 1)
  const chordInput = document.createElement("input");
  chordInput.type = "number";
  chordInput.min = "0.01";
  chordInput.max = "1";
  chordInput.step = "0.01";
  const defaultChord = Math.min(1, Math.max(0.01, state.stepTolerance || 0.05));
  chordInput.value = String(defaultChord);
  chordInput.setAttribute("aria-label", "Mesh detail (mm)");
  chordInput.dataset.poseExport = "chord";
  const chordRow = addRow("Mesh detail (mm)", chordInput);

  // File name
  const fileNameInput = document.createElement("input");
  fileNameInput.type = "text";
  fileNameInput.setAttribute("aria-label", "File name");
  fileNameInput.dataset.poseExport = "filename";
  addRow("File name", fileNameInput);

  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.dataset.poseExportStatus = "";
  dialog.append(status);

  const actions = document.createElement("div");
  actions.className = "pose-buttons";
  dialog.append(actions);

  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.className = "btn";
  exportBtn.textContent = "Export";
  exportBtn.dataset.poseExportAction = "submit";
  actions.append(exportBtn);

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.dataset.poseExportAction = "cancel";
  actions.append(cancelBtn);

  let customName = false;
  fileNameInput.addEventListener("input", () => {
    customName = fileNameInput.value.trim().length > 0;
  });

  const activeAssembly = (): Assembly | undefined =>
    liveAssemblies().find((row) => row.id === assemblySelect.value);

  const matchingAnimation = (): { anim: PoseAnimationState; frameIndex: number; title: string; timeS: number } | null => {
    const anim = context.animation;
    if (!anim || anim.assembly !== assemblySelect.value) return null;
    const count = anim.result.frames.length;
    if (count === 0) return null;
    const idx = Math.max(0, Math.min(count - 1, context.frameIndex ?? anim.clock.frame(performance.now())));
    const frame = anim.result.frames[idx]!;
    const title = context.animationTitle || anim.plugin.name || "Animation";
    return { anim, frameIndex: idx, title, timeS: frame.time };
  };

  const currentConfig = (): PoseExportConfig => {
    const matched = configSelect.value === "frame" ? matchingAnimation() : null;
    return matched
      ? { kind: "frame", animation: matched.title, frameIndex: matched.frameIndex, timeS: matched.timeS }
      : { kind: "now" };
  };

  const refreshConfig = (preferFrame: boolean) => {
    const prev = configSelect.value;
    configSelect.replaceChildren();
    const nowOpt = document.createElement("option");
    nowOpt.value = "now";
    nowOpt.textContent = "Now";
    configSelect.append(nowOpt);
    const matched = matchingAnimation();
    if (matched) {
      const frameOpt = document.createElement("option");
      frameOpt.value = "frame";
      frameOpt.textContent = configLabel({ kind: "frame", animation: matched.title, frameIndex: matched.frameIndex, timeS: matched.timeS });
      configSelect.append(frameOpt);
      configSelect.value = preferFrame || prev === "frame" ? "frame" : "now";
      includeAnimInput.checked = true;
    } else {
      configSelect.value = "now";
      includeAnimInput.checked = false;
    }
  };

  const refreshFileName = (force = false) => {
    if (customName && !force) return;
    const asm = activeAssembly();
    if (!asm) return;
    const fmt = formatSelect.value as PoseExportFormat;
    const stlMode = stlModeSelect.value === "each" ? "each" : "one";
    fileNameInput.value = poseExportFileName(asm.name, fmt, currentConfig(), stlMode);
  };

  const syncVisibility = () => {
    const fmt = formatSelect.value as PoseExportFormat;
    const matched = matchingAnimation();
    stepRow.hidden = fmt !== "step";
    animRow.hidden = fmt !== "glb" || !matched;
    stlRow.hidden = fmt !== "stl";
    chordRow.hidden = !MESH_FORMATS.has(fmt);
  };

  refreshConfig(true);
  syncVisibility();
  refreshFileName(true);

  assemblySelect.addEventListener("change", () => {
    refreshConfig(true);
    syncVisibility();
    customName = false;
    refreshFileName(true);
  });
  configSelect.addEventListener("change", () => {
    refreshFileName(false);
  });
  formatSelect.addEventListener("change", () => {
    syncVisibility();
    customName = false;
    refreshFileName(true);
  });
  stlModeSelect.addEventListener("change", () => {
    customName = false;
    refreshFileName(true);
  });

  cancelBtn.addEventListener("click", () => {
    if (!exportBtn.disabled) dialog.close();
  });
  dialog.addEventListener("cancel", (event) => {
    if (exportBtn.disabled) event.preventDefault();
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });

  exportBtn.addEventListener("click", () => {
    void (async () => {
      const asm = activeAssembly();
      if (!asm) {
        status.textContent = "That assembly is no longer on the plate.";
        return;
      }
      const fmt = formatSelect.value as PoseExportFormat;
      const chordMm = Number(chordInput.value);
      if (MESH_FORMATS.has(fmt) && (!Number.isFinite(chordMm) || chordMm < 0.01 || chordMm > 1)) {
        status.textContent = "Mesh detail must be between 0.01 and 1 mm.";
        return;
      }
      const config = currentConfig();
      const matched = config.kind === "frame" ? matchingAnimation() : null;
      const stlMode = stlModeSelect.value === "each" ? "each" : "one";
      const fileName = fileNameInput.value.trim() || poseExportFileName(asm.name, fmt, config, stlMode);

      exportBtn.disabled = true;
      cancelBtn.disabled = true;
      status.textContent = "Exporting…";

      try {
        modelApi()?.commitModel();
        const objects = livePlate();
        const byId = new Map(objects.map((o) => [o.id, o]));
        const frame = matched ? matched.anim.result.frames[matched.frameIndex]! : null;
        const exportAssembly: Assembly = frame ? frame.assembly : asm;
        const poses = new Map<string, Affine>();
        const colors = new Map<string, string>();
        const memberIndex = new Map(exportAssembly.members.map((m, idx) => [m.object, idx] as const));
        for (const member of exportAssembly.members) {
          const obj = byId.get(member.object);
          poses.set(member.object, frame?.poses.get(member.object) ?? (obj ? modelPoseOf(obj) : IDENTITY_POSE));
          const idx = memberIndex.get(member.object) ?? 0;
          colors.set(member.object, matched?.anim.swatches?.get(member.object) ?? frame?.colors.get(member.object) ?? defaultMemberColor(idx));
        }

        if (fmt === "step") {
          const flat = stepLayoutSelect.value === "flat";
          const res = await (await loadModel()).exportAssemblyStep(exportAssembly, {
            flat,
            poses,
            colors,
            fileName,
          });
          if (!res.ok) {
            status.textContent = res.message;
            return;
          }
          pushToast(res.message, "info");
          dialog.close();
          return;
        }

        // Pre-resolve part geometries (re-tessellating solids when Mesh detail differs from current chord).
        const meshByPartKey = new Map<string, Float32Array>();
        let modelLoader: Awaited<ReturnType<typeof loadModel>> | null = null;
        const partKeyOf = (id: string): string => {
          const obj = byId.get(id);
          if (!obj) return id;
          return obj.bytes.byteLength > 0 ? meshTokenOf(obj.bytes) : obj.id;
        };

        if (MESH_FORMATS.has(fmt)) {
          for (const member of exportAssembly.members) {
            const obj = byId.get(member.object);
            if (!obj) continue;
            const key = partKeyOf(member.object);
            if (meshByPartKey.has(key)) continue;
            let positions: Float32Array | null = null;
            if (Math.abs(chordMm - (obj.stepTolerance || 0.05)) > 1e-6) {
              modelLoader ??= await loadModel();
              positions = await modelLoader.tessellateSolidAtChord(obj, chordMm);
            }
            if (!positions || positions.length < 9) {
              const seat = meshSeat(obj.bytes) ?? 0;
              positions = partPositionsInOwnFrame(obj.sourcePos, seat);
            }
            meshByPartKey.set(key, positions);
          }
        }

        const ordered = orderExportMembers(
          exportAssembly,
          (id) => byId.get(id)?.name ?? id,
          partKeyOf,
          (id) => meshByPartKey.get(partKeyOf(id)) ?? new Float32Array(0),
          (id) => poses.get(id),
          (id) => colors.get(id),
        );
        if (!ordered.members.length) {
          status.textContent = "This assembly has no parts on the plate.";
          return;
        }

        if (fmt === "pose") {
          const bytes = encodePoseSheet(ordered, config);
          await saveBytes(bytes, fileName, "json", "application/json");
          pushToast(`Saved ${fileName}: ${ordered.members.length} members (${configLabel(config)}).`, "info");
          dialog.close();
          return;
        }

        if (fmt === "glb") {
          const anim = matchingAnimation();
          const includeAnim = includeAnimInput.checked && !!anim;
          const bytes = encodePoseGlb(ordered, includeAnim && anim ? { name: anim.title, sampled: anim.anim.result } : undefined);
          await saveBytes(bytes, fileName, "glb", "model/gltf-binary");
          const animNote = includeAnim && anim ? `, with animation (${anim.anim.result.frames.length} frames)` : "";
          pushToast(`Saved ${fileName}: ${ordered.members.length} members (${ordered.parts.length} ${ordered.parts.length === 1 ? "part" : "parts"})${animNote}.`, "info");
          dialog.close();
          return;
        }

        if (fmt === "3mf") {
          const bytes = encodePose3mf(ordered);
          await saveBytes(bytes, fileName, "3mf", "model/3mf");
          pushToast(`Saved ${fileName}: ${ordered.members.length} members (${ordered.parts.length} ${ordered.parts.length === 1 ? "part" : "parts"}) as a 3MF assembly.`, "info");
          dialog.close();
          return;
        }

        if (fmt === "stl") {
          const bytes = encodePoseStl(ordered, stlMode);
          const ext = stlMode === "each" ? "zip" : "stl";
          const mime = stlMode === "each" ? "application/zip" : "model/stl";
          await saveBytes(bytes, fileName, ext, mime);
          pushToast(`Saved ${fileName}: ${ordered.members.length} members.`, "info");
          dialog.close();
          return;
        }

        // OBJ + MTL
        const objName = fileName.toLowerCase().endsWith(".obj") ? fileName : `${fileName}.obj`;
        const mtlName = objName.replace(/\.obj$/i, ".mtl");
        const out = encodePoseObjMtl(ordered, mtlName);
        const folder = await saveBytesToFolder(
          [
            { name: objName, bytes: out.obj },
            { name: mtlName, bytes: out.mtl },
          ],
          "text/plain",
        );
        if (folder === null) {
          status.textContent = "No folder was picked, so nothing was saved.";
          return;
        }
        pushToast(`Saved ${objName} and ${mtlName}${folder ? ` in ${folder}` : ""}: ${ordered.members.length} members.`, "info");
        dialog.close();
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
      } finally {
        exportBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    })();
  });

  document.body.append(dialog);
  dialog.showModal();
}
