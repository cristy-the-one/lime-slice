import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree } from "./model-tree-mock";
import { ZEBRA_FRAGMENT_TEST, ZEBRA_VERTEX_TEST } from "../src/model-view/analysis-shaders";

type V = [number, number, number];

function boxSolid() {
  const [sx, sy, sz] = [20, 20, 10];
  const c = (x: number, y: number, z: number): V => [x * sx, y * sy, z * sz];
  const quads: V[][] = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  const positions: number[] = [];
  const triangles: number[] = [];
  quads.forEach((quad, face) => {
    for (const tri of [[0, 1, 2], [0, 2, 3]]) {
      for (const index of tri) positions.push(...quad[index]!);
      triangles.push(face);
    }
  });
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [] };
}

async function openLook(page: Page) {
  const solid = boxSolid();
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await mockModelTree(page, { open: () => solid });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  const view = page.locator("#modelLookOpen");
  if (!(await view.isVisible())) await page.getByRole("button", { name: "Inspect tools" }).click();
  await view.click();
  await page.locator("#modelShading [data-shading=zebra]").click();
  await expect(page.locator("#model")).toHaveAttribute("data-shading", "zebra");
  await page.locator("#modelZebraAxis [data-zebra-axis=horizontal]").click();
  await expect(page.locator("#modelZebraAxis [data-zebra-axis=horizontal]")).toHaveAttribute("aria-pressed", "true");
}

type Side = { left: number; right: number };

/** Crossings of the stripe boundary on the middle row, left of the seam and right of it. */
function countSides(pixels: number[], width: number): Side {
  const row = Math.floor(pixels.length / width / 4 / 2) * width;
  const dark = (x: number) => {
    const i = (row + x) * 4;
    return pixels[i]! + pixels[i + 1]! + pixels[i + 2]! < 380;
  };
  let left = 0;
  let right = 0;
  const mid = Math.floor(width / 2);
  for (let x = 1; x < width; x += 1) {
    if (dark(x) !== dark(x - 1)) {
      if (x < mid) left += 1;
      else right += 1;
    }
  }
  return { left, right };
}

test("zebra stripes kink across a G1 seam and run on across a G2 seam", async ({ page }) => {
  await openLook(page);
  const read = await page.evaluate(
    ({ fragment, vertex }) => {
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 32;
      const gl = canvas.getContext("webgl2");
      if (!gl) return { error: "no webgl2" };
      const compile = (type: number, source: string) => {
        const shader = gl.createShader(type);
        if (!shader) return null;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return gl.getShaderInfoLog(shader);
        return shader;
      };
      const vs = compile(gl.VERTEX_SHADER, vertex);
      const fs = compile(gl.FRAGMENT_SHADER, fragment);
      if (typeof vs === "string" || typeof fs === "string" || !vs || !fs) return { error: `compile ${vs} ${fs}` };
      const program = gl.createProgram();
      if (!program) return { error: "no program" };
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return { error: gl.getProgramInfoLog(program) ?? "link" };
      gl.useProgram(program);
      const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      gl.uniformMatrix4fv(gl.getUniformLocation(program, "modelViewMatrix"), false, identity);
      gl.uniformMatrix4fv(gl.getUniformLocation(program, "projectionMatrix"), false, identity);
      gl.uniformMatrix4fv(gl.getUniformLocation(program, "modelMatrix"), false, identity);
      gl.uniformMatrix3fv(gl.getUniformLocation(program, "normalMatrix"), false, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
      gl.uniform1f(gl.getUniformLocation(program, "uStripes"), 8);
      gl.uniform1i(gl.getUniformLocation(program, "uAxis"), 1);
      gl.uniform1f(gl.getUniformLocation(program, "uOpacity"), 1);
      const quad = (x0: number, x1: number, z0: number, z1: number) => {
        const y0 = -1;
        const y1 = 1;
        const heading = (z: number) => {
          const nz = Math.max(-1, Math.min(1, z));
          return [Math.sqrt(Math.max(0, 1 - nz * nz)), 0, nz];
        };
        const n0 = heading(z0);
        const n1 = heading(z1);
        const vert = (x: number, y: number, n: number[]) => [x, y, 0, n[0], n[1], n[2]];
        return [
          ...vert(x0, y0, n0), ...vert(x1, y0, n1), ...vert(x1, y1, n1),
          ...vert(x0, y0, n0), ...vert(x1, y1, n1), ...vert(x0, y1, n0),
        ];
      };
      const draw = (data: number[]) => {
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
        const stride = 6 * 4;
        const position = gl.getAttribLocation(program, "position");
        const normal = gl.getAttribLocation(program, "normal");
        gl.enableVertexAttribArray(position);
        gl.enableVertexAttribArray(normal);
        gl.vertexAttribPointer(position, 3, gl.FLOAT, false, stride, 0);
        gl.vertexAttribPointer(normal, 3, gl.FLOAT, false, stride, 12);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, data.length / 6);
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return Array.from(pixels);
      };
      const g1 = draw([...quad(-1, 0, 0.2, 0.8), ...quad(0, 1, 0.8, 0.9)]);
      const g2 = draw([...quad(-1, 0, 0.2, 0.5), ...quad(0, 1, 0.5, 0.8)]);
      return { width: canvas.width, g1, g2 };
    },
    { fragment: ZEBRA_FRAGMENT_TEST, vertex: ZEBRA_VERTEX_TEST },
  );
  expect("error" in read ? read.error : "", "the zebra shader should compile").toBe("");
  if (!("g1" in read) || !("g2" in read) || !read.width) throw new Error(JSON.stringify(read));
  const g1 = countSides(read.g1, read.width);
  const g2 = countSides(read.g2, read.width);
  console.log(`S5 zebra g1 left=${g1.left} right=${g1.right} g2 left=${g2.left} right=${g2.right}`);
  expect(g1.left, "G1 stripes kink: the slope changes across the seam").toBeGreaterThanOrEqual(g1.right + 2);
  expect(Math.abs(g2.left - g2.right), "G2 stripes run on: the same slope on both sides").toBeLessThanOrEqual(1);
});
