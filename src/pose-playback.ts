/** Playback clock for sampled Pose frames. It owns no project state. */
export class PosePlayback {
  private index = 0;
  private startedAt: number | null = null;
  private startedFrame = 0;
  readonly frameCount: number;
  readonly fps: number;
  constructor(frameCount: number, fps: number) {
    if (!Number.isInteger(frameCount) || frameCount < 1 || !Number.isFinite(fps) || fps <= 0) throw new Error("Playback needs frames and a positive frame rate.");
    this.frameCount = frameCount; this.fps = fps;
  }
  get playing(): boolean { return this.startedAt !== null; }
  /** Current frame, advancing against the supplied monotonic time in milliseconds. */
  frame(now: number): number {
    if (this.startedAt !== null) {
      const advanced = Math.floor(Math.max(0, now - this.startedAt) * this.fps / 1000);
      this.index = Math.min(this.frameCount - 1, this.startedFrame + advanced);
      if (this.startedFrame + advanced >= this.frameCount) this.startedAt = null;
    }
    return this.index;
  }
  play(now: number): void {
    if (this.playing) return;
    if (this.index === this.frameCount - 1) this.index = 0;
    this.startedFrame = this.index; this.startedAt = now;
  }
  pause(now: number): void { this.frame(now); this.startedAt = null; }
  seek(index: number): number {
    if (!Number.isFinite(index)) return this.index;
    this.index = Math.max(0, Math.min(this.frameCount - 1, Math.round(index)));
    this.startedAt = null;
    return this.index;
  }
}
