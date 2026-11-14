/**
 * The gear primitive's numbers on the client (docs/plan-native-recipes.md milestone 8): its fields, their defaults and
 * limits, a label, its box, and a ghost outline for the view while the numbers change. The engine builds the real gear
 * from `lime_recipe::gears` (true involute splines, the cutting rack's root fillet); the ghost here is the involute
 * sampled to a polyline with straight roots, close enough to see, and never sent anywhere.
 */

export type BoreShape = "round" | "hex" | "d";

/** Every gear field a `PrimitiveSpec` can carry. `height` is the gear's thickness. */
export interface GearFields {
  teeth: number;
  module: number;
  pressureDeg?: number;
  backlash?: number;
  profileShift?: number;
  phaseDeg?: number;
  /** A round or D bore's diameter, a hex bore's width across its flats; 0 or absent for none. */
  bore?: number;
  boreShape?: BoreShape;
  /** A D bore's width from the flat to the far side. */
  boreFlat?: number;
  hubDiameter?: number;
  hubHeight?: number;
  /** A ring gear, its teeth pointing in (docs/plan-gear-kinds.md, stage 2). No shift, bore or hub. */
  internal?: boolean;
  /** A ring's outside diameter, mm; two modules outside its root when absent. */
  rim?: number;
}

/** A ring's smallest rim: two modules outside its root circle, across. The kernel's least too. */
export function ringLeastRim(gear: GearFields): number {
  return 2 * (pitchRadius(gear) + 1.25 * gear.module + 2 * gear.module);
}

/** A ring's outside diameter: its rim, or the least one. */
export function ringRim(gear: GearFields): number {
  return gear.rim ?? ringLeastRim(gear);
}

/**
 * A ring's toothed hole for the ghost, counter-clockwise, tooth 0 centred on `phaseDeg`: the space between two teeth is
 * the external tooth of the same numbers, from the tip circle `r - m` out to the root circle `r + 1.25 m`.
 */
export function ringGhostOutline(gear: GearFields, perFlank = 6): [number, number][] {
  const z = gear.teeth;
  const m = gear.module;
  const alpha = ((gear.pressureDeg ?? 20) * Math.PI) / 180;
  const r = pitchRadius(gear);
  const rb = r * Math.cos(alpha);
  const ra = r - m;
  const rf = r + 1.25 * m;
  if (!(ra > 0)) return [];
  const space = Math.PI / (2 * z) + (gear.backlash ?? 0.1) / (2 * r);
  const inv = (a: number) => Math.tan(a) - a;
  const half = (rho: number) => space + inv(alpha) - inv(Math.acos(rb / Math.max(rho, rb)));
  const up: [number, number][] = [];
  const low = Math.max(ra, rb);
  if (ra < rb) up.push([ra, half(rb)]);
  for (let i = 0; i <= perFlank; i += 1) {
    const rho = low + ((rf - low) * i) / perFlank;
    up.push([rho, Math.max(half(rho), 0)]);
  }
  const out: [number, number][] = [];
  const at = (rho: number, angle: number): [number, number] => [rho * Math.cos(angle), rho * Math.sin(angle)];
  for (let k = 0; k < z; k += 1) {
    const c = (((gear.phaseDeg ?? 0) + (360 * (k + 0.5)) / z) * Math.PI) / 180;
    for (const [rho, a] of up) out.push(at(rho, c - a));
    for (let i = up.length - 1; i >= 0; i -= 1) out.push(at(up[i]![0], c + up[i]![1]));
  }
  return out;
}

export const GEAR_DEFAULTS = { teeth: 20, module: 1.5, thickness: 6, pressureDeg: 20, backlash: 0.1, profileShift: 0, phaseDeg: 0 } as const;
export const GEAR_TEETH = { min: 6, max: 150 } as const;

export function isBoreShape(value: unknown): value is BoreShape {
  return value === "round" || value === "hex" || value === "d";
}

export function pitchRadius(gear: GearFields): number {
  return (gear.module * gear.teeth) / 2;
}

export function tipRadius(gear: GearFields): number {
  return pitchRadius(gear) + gear.module * (1 + (gear.profileShift ?? 0));
}

export function rootRadius(gear: GearFields): number {
  return pitchRadius(gear) - gear.module * (1.25 - (gear.profileShift ?? 0));
}

/** The gear's numbers as a step label: "gear 20 teeth m 1.5 h 6". */
export function gearLabel(gear: GearFields, height: number, n: (value: number) => string): string {
  const bore = gear.bore ? `, ${gear.boreShape === "hex" ? "hex " : gear.boreShape === "d" ? "D " : "⌀"}${n(gear.bore)} bore` : "";
  const hub = gear.hubDiameter && gear.hubHeight ? `, hub ⌀${n(gear.hubDiameter)}` : "";
  if (gear.internal) return `ring gear ${gear.teeth} teeth m ${n(gear.module)} h ${n(height)}, rim ⌀${n(ringRim(gear))}`;
  return `gear ${gear.teeth} teeth m ${n(gear.module)} h ${n(height)}${bore}${hub}`;
}

/** The one sentence the card shows before asking the engine, for numbers it would refuse anyway; null when fine. */
export function gearRefusal(gear: GearFields, height: number): string | null {
  if (!Number.isInteger(gear.teeth) || gear.teeth < GEAR_TEETH.min || gear.teeth > GEAR_TEETH.max) return `A gear takes ${GEAR_TEETH.min} to ${GEAR_TEETH.max} teeth.`;
  if (!(gear.module >= 0.05 && gear.module <= 50)) return "A gear's module is 0.05 to 50 mm.";
  const pressure = gear.pressureDeg ?? 20;
  if (!(pressure >= 10 && pressure <= 30)) return "A gear's pressure angle is 10 to 30 degrees.";
  const shift = gear.profileShift ?? 0;
  if (!(shift >= -1 && shift <= 1)) return "A gear's profile shift is -1 to 1, times the module.";
  const backlash = gear.backlash ?? 0.1;
  if (!(backlash >= 0 && backlash <= gear.module)) return "A gear's backlash is 0 to one module, in mm at the pitch circle.";
  if (!(height > 0 && height <= 1000)) return "A gear's thickness is above 0 and at most 1000 mm.";
  if (gear.internal) {
    if (gear.teeth < 20) return `A ring gear takes 20 to ${GEAR_TEETH.max} teeth.`;
    if (shift !== 0) return "A ring gear takes no profile shift.";
    if (gear.bore || gear.hubDiameter || gear.hubHeight) return "A ring gear takes no bore or hub: its hole is its teeth.";
    const least = ringLeastRim(gear);
    const rim = ringRim(gear);
    if (!(rim >= least - 1e-9 && rim <= 4 * least)) return `A ring's rim is ${least.toFixed(2)} to ${(4 * least).toFixed(2)} mm across: at least two modules outside its root.`;
  } else if (gear.rim !== undefined) return "Only a ring gear (internal) takes a rim.";
  return null;
}

/**
 * The ghost's outline, counter-clockwise, tooth 0 centred on `phaseDeg`: each flank an involute from the base circle (or
 * the root, when that is larger) to the tip, a radial line down to the root, and straight runs along tip and root.
 */
export function gearGhostOutline(gear: GearFields, perFlank = 6): [number, number][] {
  const z = gear.teeth;
  const m = gear.module;
  const alpha = ((gear.pressureDeg ?? 20) * Math.PI) / 180;
  const r = pitchRadius(gear);
  const rb = r * Math.cos(alpha);
  const ra = tipRadius(gear);
  const rf = Math.max(rootRadius(gear), 0.1 * m);
  const shift = gear.profileShift ?? 0;
  const psi = Math.PI / (2 * z) + (2 * shift * Math.tan(alpha)) / z - (gear.backlash ?? 0.1) / (2 * r);
  const inv = (a: number) => Math.tan(a) - a;
  const half = (rho: number) => psi + inv(alpha) - inv(Math.acos(rb / Math.max(rho, rb)));
  const low = Math.max(rf, rb);
  const up: [number, number][] = [[rf, half(low)]];
  for (let i = 0; i <= perFlank; i += 1) {
    const rho = low + ((ra - low) * i) / perFlank;
    up.push([rho, Math.max(half(rho), 0)]);
  }
  const out: [number, number][] = [];
  const at = (rho: number, angle: number): [number, number] => [rho * Math.cos(angle), rho * Math.sin(angle)];
  for (let k = 0; k < z; k += 1) {
    const c = (((gear.phaseDeg ?? 0) + (360 * k) / z) * Math.PI) / 180;
    for (const [rho, a] of up) out.push(at(rho, c - a));
    for (let i = up.length - 1; i >= 0; i -= 1) out.push(at(up[i]![0], c + up[i]![1]));
  }
  return out;
}

/** The bore's outline for the ghost, as points; empty without one. */
export function boreGhostOutline(gear: GearFields): [number, number][] {
  const size = gear.bore ?? 0;
  if (!(size > 0)) return [];
  if (gear.boreShape === "hex") {
    const corner = size / Math.sqrt(3);
    return Array.from({ length: 6 }, (_, k) => [corner * Math.cos((k * Math.PI) / 3), corner * Math.sin((k * Math.PI) / 3)] as [number, number]);
  }
  const radius = size / 2;
  const across = gear.boreShape === "d" ? (gear.boreFlat ?? 0.9 * size) - radius : radius;
  const out: [number, number][] = [];
  for (let i = 0; i < 32; i += 1) {
    const a = (2 * Math.PI * i) / 32;
    out.push([Math.min(radius * Math.cos(a), across), radius * Math.sin(a)]);
  }
  return out;
}
