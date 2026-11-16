/**
 * With the two support settings added after 6.8 (thin belt edges, short bridges) left at their
 * defaults, the slice body is the same bytes as before they existed, so every cached slice keeps
 * its key. The pinned strings were captured from the request builder before the controls landed.
 */
import type { BeltSettings } from "./belt.ts";
import { emptyOverrides } from "./overrides.ts";
import { DEFAULT_PRESET, type PresetSettings } from "./presets.ts";
import { sliceRequest } from "./slice-request.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const BELT: BeltSettings = { angleDeg: 45, axis: "z", direction: 1, widthMm: 250, maxLengthMm: null, copies: 1, gapMm: 10, raftLayers: 0 };

function body(settings: PresetSettings, belt: BeltSettings | null): string {
  return JSON.stringify(
    sliceRequest({
      one: { mesh: "m" },
      plate: {},
      order: {},
      settings,
      stepToleranceMm: 0.05,
      lineWidth: 0.45,
      blend: { kind: "single", strategy: "speed" },
      printer: { name: "p" },
      onBelt: belt !== null,
      belt,
      layerActions: [],
      overrides: emptyOverrides(),
      includePreview: false,
    }),
  );
}

// Captured from sliceRequest on b561187a, before the two controls existed.
const BEFORE = {
  flat: "{\"mesh\":\"m\",\"stepToleranceMm\":0.05,\"layerHeight\":0.2,\"lineWidth\":0.45,\"blend\":{\"kind\":\"single\",\"strategy\":\"speed\"},\"adaptive\":false,\"adaptiveMin\":0.08,\"adaptiveMax\":0.2,\"supports\":false,\"supportAngle\":45,\"supportStyle\":\"tree\",\"branchAngle\":40,\"tipDiameter\":0.8,\"trunkDiameter\":4.2,\"supportHeightMult\":1,\"infillCombine\":true,\"combing\":true,\"featureSpeeds\":true,\"printer\":{\"name\":\"p\"},\"minLayerTimeS\":0,\"minLayerSpeedMmS\":15,\"variableWidth\":true,\"arcFit\":true,\"travelOpt\":true,\"overhangControl\":true,\"scarfSeam\":\"blend\",\"scarfLength\":10,\"scarfSteps\":8,\"scarfStartHeight\":0.15,\"scarfStartFlow\":0.55,\"gyroid3d\":\"blend\",\"zHop\":\"blend\",\"zHopHeight\":0.4,\"zHopMinTravel\":2,\"baseline\":false,\"compare\":false,\"includeGcode\":false,\"includePreview\":false,\"simplify\":true,\"simplifyErrorMm\":0}",
  beltSupports: "{\"mesh\":\"m\",\"stepToleranceMm\":0.05,\"layerHeight\":0.2,\"lineWidth\":0.45,\"blend\":{\"kind\":\"single\",\"strategy\":\"speed\"},\"adaptive\":false,\"adaptiveMin\":0.08,\"adaptiveMax\":0.2,\"supports\":true,\"supportAngle\":45,\"supportStyle\":\"tree\",\"branchAngle\":40,\"tipDiameter\":0.8,\"trunkDiameter\":4.2,\"supportHeightMult\":1,\"supportBeltAnchorMm\":10,\"infillCombine\":true,\"combing\":true,\"featureSpeeds\":true,\"printer\":{\"name\":\"p\"},\"minLayerTimeS\":0,\"minLayerSpeedMmS\":15,\"belt\":{\"angleDeg\":45,\"axis\":\"z\",\"direction\":1,\"widthMm\":250,\"copies\":1,\"gapMm\":10,\"floorSupports\":true},\"variableWidth\":true,\"arcFit\":true,\"travelOpt\":true,\"overhangControl\":true,\"scarfSeam\":\"blend\",\"scarfLength\":10,\"scarfSteps\":8,\"scarfStartHeight\":0.15,\"scarfStartFlow\":0.55,\"gyroid3d\":\"blend\",\"zHop\":\"blend\",\"zHopHeight\":0.4,\"zHopMinTravel\":2,\"baseline\":false,\"compare\":false,\"includeGcode\":false,\"includePreview\":false,\"simplify\":true,\"simplifyErrorMm\":0}",
  flatSupports: "{\"mesh\":\"m\",\"stepToleranceMm\":0.05,\"layerHeight\":0.2,\"lineWidth\":0.45,\"blend\":{\"kind\":\"single\",\"strategy\":\"speed\"},\"adaptive\":false,\"adaptiveMin\":0.08,\"adaptiveMax\":0.2,\"supports\":true,\"supportAngle\":45,\"supportStyle\":\"grid\",\"branchAngle\":40,\"tipDiameter\":0.8,\"trunkDiameter\":4.2,\"supportHeightMult\":1,\"infillCombine\":true,\"combing\":true,\"featureSpeeds\":true,\"printer\":{\"name\":\"p\"},\"minLayerTimeS\":0,\"minLayerSpeedMmS\":15,\"variableWidth\":true,\"arcFit\":true,\"travelOpt\":true,\"overhangControl\":true,\"scarfSeam\":\"blend\",\"scarfLength\":10,\"scarfSteps\":8,\"scarfStartHeight\":0.15,\"scarfStartFlow\":0.55,\"gyroid3d\":\"blend\",\"zHop\":\"blend\",\"zHopHeight\":0.4,\"zHopMinTravel\":2,\"baseline\":false,\"compare\":false,\"includeGcode\":false,\"includePreview\":false,\"simplify\":true,\"simplifyErrorMm\":0}",
};

check("the default flat body is unchanged", body(DEFAULT_PRESET, null) === BEFORE.flat);
check("the default belt body with supports is unchanged", body({ ...DEFAULT_PRESET, supports: true }, BELT) === BEFORE.beltSupports);
check("the default flat body with grid supports is unchanged", body({ ...DEFAULT_PRESET, supports: true, supportStyle: "grid" }, null) === BEFORE.flatSupports);

// Either setting with supports off sends nothing, so the body still matches.
check("a bridge limit with supports off sends nothing", body({ ...DEFAULT_PRESET, supportBridgeMm: 5 }, null) === BEFORE.flat);
check("thin belt edges on a flat printer send nothing", body({ ...DEFAULT_PRESET, supports: true, supportStyle: "grid", supportBeltHoldThin: true }, null) === BEFORE.flatSupports);

// Turned on, each is one key in the body.
const on = JSON.parse(body({ ...DEFAULT_PRESET, supports: true, supportBeltHoldThin: true, supportBridgeMm: 5 }, BELT)) as Record<string, unknown>;
check("thin belt edges on a belt are sent", on.supportBeltHoldThin === true, JSON.stringify(on));
check("the bridge limit is sent", on.supportBridgeMm === 5, JSON.stringify(on));
const { supportBeltHoldThin: _thin, supportBridgeMm: _bridge, ...rest } = on;
check("nothing else changes", JSON.stringify(rest) === BEFORE.beltSupports, JSON.stringify(rest));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
