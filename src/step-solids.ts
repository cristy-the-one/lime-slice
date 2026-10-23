/**
 * A STEP file of several solids, such as a split to print's One STEP export: the choice on import, the pieces' names,
 * and whether Separate splits an object by its solids or by its mesh shells.
 */

import { placeMesh, type Mat3, type MeshShift } from "./mesh-place.ts";

/** One solid as the kernel's `stepSolids` lists it: its product name, empty when the file gave none. */
export interface StepSolidRow {
  name: string;
  volumeMm3?: number;
}

const SOLID_ENTITY = /\b(?:MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS|FACETED_BREP)\s*\(/g;
const hints = new WeakMap<object, number>();

/**
 * How many solids a STEP file's text declares: its solid B-rep entities. Reading the solids through the kernel costs
 * about as much as meshing the file, so only a file with two or more is offered as pieces. A part placed several times
 * in an assembly declares its solid once; Separate then splits its shells.
 */
export function stepSolidHint(bytes: ArrayBuffer | Uint8Array): number {
  const held = hints.get(bytes);
  if (held !== undefined) return held;
  const text = new TextDecoder("latin1").decode(bytes);
  const count = text.match(SOLID_ENTITY)?.length ?? 0;
  hints.set(bytes, count);
  return count;
}

/** The file name without its extension: what an unnamed piece is numbered after. */
export function stepStem(fileName: string): string {
  return fileName.replace(/\.(step|stp)$/i, "") || "solid";
}

/**
 * The plate name of each solid, in order: its STEP product name, or `<file>-<n>` when it has none or an earlier solid
 * already took that name. `n` is the solid's place in the file, counting from 1.
 */
export function solidNames(fileName: string, solids: readonly StepSolidRow[]): string[] {
  const stem = stepStem(fileName);
  const taken = new Set<string>();
  return solids.map((solid, index) => {
    const own = solid.name.trim();
    let name = own && !taken.has(own) ? own : `${stem}-${index + 1}`;
    for (let n = index + 2; taken.has(name); n += 1) name = `${stem}-${n}`;
    taken.add(name);
    return name;
  });
}

/** The STEP file each piece keeps, so Model opens it as a solid. */
export function pieceFileName(name: string): string {
  return /\.(step|stp)$/i.test(name) ? name : `${name}.step`;
}

/** The choice a STEP file of `count` solids offers on import. Null for one solid or none. */
export function solidsOffer(count: number): { message: string; pieces: string; whole: string } | null {
  if (!Number.isInteger(count) || count < 2) return null;
  return {
    message: `This STEP file holds ${count} solids.`,
    pieces: `Open as ${count} pieces`,
    whole: "Open as one object",
  };
}

/** How an object sits on the bed: what `placeMesh` takes. */
export interface Posed {
  source: Float32Array;
  orient: Mat3;
  scale: number;
  centered: boolean;
  offset: MeshShift;
}

/**
 * The offset that puts a piece where it sat in `parent`, with the parent's turn and scale and `centered` off. `source`
 * is the piece's mesh on Z = 0 and `lift` how far above the parent's lowest point it begins, both in the parent's file
 * frame. A piece that floats keeps its height.
 */
export function offsetInPlace(parent: Posed, source: Float32Array, lift: number, bedX: number, bedY: number): MeshShift {
  const { pose } = placeMesh(parent.source, parent.orient, parent.scale, bedX, bedY, parent.centered, parent.offset);
  const r = pose.rotation;
  const [cx, cy, cz] = pose.pivot;
  const want = [Infinity, Infinity, Infinity];
  for (let i = 0; i + 2 < source.length; i += 3) {
    const x = (source[i]! - cx) * parent.scale;
    const y = (source[i + 1]! - cy) * parent.scale;
    const z = (source[i + 2]! + lift - cz) * parent.scale;
    for (let a = 0; a < 3; a += 1) {
      const v = r[a * 3]! * x + r[a * 3 + 1]! * y + r[a * 3 + 2]! * z + pose.translation[a]!;
      if (v < want[a]!) want[a] = v;
    }
  }
  const got = placeMesh(source, parent.orient, parent.scale, bedX, bedY, false, { x: 0, y: 0, z: 0 }).bounds.min;
  return { x: want[0]! - got[0], y: want[1]! - got[1], z: Math.max(0, want[2]! - got[2]) };
}

/**
 * How Separate into plate objects splits an object: by the solids of its STEP file when that file holds more than
 * one, so pieces whose cut faces touch stay apart, and by mesh shells otherwise (STL, 3MF, and a one-solid STEP).
 * `solids` is undefined until the kernel has counted them.
 */
export function separateBy(fileName: string, solids: number | undefined): "solids" | "shells" {
  return /\.(step|stp)$/i.test(fileName) && solids !== undefined && solids >= 2 ? "solids" : "shells";
}
