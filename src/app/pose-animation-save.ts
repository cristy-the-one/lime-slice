/** Off-screen Pose animation export, loaded only when Save is opened. */
import { applyPose, type Affine } from "../model-space.ts";
import { PosePlayback } from "../pose-playback.ts";
import type { PoseView } from "../pose-view.ts";
import type { PoseAnimationState } from "./pose.ts";

interface SaveContext {
  current: PoseAnimationState;
  view: PoseView;
  shift: Affine;
  active(): PoseAnimationState | null;
  isPose(): boolean;
  sync(): void;
  render(): void;
}

export function showAnimationSave(context: SaveContext): void {
  const current = context.current;
  const view = context.view;
  const sceneShift = context.shift;
  current.clock.pause(performance.now());
  const dialog = document.createElement("dialog"); dialog.className = "pose-animation-save"; dialog.setAttribute("aria-label", "Save animation");
  const title = document.createElement("h2"); title.textContent = "Save animation"; dialog.append(title);
  const field = (label: string, control: HTMLElement) => { const wrap = document.createElement("label"); wrap.textContent = label; wrap.append(control); dialog.append(wrap); };
  const format = document.createElement("select"); format.setAttribute("aria-label", "Animation format");
  for (const [value, text] of [["gif", "GIF"], ["png", "PNG frames"]]) { const option = document.createElement("option"); option.value = value!; option.textContent = text!; format.append(option); }
  field("Format", format);
  const size = document.createElement("input"); size.type = "number"; size.min = "320"; size.max = "1920"; size.step = "1"; size.value = "640"; size.setAttribute("aria-label", "Animation size"); field("Long edge (px)", size);
  const fps = document.createElement("input"); fps.type = "number"; fps.min = "1"; fps.max = "60"; fps.step = "1"; fps.value = String(current.result.fps); fps.setAttribute("aria-label", "Animation FPS"); field("Frames per second", fps);
  const camera = document.createElement("select"); camera.setAttribute("aria-label", "Animation camera");
  for (const [value, text] of [["view", "This view"], ["script", "Script camera"]]) { const option = document.createElement("option"); option.value = value!; option.textContent = text!; option.disabled = value === "script" && !current.camera; camera.append(option); }
  camera.value = current.camera ? "script" : "view"; field("Camera", camera);
  const swatchesOn = document.createElement("input"); swatchesOn.type = "checkbox"; swatchesOn.setAttribute("aria-label", "Use member colours"); field("Use member colours", swatchesOn);
  const swatches = new Map<string, HTMLInputElement>();
  for (const part of current.parts) {
    const input = document.createElement("input"); input.type = "color"; input.value = current.result.frames[0]?.colors.get(part.object) ?? "#a0a0a0"; input.setAttribute("aria-label", `${part.name} colour`); swatches.set(part.object, input); field(part.name, input);
  }
  const status = document.createElement("p"); status.setAttribute("role", "status"); dialog.append(status);
  const actions = document.createElement("div"); actions.className = "pose-buttons"; dialog.append(actions);
  const save = document.createElement("button"); save.type = "button"; save.className = "btn"; save.textContent = "Save"; actions.append(save);
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn"; cancel.textContent = "Cancel"; actions.append(cancel);
  let cancelled = false;
  cancel.addEventListener("click", () => { cancelled = true; if (!save.disabled) dialog.close(); });
  dialog.addEventListener("cancel", (event) => { if (save.disabled) { event.preventDefault(); cancelled = true; } });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  save.addEventListener("click", () => {
    void (async () => {
      const px = Number(size.value), rate = Number(fps.value);
      if (!Number.isInteger(px) || px < 320 || px > 1920 || !Number.isInteger(rate) || rate < 1 || rate > 60) { status.textContent = "Choose a size from 320 to 1920 and an FPS from 1 to 60."; return; }
      if (context.active() !== current || !view || !sceneShift) { status.textContent = "The animation is no longer active."; return; }
      save.disabled = true; cancelled = false;
      const oldResult = current.result, oldClock = current.clock, oldSwatches = current.swatches;
      let capture: ReturnType<PoseView["beginCapture"]> | null = null;
      try {
        const { sampleAnimation } = await import("../pose-anim.ts");
        const sampled = sampleAnimation({ ...current.spec, fps: rate }, current.original, (id) => current.poses.get(id), current.parts);
        if ("issues" in sampled) throw new Error(sampled.issues.map((issue) => `${issue.line ? `line ${issue.line}: ` : ""}${issue.reason}`).join("; "));
        if (sampled.frames.length * px * px * 3 > 256 * 1024 * 1024) throw new Error("This export is too large. Lower its size, duration or FPS.");
        current.result = sampled; current.clock = new PosePlayback(sampled.frames.length, sampled.fps);
        current.swatches = swatchesOn.checked ? new Map([...swatches].map(([id, input]) => [id, input.value])) : undefined;
        const raw = current.camera as { direction?: unknown; up?: unknown } | undefined;
        const vector = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
        let preset: Parameters<PoseView["beginCapture"]>[1];
        if (camera.value === "script") {
          if (!sampled.bounds || !vector(raw?.direction) || (raw.up !== undefined && !vector(raw.up))) throw new Error("The animation camera is invalid.");
          preset = { bounds: { min: applyPose(sceneShift, sampled.bounds.min), max: applyPose(sceneShift, sampled.bounds.max) }, direction: raw.direction, ...(raw.up ? { up: raw.up as [number, number, number] } : {}) };
        }
        capture = view.beginCapture(px, preset);
        const gifFrames: { rgb: Uint8Array; delayCs: number }[] = [];
        const pngFrames: { name: string; bytes: Uint8Array }[] = [];
        for (let i = 0; i < sampled.frames.length; i++) {
          if (cancelled || context.active() !== current || !context.isPose()) throw new Error("Animation export cancelled.");
          current.clock.seek(i); context.sync();
          const frame = await capture.frame(format.value === "png");
          if (format.value === "gif") gifFrames.push({ rgb: frame.rgb, delayCs: Math.round((i + 1) * 100 / rate) - Math.round(i * 100 / rate) });
          else pngFrames.push({ name: `frame-${String(i + 1).padStart(3, "0")}.png`, bytes: frame.png! });
          status.textContent = `Rendering frame ${i + 1} / ${sampled.frames.length}`;
        }
        if (cancelled) throw new Error("Animation export cancelled.");
        const { saveBytes, saveBytesToFolder } = await import("./save-bytes.ts");
        if (format.value === "gif") {
          const { animatedGif } = await import("../animation-gif.ts");
          await saveBytes(animatedGif(px, px, gifFrames), "animation.gif", "gif", "image/gif");
        } else if ((await import("../platform.ts")).isDesktopShell()) {
          await saveBytesToFolder(pngFrames, "image/png");
        } else {
          const { zipSync } = await import("fflate");
          await saveBytes(zipSync(Object.fromEntries(pngFrames.map((frame) => [frame.name, frame.bytes])), { level: 0 }), "animation-frames.zip", "zip", "application/zip");
        }
        dialog.close();
      } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
      finally {
        capture?.dispose(); current.result = oldResult; current.clock = oldClock; current.swatches = oldSwatches;
        if (context.active() === current && context.isPose()) { context.sync(); context.render(); }
        save.disabled = false;
        if (cancelled && dialog.open) dialog.close();
      }
    })();
  });
  document.body.append(dialog); dialog.showModal();
}

