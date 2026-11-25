/**
 * Temporary measurement for the Windows "ping answers during a slow import" stall.
 * Off unless LIME_MCP_LOOP_DELAY=1. Prints phase times and monitorEventLoopDelay.
 */
import { writeSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";

export const loopDelayOn = process.env.LIME_MCP_LOOP_DELAY === "1";

const histogram = loopDelayOn ? monitorEventLoopDelay({ resolution: 10 }) : null;
if (histogram) histogram.enable();

const phases: string[] = [];
let preambleAt = 0;
let reportTimer: ReturnType<typeof setTimeout> | null = null;

export function markPhase(name: string, ms: number): void {
  if (!loopDelayOn) return;
  phases.push(`${name}=${ms.toFixed(1)}`);
}

export function timePhase<T>(name: string, fn: () => T): T {
  if (!loopDelayOn) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    phases.push(`${name}=${(performance.now() - start).toFixed(1)}`);
  }
}

/** The first line of a tools/call, before synchronous startup. */
export function beginPreamble(): void {
  if (loopDelayOn) preambleAt = performance.now();
}

/**
 * The tool has reached its first yield. Phase times are the synchronous work before that.
 * The histogram is read on a later turn: monitorEventLoopDelay records the stall when the
 * loop next runs, not during the turn that blocked it.
 */
export function endPreamble(where: string): void {
  if (!loopDelayOn || preambleAt === 0) return;
  phases.push(`preamble=${(performance.now() - preambleAt).toFixed(1)}`);
  preambleAt = 0;
  writeSync(2, `loop-phases ${where} ${phases.join(" ")}\n`);
  if (!histogram || reportTimer) return;
  reportTimer = setTimeout(() => {
    reportTimer = null;
    const max = Math.round(histogram.max / 1e6);
    const mean = Number.isFinite(histogram.mean) ? Math.round(histogram.mean / 1e6) : 0;
    writeSync(2, `loop-delay ${where} max=${max} ms mean=${mean} ms n=${histogram.count} ${phases.join(" ")}\n`);
  }, 100);
  reportTimer.unref?.();
}
