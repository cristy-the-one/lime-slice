/**
 * The one-object slice body a stress study sends. A plate of several parts
 * still studies the open object alone. `sim` is not a slice field.
 */
import { bytesToBase64 } from "../base64.ts";
import { beltStamp } from "../ui/machine-library.ts";
import { encodeStl, placeMesh } from "../mesh-place.ts";
import { emptyOverrides } from "../overrides.ts";
import { sourceFrame } from "../plate.ts";
import { reinforcementRequestFields, normalInfillDensity } from "../reinforcement.ts";
import { seamRequestFields } from "../seam-paint.ts";
import { orderFields } from "../settings-rules.ts";
import { sliceRequest } from "../slice-request.ts";
import { resolved } from "../strategy.ts";
import { editRequestFields } from "../support-edit-list.ts";
import { paintRequestFields } from "../support-paint.ts";
import { activeHeat, loadMachineLibrary } from "./machine-library.ts";
import { currentRules } from "./rules.ts";
import { blend } from "./settings.ts";
import { patternBlend, type PatternName } from "../sim/pattern-patch.ts";
import { state } from "./state.ts";
import { currentPlacement, meshBase64 } from "./files.ts";

export interface SlicePatch {
  walls?: number;
  infill?: number;
  pattern?: PatternName;
}

function lineWidth(): number {
  return Math.min(1.2, Math.max(0.2, state.profile.nozzleDiameter * 1.125));
}

/** The printer a one-object slice sends. Density and price are left out. */
function printerBody(library: ReturnType<typeof loadMachineLibrary>) {
  const { filamentDensityGCm3: _density, filamentCostPerKg: _cost, ...profile } = state.profile;
  const heat = activeHeat();
  const rules = currentRules(library);
  return {
    ...profile,
    nozzleTemp: heat.nozzleC,
    bedTemp: heat.bedC,
    pressureAdvance: state.pressureAdvance,
    linearAdvance: state.linearAdvance,
    firmware: rules.firmware,
    firmwareArcs: rules.firmwareArcs,
  };
}

function selectedObject() {
  return state.plate.objects.find((obj) => obj.id === state.plate.selectedId);
}

function objectUsesTree(): boolean {
  const obj = selectedObject();
  const supports = obj?.settings.supports ?? state.supports;
  const style = obj?.settings.supportStyle ?? state.supportStyle;
  return supports === true && style === "tree";
}

/**
 * The body a one-object slice sends for the open part, plus `dataB64`.
 * Preview and G-code stay off: the study only needs the beads.
 * A patch replaces walls, infill, or the pattern for one variant.
 * `mesh` is the tessellation the faces were picked on, already scaled.
 * Its pose is recomputed when that tessellation is not the plate mesh.
 */
export function stressSliceRequest(
  patch?: SlicePatch,
  mesh?: { positions: Float32Array; unscaled: Float32Array },
): Record<string, unknown> | null {
  if (!state.mesh && !mesh) return null;
  const library = loadMachineLibrary();
  const rules = currentRules(library);
  const name = state.mesh?.name || "part";
  const filename = state.sourcePos ? name.replace(/\.(3mf|step|stp)$/i, ".stl") : name;
  const own = mesh && state.sourcePos !== mesh.unscaled;
  const pose = own
    ? placeMesh(mesh.unscaled, state.orient, state.partScale, state.profile.bedX, state.profile.bedY, state.centered, state.offset).pose
    : currentPlacement()?.pose;
  const frame = state.sourcePos ? sourceFrame(state.sourcePos, state.partScale) : null;
  const one = {
    filename,
    ...(pose ? { pose } : {}),
    ...editRequestFields(state.supportEdits, objectUsesTree()),
    ...(frame ? paintRequestFields(state.supportPaint, frame) : {}),
    ...(frame ? seamRequestFields(state.seamPaint, frame) : {}),
    ...(frame
      ? reinforcementRequestFields(
          state.reinforcement,
          frame,
          normalInfillDensity({
            blendKind: state.blendKind,
            strategy: state.strategy,
            toughness: state.toughness,
          }),
        )
      : {}),
  };
  const width = lineWidth();
  const body = rules.coerce(sliceRequest({
    one,
    plate: {},
    order: orderFields(rules, { printOrder: state.printOrder, clearanceMm: state.sequentialClearance, gantryMm: state.sequentialGantry }),
    settings: state,
    stepToleranceMm: state.stepTolerance,
    lineWidth: width,
    blend: blend(),
    printer: printerBody(library),
    onBelt: beltStamp(library) !== null,
    belt: beltStamp(library),
    layerActions: state.layerActions,
    overrides: state.overrides ?? emptyOverrides(),
    includePreview: false,
  })) as Record<string, unknown>;
  body.dataB64 = mesh ? bytesToBase64(new Uint8Array(encodeStl(mesh.positions, filename))) : meshBase64();
  body.includeGcode = false;
  const selected = selectedObject();
  const walls = patch?.walls ?? selected?.settings.walls;
  const infill = patch?.infill ?? selected?.settings.infill;
  if (walls !== undefined) body.walls = walls;
  if (infill !== undefined) body.infill = infill;
  if (patch?.pattern) {
    body.blend = patternBlend(patch.pattern);
    const card = resolved(state.toughness, state.layerHeight, width);
    if (body.walls === undefined) body.walls = selected?.settings.walls ?? card.walls;
    if (body.infill === undefined) body.infill = selected?.settings.infill ?? card.density;
  }
  delete body.sim;
  return body;
}
