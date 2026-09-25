import fs from "node:fs";
import { test } from "@playwright/test";
import { buildPreviewGeometry, type GeomLayer } from "../src/preview-geom";

function stack(height: number): GeomLayer[] {
  const layers: GeomLayer[] = [];
  for (let i = 1; i <= 8; i++) {
    const z = i * 0.2;
    layers.push({
      z,
      height,
      paths: [
        { kind: "outer", pts: [[0, 0], [18, 0]], width: 0.45 },
        { kind: "inner", pts: [[0, 0.5], [18, 0.5]], width: 0.45 },
        { kind: "sparse", pts: [[0, 1.0], [18, 1.0]], width: 0.45 },
      ],
    });
  }
  return layers;
}

test("side view of extruded beads is a solid stack", async ({ page }) => {
  const flat = buildPreviewGeometry({
    layers: stack(0.012),
    min: [0, -1, 0],
    max: [18, 2, 2],
    hidden: [],
    showTravel: false,
    colorMode: "feature",
  });
  const thick = buildPreviewGeometry({
    layers: stack(0.2),
    min: [0, -1, 0],
    max: [18, 2, 2],
    hidden: [],
    showTravel: false,
    colorMode: "feature",
  });
  await page.setViewportSize({ width: 1100, height: 520 });
  await page.setContent(`<!doctype html><body style="margin:0;background:#12141c">
    <canvas id="c" width="1100" height="520"></canvas></body>`);
  await page.evaluate(
    ({ flatPos, flatCol, thickPos, thickCol }) => {
      const canvas = document.getElementById("c") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#12141c";
      ctx.fillRect(0, 0, 1100, 520);
      const paint = (pos: number[], col: number[], ox: number, oy: number, scale: number) => {
        for (let i = 0; i < pos.length; i += 9) {
          const pts = [0, 1, 2].map((k) => {
            const x = pos[i + k * 3];
            const y = pos[i + k * 3 + 1];
            return [ox + x * scale, oy - y * scale] as const;
          });
          ctx.beginPath();
          ctx.moveTo(pts[0][0], pts[0][1]);
          ctx.lineTo(pts[1][0], pts[1][1]);
          ctx.lineTo(pts[2][0], pts[2][1]);
          ctx.closePath();
          const r = Math.round(col[i] * 255);
          const g = Math.round(col[i + 1] * 255);
          const b = Math.round(col[i + 2] * 255);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fill();
        }
      };
      ctx.fillStyle = "#d7d2c8";
      ctx.font = "20px sans-serif";
      ctx.fillText("Before — flat ribbons, side camera", 36, 36);
      ctx.fillText("After — layer-height beads", 580, 36);
      paint(flatPos, flatCol, 80, 420, 42);
      paint(thickPos, thickCol, 620, 420, 42);
    },
    {
      flatPos: flat.ribbon,
      flatCol: flat.ribbonColor,
      thickPos: thick.ribbon,
      thickCol: thick.ribbonColor,
    },
  );
  fs.mkdirSync("/opt/cursor/artifacts", { recursive: true });
  await page.screenshot({ path: "/opt/cursor/artifacts/side-beads-before-after.png" });
});
