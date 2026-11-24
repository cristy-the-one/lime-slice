/**
 * One Export dialog (docs/plan-export-and-linking.md D1). Scope first, then format.
 * Mesh and assembly writers are the ones Pose already used; print layout uses today's 3MF and STL encoders.
 */
import { sheetPartNote } from "../model-sheet";
import type { Assembly } from "../assembly.ts";
import {
  EXPORT_SCOPES,
  SCOPE_LABELS,
  defaultScope,
  formatFor,
  formatsFor,
  plateAssembled,
  rememberFormat,
  type ExportFormat,
  type ExportScope,
} from "../export-scope.ts";
import { exportStem } from "../modeling/partition-export.ts";
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
  orderedPoseProblem,
  poseExportFileName,
  type PoseExportConfig,
  type PoseExportFormat,
} from "../pose-export.ts";
import { pushToast } from "../ui/toasts.ts";
import { liveAssemblies } from "./assemblies.ts";
import { plateExportFacts } from "./export-availability.ts";
import { export3mf, exportPrintLayoutStl, livePlate, printFileStem } from "./files.ts";
import { saveBytes, saveBytesToFolder } from "./save-bytes.ts";
import { state } from "./state.ts";
import { loadModel, modelApi } from "./workspaces.ts";
import type { PoseAnimationState } from "./pose.ts";

export interface ExportPreset {
  scope?: ExportScope;
  format?: ExportFormat;
  /** A filled-in format wins over the format remembered for that scope. */
  explicitFormat?: boolean;
  assemblyId?: string;
  objectId?: string;
  /** A filled-in file name, used until the person changes scope or format. */
  fileName?: string;
  animation?: PoseAnimationState | null;
  animationTitle?: string;
  frameIndex?: number;
  /** Pose's Export… opens on the stopped frame when an animation is showing. */
  preferFrame?: boolean;
}

const FORMAT_LABELS: Record<ExportFormat, string> = {
  step: "STEP (.step)",
  glb: "glTF binary (.glb)",
  "3mf": "3MF (.3mf)",
  stl: "STL (.stl)",
  obj: "OBJ + MTL (.obj)",
  pose: "Pose sheet (.json)",
};

const MESH_FORMATS = new Set<ExportFormat>(["glb", "3mf", "stl", "obj"]);

function formatLabel(scope: ExportScope, format: ExportFormat): string {
  if (format === "3mf" && (scope === "assembly" || scope === "plate-assembled")) return "3MF assembly (.3mf)";
  return FORMAT_LABELS[format];
}

function partPositionsInOwnFrame(sourcePos: Float32Array, seat: number): Float32Array {
  if (!seat) return sourcePos;
  const shifted = sourcePos.slice();
  for (let i = 2; i < shifted.length; i += 3) shifted[i] = shifted[i]! + seat;
  return shifted;
}

function scopeAllowed(scope: ExportScope): boolean {
  const facts = plateExportFacts();
  if (facts.objects === 0) return false;
  if (scope === "part") return !!facts.selectedId;
  if (scope === "assembly") return facts.assemblies > 0;
  return true;
}

export function openExportCommand(id: string): void {
  if (id === "export-part") showExport({ scope: "part" });
  else if (id === "export-assembly") showExport({ scope: "assembly" });
  else if (id === "export-plate") showExport({ scope: "plate-assembled" });
  else showExport();
}

export function showExport(preset: ExportPreset = {}): void {
  document.querySelector<HTMLDialogElement>("[data-export-dialog]")?.close();

  const facts = plateExportFacts();
  const assemblies = liveAssemblies();
  const wanted = preset.scope ?? defaultScope({ selectedId: facts.selectedId, memberOf: facts.memberOf });
  const initialScope = scopeAllowed(wanted) ? wanted : defaultScope({ selectedId: facts.selectedId, memberOf: facts.memberOf });
  const initialFormat = preset.explicitFormat && preset.format && formatsFor(initialScope).includes(preset.format)
    ? preset.format
    : formatFor(initialScope);

  const dialog = document.createElement("dialog");
  dialog.className = "pose-animation-save pose-export-dialog";
  dialog.setAttribute("aria-label", "Export");
  dialog.dataset.poseExportDialog = "";
  dialog.dataset.exportDialog = "";

  const heading = document.createElement("h2");
  heading.textContent = "Export";
  dialog.append(heading);

  const addRow = (labelText: string, control: HTMLElement): HTMLLabelElement => {
    const wrap = document.createElement("label");
    wrap.textContent = labelText;
    wrap.append(control);
    dialog.append(wrap);
    return wrap;
  };

  const scopeSelect = document.createElement("select");
  scopeSelect.setAttribute("aria-label", "Scope");
  scopeSelect.dataset.export = "scope";
  for (const scope of EXPORT_SCOPES) {
    const opt = document.createElement("option");
    opt.value = scope;
    opt.textContent = SCOPE_LABELS[scope];
    opt.disabled = !scopeAllowed(scope);
    scopeSelect.append(opt);
  }
  scopeSelect.value = initialScope;
  addRow("Scope", scopeSelect);

  const assemblySelect = document.createElement("select");
  assemblySelect.setAttribute("aria-label", "Assembly");
  assemblySelect.dataset.poseExport = "assembly";
  for (const row of assemblies) {
    const opt = document.createElement("option");
    opt.value = row.id;
    opt.textContent = row.name;
    assemblySelect.append(opt);
  }
  const animationId = preset.animation?.assembly;
  const initialAssembly =
    (preset.assemblyId && assemblies.some((row) => row.id === preset.assemblyId) && preset.assemblyId)
    || (animationId && assemblies.some((row) => row.id === animationId) && animationId)
    || facts.memberOf
    || assemblies[0]?.id
    || "";
  if (initialAssembly) assemblySelect.value = initialAssembly;
  const assemblyRow = addRow("Assembly", assemblySelect);

  const configSelect = document.createElement("select");
  configSelect.setAttribute("aria-label", "Configuration");
  configSelect.dataset.poseExport = "config";
  const configRow = addRow("Configuration", configSelect);

  const formatSelect = document.createElement("select");
  formatSelect.setAttribute("aria-label", "Format");
  formatSelect.dataset.poseExport = "format";
  const formatRow = addRow("Format", formatSelect);

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

  const includeAnimInput = document.createElement("input");
  includeAnimInput.type = "checkbox";
  includeAnimInput.setAttribute("aria-label", "Include animation");
  includeAnimInput.dataset.poseExport = "animation";
  const animRow = addRow("Include animation", includeAnimInput);

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

  const chordInput = document.createElement("input");
  chordInput.type = "number";
  chordInput.min = "0.01";
  chordInput.max = "1";
  chordInput.step = "0.01";
  chordInput.value = String(Math.min(1, Math.max(0.01, state.stepTolerance || 0.05)));
  chordInput.setAttribute("aria-label", "Mesh detail (mm)");
  chordInput.dataset.poseExport = "chord";
  const chordRow = addRow("Mesh detail (mm)", chordInput);

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
  let pinnedName: string | null = preset.fileName ?? null;
  fileNameInput.addEventListener("input", () => {
    customName = fileNameInput.value.trim().length > 0;
    pinnedName = null;
  });

  const currentScope = (): ExportScope => (scopeSelect.value as ExportScope) || initialScope;

  const activeAssembly = (): Assembly | undefined =>
    liveAssemblies().find((row) => row.id === assemblySelect.value);

  const partObject = () => {
    const objects = livePlate();
    const id = preset.objectId || state.plate.selectedId;
    return objects.find((obj) => obj.id === id) ?? null;
  };

  const matchingAnimation = (): { anim: PoseAnimationState; frameIndex: number; title: string; timeS: number } | null => {
    const anim = preset.animation;
    if (!anim || anim.assembly !== assemblySelect.value) return null;
    const count = anim.result.frames.length;
    if (count === 0) return null;
    const idx = Math.max(0, Math.min(count - 1, preset.frameIndex ?? anim.clock.frame(performance.now())));
    const frame = anim.result.frames[idx]!;
    const title = preset.animationTitle || anim.plugin.name || "Animation";
    return { anim, frameIndex: idx, title, timeS: frame.time };
  };

  const currentConfig = (): PoseExportConfig => {
    if (currentScope() !== "assembly") return { kind: "now" };
    const matched = configSelect.value === "frame" ? matchingAnimation() : null;
    return matched
      ? { kind: "frame", animation: matched.title, frameIndex: matched.frameIndex, timeS: matched.timeS }
      : { kind: "now" };
  };

  const stlModeOf = (): "one" | "each" =>
    currentScope() !== "part" && stlModeSelect.value === "each" ? "each" : "one";

  const fillFormats = (scope: ExportScope, preferred?: ExportFormat) => {
    const formats = formatsFor(scope);
    formatSelect.replaceChildren();
    for (const value of formats) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = formatLabel(scope, value);
      formatSelect.append(opt);
    }
    const pick = preferred && formats.includes(preferred) ? preferred : formatFor(scope);
    formatSelect.value = pick;
  };

  const refreshConfig = (preferFrame: boolean) => {
    const prev = configSelect.value;
    configSelect.replaceChildren();
    const nowOpt = document.createElement("option");
    nowOpt.value = "now";
    nowOpt.textContent = "Now";
    configSelect.append(nowOpt);
    const matched = currentScope() === "assembly" ? matchingAnimation() : null;
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
    if (pinnedName && !force) {
      fileNameInput.value = pinnedName;
      return;
    }
    pinnedName = null;
    const scope = currentScope();
    const fmt = (formatSelect.value || "step") as ExportFormat;
    const stlMode = stlModeOf();
    if (scope === "assembly") {
      const asm = activeAssembly();
      if (!asm) return;
      fileNameInput.value = poseExportFileName(asm.name, fmt as PoseExportFormat, currentConfig(), stlMode);
      return;
    }
    const ext = fmt === "pose" ? "json" : fmt === "stl" && stlMode === "each" ? "zip" : fmt;
    if (scope === "part") {
      fileNameInput.value = `${exportStem(partObject()?.name ?? "part")}.${ext}`;
      return;
    }
    if (scope === "plate-print") {
      fileNameInput.value = `${printFileStem()}.${ext}`;
      return;
    }
    fileNameInput.value = `plate.${ext}`;
  };

  const syncVisibility = () => {
    const scope = currentScope();
    const fmt = formatSelect.value as ExportFormat;
    const matched = scope === "assembly" ? matchingAnimation() : null;
    assemblyRow.hidden = scope !== "assembly";
    configRow.hidden = scope !== "assembly";
    formatRow.hidden = false;
    stepRow.hidden = fmt !== "step" || scope === "part" || scope === "plate-print";
    animRow.hidden = scope !== "assembly" || fmt !== "glb" || !matched;
    stlRow.hidden = fmt !== "stl" || scope === "part";
    chordRow.hidden = scope === "plate-print" || !MESH_FORMATS.has(fmt);
  };

  fillFormats(initialScope, initialFormat);
  refreshConfig(preset.preferFrame === true);
  syncVisibility();
  refreshFileName(false);

  scopeSelect.addEventListener("change", () => {
    fillFormats(currentScope());
    refreshConfig(false);
    syncVisibility();
    customName = false;
    pinnedName = null;
    refreshFileName(true);
  });
  assemblySelect.addEventListener("change", () => {
    refreshConfig(true);
    syncVisibility();
    customName = false;
    pinnedName = null;
    refreshFileName(true);
  });
  configSelect.addEventListener("change", () => {
    refreshFileName(false);
  });
  formatSelect.addEventListener("change", () => {
    rememberFormat(currentScope(), formatSelect.value as ExportFormat);
    syncVisibility();
    customName = false;
    pinnedName = null;
    refreshFileName(true);
  });
  stlModeSelect.addEventListener("change", () => {
    customName = false;
    pinnedName = null;
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
      const scope = currentScope();
      const fmt = formatSelect.value as ExportFormat;
      if (!formatsFor(scope).includes(fmt)) {
        status.textContent = "That format is not available for this scope.";
        return;
      }
      const chordMm = Number(chordInput.value);
      if (scope !== "plate-print" && MESH_FORMATS.has(fmt) && (!Number.isFinite(chordMm) || chordMm < 0.01 || chordMm > 1)) {
        status.textContent = "Mesh detail must be between 0.01 and 1 mm.";
        return;
      }
      const stlMode = stlModeOf();
      const config = currentConfig();
      const fileName = fileNameInput.value.trim() || "export";

      exportBtn.disabled = true;
      cancelBtn.disabled = true;
      status.textContent = "Exporting…";

      try {
        modelApi()?.commitModel();
        if (scope === "plate-print") {
          const ok = fmt === "3mf" ? await export3mf(fileName) : await exportPrintLayoutStl(fileName, stlMode);
          if (!ok) {
            status.textContent = state.error || "Nothing to export.";
            return;
          }
          pushToast(`Saved ${fileName}.`, "info");
          dialog.close();
          return;
        }

        const objects = livePlate();
        const byId = new Map(objects.map((obj) => [obj.id, obj]));
        let exportAssembly: Assembly;
        const poses = new Map<string, Affine>();
        const colors = new Map<string, string>();

        if (scope === "part") {
          const obj = partObject();
          if (!obj) {
            status.textContent = "Select a part to export.";
            return;
          }
          if (fmt === "step") {
            const { exportOneSolid } = await import("./model/export.ts");
            const res = await exportOneSolid(obj, fileName);
            pushToast(res.message, res.ok ? "info" : "error");
            if (!res.ok) {
              status.textContent = res.message;
              return;
            }
            dialog.close();
            return;
          }
          exportAssembly = {
            id: "part",
            name: obj.name,
            members: [{ object: obj.id, parent: null, offset: [0, 0, 0], turn: [0, 0, 0] }],
          };
          poses.set(obj.id, IDENTITY_POSE);
          colors.set(obj.id, defaultMemberColor(0));
        } else if (scope === "plate-assembled") {
          const built = plateAssembled(objects.map((obj) => ({ id: obj.id, modelPose: modelPoseOf(obj) })), liveAssemblies());
          if (!built.assembly.members.length) {
            status.textContent = "The plate is empty.";
            return;
          }
          exportAssembly = built.assembly;
          for (const [id, pose] of built.poses) poses.set(id, pose);
          built.assembly.members.forEach((member, index) => colors.set(member.object, defaultMemberColor(index)));
        } else {
          const asm = activeAssembly();
          if (!asm) {
            status.textContent = "That assembly is no longer on the plate.";
            return;
          }
          const matched = config.kind === "frame" ? matchingAnimation() : null;
          const frame = matched ? matched.anim.result.frames[matched.frameIndex]! : null;
          exportAssembly = frame ? frame.assembly : asm;
          const memberIndex = new Map(exportAssembly.members.map((member, index) => [member.object, index] as const));
          for (const member of exportAssembly.members) {
            const obj = byId.get(member.object);
            poses.set(member.object, frame?.poses.get(member.object) ?? (obj ? modelPoseOf(obj) : IDENTITY_POSE));
            const index = memberIndex.get(member.object) ?? 0;
            colors.set(member.object, matched?.anim.swatches?.get(member.object) ?? frame?.colors.get(member.object) ?? defaultMemberColor(index));
          }
        }

        const members = new Set(exportAssembly.members.map((member) => member.object));
        const sheet = MESH_FORMATS.has(fmt) ? sheetPartNote(objects.filter((obj) => members.has(obj.id))) : null;
        if (sheet) {
          status.textContent = sheet;
          return;
        }

        if (fmt === "step") {
          const flat = stepLayoutSelect.value === "flat";
          const res = await (await loadModel()).exportAssemblyStep(exportAssembly, { flat, poses, colors, fileName });
          pushToast(res.message, res.ok ? "info" : "error");
          if (!res.ok) {
            status.textContent = res.message;
            return;
          }
          dialog.close();
          return;
        }

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
        const matched = scope === "assembly" && config.kind === "frame" ? matchingAnimation() : null;
        const glbAnim = fmt === "glb" && scope === "assembly" && includeAnimInput.checked ? matchingAnimation() : null;
        const poseProblem = orderedPoseProblem(ordered, glbAnim ? { name: glbAnim.title, sampled: glbAnim.anim.result } : undefined);
        if (poseProblem) {
          status.textContent = poseProblem;
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
          const includeAnim = scope === "assembly" && includeAnimInput.checked && !!matched;
          const bytes = encodePoseGlb(ordered, includeAnim && matched ? { name: matched.title, sampled: matched.anim.result } : undefined);
          await saveBytes(bytes, fileName, "glb", "model/gltf-binary");
          const animNote = includeAnim && matched ? `, with animation (${matched.anim.result.frames.length} frames)` : "";
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
        if (dialog.isConnected) {
          exportBtn.disabled = false;
          cancelBtn.disabled = false;
        }
      }
    })();
  });

  document.body.append(dialog);
  dialog.showModal();
}
