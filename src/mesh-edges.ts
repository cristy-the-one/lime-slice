/**
 * The segments three.js `EdgesGeometry` draws for a non-indexed triangle soup, in the same order:
 * an edge whose two faces bend more than `thresholdDeg`, or that has one face only.
 * Vertices join at 1e-4 mm as there. Integer tables replace its string keys, which took 1.2 s on a 475k-triangle mesh.
 */
export function sharpEdges(positions: Float32Array, thresholdDeg: number): Float32Array {
  const thresholdDot = Math.cos((Math.PI / 180) * thresholdDeg);
  const verts = Math.floor(positions.length / 9) * 3;
  const ids = vertexIds(positions, verts);

  const size = tableSize(verts);
  const mask = size - 1;
  const from = new Int32Array(size).fill(-1);
  const to = new Int32Array(size);
  const first = new Int32Array(size);
  const live = new Uint8Array(size);
  const normals = new Float64Array(size * 3);
  const order = new Int32Array(verts);
  let stored = 0;

  const find = (a: number, b: number) => {
    let slot = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b)) & mask;
    while (from[slot] !== -1 && (from[slot] !== a || to[slot] !== b)) slot = (slot + 1) & mask;
    return slot;
  };

  const out = new Float32Array(verts * 6);
  let n = 0;
  const push = (v: number) => {
    out[n++] = positions[v * 3]!;
    out[n++] = positions[v * 3 + 1]!;
    out[n++] = positions[v * 3 + 2]!;
  };

  for (let t = 0; t < verts; t += 3) {
    const a = ids[t]!;
    const b = ids[t + 1]!;
    const c = ids[t + 2]!;
    if (a === b || b === c || c === a) continue;
    const [nx, ny, nz] = faceNormal(positions, t);
    for (let j = 0; j < 3; j++) {
      const v0 = t + j;
      const v1 = t + ((j + 1) % 3);
      const reverse = find(ids[v1]!, ids[v0]!);
      if (from[reverse] !== -1 && live[reverse]) {
        if (nx * normals[reverse * 3]! + ny * normals[reverse * 3 + 1]! + nz * normals[reverse * 3 + 2]! <= thresholdDot) {
          push(v0);
          push(v1);
        }
        live[reverse] = 0;
        continue;
      }
      const slot = find(ids[v0]!, ids[v1]!);
      if (from[slot] !== -1) continue;
      from[slot] = ids[v0]!;
      to[slot] = ids[v1]!;
      first[slot] = v0;
      live[slot] = 1;
      normals[slot * 3] = nx;
      normals[slot * 3 + 1] = ny;
      normals[slot * 3 + 2] = nz;
      order[stored++] = slot;
    }
  }
  for (let i = 0; i < stored; i++) {
    const slot = order[i]!;
    if (!live[slot]) continue;
    const v0 = first[slot]!;
    push(v0);
    push(v0 - (v0 % 3) + ((v0 % 3) + 1) % 3);
  }
  return out.slice(0, n);
}

/** One id per position after rounding each coordinate to 1e-4. */
function vertexIds(positions: Float32Array, verts: number): Int32Array {
  const keys = new Int32Array(verts * 3);
  for (let i = 0; i < verts * 3; i++) keys[i] = Math.round(positions[i]! * 1e4);
  const size = tableSize(verts);
  const mask = size - 1;
  const owner = new Int32Array(size).fill(-1);
  const ids = new Int32Array(verts);
  for (let v = 0; v < verts; v++) {
    const x = keys[v * 3]!;
    const y = keys[v * 3 + 1]!;
    const z = keys[v * 3 + 2]!;
    let slot = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;
    for (;;) {
      const o = owner[slot]!;
      if (o === -1) {
        owner[slot] = v;
        ids[v] = v;
        break;
      }
      if (keys[o * 3] === x && keys[o * 3 + 1] === y && keys[o * 3 + 2] === z) {
        ids[v] = o;
        break;
      }
      slot = (slot + 1) & mask;
    }
  }
  return ids;
}

/** three.js `Triangle.getNormal`: (c − b) × (a − b), unit length, or zero for a sliver. */
function faceNormal(p: Float32Array, t: number): [number, number, number] {
  const ax = p[t * 3]!, ay = p[t * 3 + 1]!, az = p[t * 3 + 2]!;
  const bx = p[t * 3 + 3]!, by = p[t * 3 + 4]!, bz = p[t * 3 + 5]!;
  const cx = p[t * 3 + 6]!, cy = p[t * 3 + 7]!, cz = p[t * 3 + 8]!;
  const ux = cx - bx, uy = cy - by, uz = cz - bz;
  const vx = ax - bx, vy = ay - by, vz = az - bz;
  const x = uy * vz - uz * vy;
  const y = uz * vx - ux * vz;
  const z = ux * vy - uy * vx;
  const lengthSq = x * x + y * y + z * z;
  if (lengthSq <= 0) return [0, 0, 0];
  const inv = 1 / Math.sqrt(lengthSq);
  return [x * inv, y * inv, z * inv];
}

function tableSize(entries: number): number {
  let size = 16;
  while (size < entries * 2) size *= 2;
  return size;
}
