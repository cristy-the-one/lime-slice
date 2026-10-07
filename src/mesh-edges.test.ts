import * as THREE from "three";
import { sharpEdges } from "./mesh-edges.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function threeEdges(soup: Float32Array, deg: number): Float32Array {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(soup, 3));
  return new THREE.EdgesGeometry(geometry, deg).getAttribute("position").array as Float32Array;
}

function same(name: string, soup: Float32Array, deg = 25): void {
  const want = threeEdges(soup, deg);
  const got = sharpEdges(soup, deg);
  const at = want.findIndex((v, i) => v !== got[i]);
  check(name, got.length === want.length && at === -1, `${got.length / 6} segments, three.js ${want.length / 6}, first difference at ${at}`);
}

function soupOf(tris: number[][][]): Float32Array {
  return new Float32Array(tris.flat(2));
}

function cube(s: number): Float32Array {
  const p = (x: number, y: number, z: number) => [x * s, y * s, z * s];
  const quads = [
    [p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)],
    [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)],
    [p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)],
    [p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)],
    [p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)],
    [p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)],
  ];
  return soupOf(quads.flatMap(([a, b, c, d]) => [[a!, b!, c!], [a!, c!, d!]]));
}

/** A UV sphere whose radius wobbles, so neighbor faces bend by a spread of angles around 25°. */
function bumpySphere(rows: number, cols: number): Float32Array {
  const at = (i: number, j: number) => {
    const th = (Math.PI * i) / rows;
    const ph = (2 * Math.PI * j) / cols;
    const r = 10 + 1.5 * Math.sin(5 * th) * Math.cos(7 * ph) + 0.4 * Math.sin(31 * th + 17 * ph);
    return [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th)];
  };
  const tris: number[][][] = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      tris.push([a, b, c], [a, c, d]);
    }
  }
  return soupOf(tris);
}

function cylinder(facets: number): Float32Array {
  const ring = (z: number) => Array.from({ length: facets }, (_, k) => [10 * Math.cos((2 * Math.PI * k) / facets), 10 * Math.sin((2 * Math.PI * k) / facets), z]);
  const lo = ring(0), hi = ring(20);
  const tris: number[][][] = [];
  for (let k = 0; k < facets; k++) {
    const n = (k + 1) % facets;
    tris.push([lo[k]!, lo[n]!, hi[n]!], [lo[k]!, hi[n]!, hi[k]!], [[0, 0, 0], lo[n]!, lo[k]!], [[0, 0, 20], hi[k]!, hi[n]!]);
  }
  return soupOf(tris);
}

same("a cube draws its 12 edges as three.js does", cube(20));
same("a 64-facet cylinder draws only its rims", cylinder(64));
same("a lone triangle draws its three open edges", soupOf([[[0, 0, 0], [1, 0, 0], [0, 1, 0]]]));
same("a sliver triangle is skipped", soupOf([[[0, 0, 0], [1, 0, 0], [0.00001, 0, 0]], [[0, 0, 0], [1, 0, 0], [0, 1, 0]]]));
same("an edge three faces share", soupOf([[[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 0, 0], [0, -1, 0]], [[1, 0, 0], [0, 0, 0], [0, 0, 1]]]));
same("a bumpy sphere at 25°", bumpySphere(100, 100));
same("a bumpy sphere at 1°", bumpySphere(40, 60), 1);
check("a cube has 12 edges", sharpEdges(cube(20), 25).length === 12 * 6);

if (failed) throw new Error(`${failed} mesh-edges checks failed`);
console.log("mesh-edges: ok");
