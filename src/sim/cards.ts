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
  /** Bead constants for the sliced representation, as `lime_sim::material::BeadSection` reads them. */
  beads?: BeadSection;
}

/**
 * A bead: along it, across it to the next bead, and across the layers. A
 * provisional section is derived from the card's own numbers, so it never
 * goes stale when the card is edited (see `withBeads`).
 */
export interface BeadSection {
  provisional: boolean;
  EAlongBeadMPa: number;
  EAcrossBeadMPa: number;
  EAcrossLayersMPa: number;
  strengthAlongBeadMPa: number;
  strengthAcrossBeadMPa: number;
  strengthAcrossLayersMPa: number;
  shearAcrossLayersMPa: number;
  shearAcrossBeadMPa?: number;
  bridgeFactor: number;
}

/**
 * The placeholder section the Rust cards carry: the bond across beads is
 * taken as the bond across layers, which is a placeholder, not a measurement.
 */
export function provisionalBeads(card: MaterialCard): BeadSection {
  return {
    provisional: true,
    EAlongBeadMPa: card.EInPlaneMPa,
    EAcrossBeadMPa: card.EAcrossLayersMPa,
    EAcrossLayersMPa: card.EAcrossLayersMPa,
    strengthAlongBeadMPa: card.strengthInPlaneMPa,
    strengthAcrossBeadMPa: card.strengthAcrossLayersMPa,
    strengthAcrossLayersMPa: card.strengthAcrossLayersMPa,
    shearAcrossLayersMPa: card.shearAcrossLayersMPa,
    bridgeFactor: 0.5,
  };
}

/** The card as the solver takes it: a measured section is kept, any other is derived from the card. */
export function withBeads(card: MaterialCard): MaterialCard {
  if (card.beads && !card.beads.provisional) return card;
  return { ...card, beads: provisionalBeads(card) };
}

/** A section from a file or a client, or `null` when a number is missing or out of range. */
export function readBeadSection(value: unknown): BeadSection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const positive = (key: string) => (typeof row[key] === "number" && Number.isFinite(row[key]) && (row[key] as number) > 0 ? (row[key] as number) : null);
  const keys = ["EAlongBeadMPa", "EAcrossBeadMPa", "EAcrossLayersMPa", "strengthAlongBeadMPa", "strengthAcrossBeadMPa", "strengthAcrossLayersMPa", "shearAcrossLayersMPa"] as const;
  const numbers = keys.map(positive);
  if (numbers.some((n) => n === null)) return null;
  const bridge = positive("bridgeFactor");
  if (bridge === null || bridge > 1) return null;
  const shearAcrossBead = row.shearAcrossBeadMPa === undefined || row.shearAcrossBeadMPa === null ? undefined : positive("shearAcrossBeadMPa");
  if (shearAcrossBead === null) return null;
  const [eAlong, eAcross, eLayers, sAlong, sAcross, sLayers, shearLayers] = numbers as number[];
  return {
    provisional: row.provisional === true,
    EAlongBeadMPa: eAlong!,
    EAcrossBeadMPa: eAcross!,
    EAcrossLayersMPa: eLayers!,
    strengthAlongBeadMPa: sAlong!,
    strengthAcrossBeadMPa: sAcross!,
    strengthAcrossLayersMPa: sLayers!,
    shearAcrossLayersMPa: shearLayers!,
    ...(shearAcrossBead !== undefined ? { shearAcrossBeadMPa: shearAcrossBead } : {}),
    bridgeFactor: bridge,
  };
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
  return withBeads({
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
  });
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
