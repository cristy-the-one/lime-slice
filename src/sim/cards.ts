/**
 * Provisional material cards. The numbers are placeholders so a study has
 * units. They are not a data sheet, and a solve that uses one stays rough.
 * Densities match the filaments we already ship. The moduli are not copied
 * from a vendor, a paper, or another slicer.
 */

export interface MaterialCard {
  id: string;
  polymer: string;
  provisional: boolean;
  EInPlaneMPa: number;
  EAcrossLayersMPa: number;
  nu: number;
  strengthInPlaneMPa: number;
  strengthAcrossLayersMPa: number;
  compressionInPlaneMPa: number;
  compressionAcrossLayersMPa: number;
  shearAcrossLayersMPa: number;
  densityGCm3: number;
  measuredAtC: number | null;
  specimen: string;
  method: string | null;
  source: string;
  isotropic: boolean;
}

function card(
  id: string,
  polymer: string,
  eIn: number,
  eZ: number,
  nu: number,
  sIn: number,
  sZ: number,
  density: number,
): MaterialCard {
  return {
    id,
    polymer,
    provisional: true,
    EInPlaneMPa: eIn,
    EAcrossLayersMPa: eZ,
    nu,
    strengthInPlaneMPa: sIn,
    strengthAcrossLayersMPa: sZ,
    compressionInPlaneMPa: sIn,
    compressionAcrossLayersMPa: sZ,
    shearAcrossLayersMPa: sZ / 2,
    densityGCm3: density,
    measuredAtC: null,
    specimen: "placeholder, not measured",
    method: null,
    source: "in-house",
    isotropic: false,
  };
}

/** PLA, PETG, ABS, and TPU. No other polymer is invented. */
export function provisionalCards(): MaterialCard[] {
  return [
    card("inhouse-pla", "PLA", 1700, 1400, 0.35, 28, 14, 1.24),
    card("inhouse-petg", "PETG", 1800, 1500, 0.35, 30, 15, 1.27),
    card("inhouse-abs", "ABS", 1600, 1300, 0.35, 25, 12, 1.04),
    card("inhouse-tpu", "TPU", 80, 60, 0.45, 10, 5, 1.21),
  ];
}
