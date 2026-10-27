import { GRAB_DEG_PER_PX, grabAxisForKey, grabDegrees, grabIntent, nearerHit } from "./viewport-grab.ts";

let failed = 0;

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const press = (button: number, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}, pointerType = "mouse") => ({
  button,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  altKey: !!mods.alt,
  pointerType,
});

eq("a plain left press grabs nothing, so it still orbits", grabIntent(press(0)), null);
eq("a plain right press grabs nothing, so it still pans", grabIntent(press(2)), null);
eq("Ctrl and the left button move", grabIntent(press(0, { ctrl: true })), "move");
eq("Cmd and the left button move", grabIntent(press(0, { meta: true })), "move");
eq("Ctrl and the right button turn", grabIntent(press(2, { ctrl: true })), "rotate");
eq("Ctrl and the middle button grab nothing", grabIntent(press(1, { ctrl: true })), null);
eq("Alt is left to the window manager", grabIntent(press(0, { ctrl: true, alt: true })), null);
eq("a finger never grabs", grabIntent(press(0, { ctrl: true }, "touch")), null);

eq("X locks the turn to X", grabAxisForKey("x"), "x");
eq("a capital Y still locks to Y", grabAxisForKey("Y"), "y");
eq("Z locks the turn to Z", grabAxisForKey("z"), "z");
eq("another key locks nothing", grabAxisForKey("a"), null);
eq("Escape locks nothing", grabAxisForKey("Escape"), null);

eq("no drag turns nothing", grabDegrees(0), 0);
eq("a rightward drag turns positive", grabDegrees(40), 40 * GRAB_DEG_PER_PX);
eq("a leftward drag turns negative", grabDegrees(-40), -40 * GRAB_DEG_PER_PX);
eq("a full turn is 720 px", grabDegrees(720), 360);

eq("the selected part in front wins", nearerHit(10, 30), "selected");
eq("a grey object in front wins", nearerHit(30, 10), "other");
eq("only the selected part under the ray", nearerHit(12, null), "selected");
eq("only a grey object under the ray", nearerHit(null, 12), "other");
eq("empty space grabs nothing", nearerHit(null, null), null);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("viewport-grab: intents, axis keys, degrees, and picks ok");
