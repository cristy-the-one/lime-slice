import type { Page } from "@playwright/test";

export interface FrameSample {
  ms: number;
  calls: number;
  instances: number;
  /** True when the frame was drawn with the moving-camera path. */
  low?: boolean;
}

/**
 * Mid-orbit frames. The first frame drawn with the camera moving still carries the idle gap
 * since the view settled, so that one warm-up frame is dropped. Every later moving frame is kept.
 */
export function orbitFrames(samples: FrameSample[]): FrameSample[] {
  const moving = samples.filter((sample) => sample.calls > 0 && sample.ms > 0 && sample.low === true);
  return moving.slice(1);
}

/** How many warm-up frames {@link orbitFrames} drops. The idle gap is that one first moving frame. */
export const ORBIT_WARMUP_FRAMES = 1;

/** Counts WebGL draws in the preview frames `view3d` records while `__previewPerf` is set. */
export async function watchGl(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __gl: { draws: number; instances: number } };
    w.__gl = { draws: 0, instances: 0 };
    const wrap = (proto: object, name: string, inst: number) => {
      const host = proto as Record<string, (...args: unknown[]) => unknown>;
      const orig = host[name];
      if (typeof orig !== "function") return;
      host[name] = function (this: unknown, ...args: unknown[]) {
        w.__gl.draws += 1;
        if (inst >= 0) w.__gl.instances += Number(args[inst] ?? 0);
        return orig.apply(this, args);
      };
    };
    for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
      wrap(proto, "drawArrays", -1);
      wrap(proto, "drawElements", -1);
      // drawArraysInstanced(mode, first, count, primcount); drawElementsInstanced's primcount is the fifth argument.
      wrap(proto, "drawArraysInstanced", 3);
      wrap(proto, "drawElementsInstanced", 4);
    }
  });
}

/** Steady preview frames. `pump` keeps drawing after the camera has settled. */
export async function previewFrames(page: Page, ms: number, pump: boolean): Promise<FrameSample[]> {
  await page.evaluate((on) => {
    const w = window as unknown as { __gl: { draws: number; instances: number }; __previewPerf: FrameSample[]; __previewPump: boolean };
    w.__gl.draws = 0;
    w.__gl.instances = 0;
    w.__previewPerf = [];
    w.__previewPump = on;
  }, pump);
  if (pump) {
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForTimeout(150);
  }
  await page.evaluate(() => {
    (window as unknown as { __previewPerf: FrameSample[] }).__previewPerf = [];
  });
  await page.waitForTimeout(ms);
  return page.evaluate(() => {
    const w = window as unknown as { __previewPump: boolean; __previewPerf: FrameSample[] };
    w.__previewPump = false;
    const samples = w.__previewPerf.filter((sample) => sample.calls > 0 && sample.ms > 0);
    w.__previewPerf = [];
    return samples;
  });
}

export function frameStats(samples: FrameSample[]) {
  const mid = (values: number[]) => {
    const xs = [...values].sort((a, b) => a - b);
    return xs.length ? xs[Math.floor((xs.length - 1) / 2)] : 0;
  };
  const p95 = (values: number[]) => {
    const xs = [...values].sort((a, b) => a - b);
    if (!xs.length) return 0;
    return xs[Math.min(xs.length - 1, Math.ceil(0.95 * xs.length) - 1)];
  };
  const ms = samples.map((s) => s.ms);
  return {
    n: samples.length,
    medianMs: +mid(ms).toFixed(2),
    p95Ms: +p95(ms).toFixed(2),
    draws: Math.round(mid(samples.map((s) => s.calls))),
    instances: Math.round(mid(samples.map((s) => s.instances))),
  };
}
