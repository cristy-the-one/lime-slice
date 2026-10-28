import { trackpadTurn } from "./trackpad-orbit.ts";

let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name} ${detail}`);
}

// A scroll of the whole canvas height turns the view a full turn, as a left drag of that length does in OrbitControls.
const full = trackpadTurn(0, -500, 500, 1);
check("fingers up the whole height turn a full turn up", Math.abs(full.up - 2 * Math.PI) < 1e-12 && full.left === 0, JSON.stringify(full));
const side = trackpadTurn(25, 0, 500, 1);
check("fingers to the left turn the view left, as a drag to the left does", Math.abs(side.left + Math.PI / 10) < 1e-12, JSON.stringify(side));
const slow = trackpadTurn(25, 0, 500, 0.5);
check("rotateSpeed scales it", Math.abs(slow.left - side.left / 2) < 1e-12);
const flat = trackpadTurn(10, 10, 0, 1);
check("a canvas with no height still gives a finite turn", Number.isFinite(flat.left) && Number.isFinite(flat.up));

if (failed > 0) {
  console.error(`trackpad-orbit: ${failed} failed`);
  process.exit(1);
}
console.log("trackpad orbit: two-finger turn ok");
