import { coverageWarning, feed, fnv1aHex, inAirWarning, meshKeyHex, partFrameKey, quietRefresh, recipeKey, sliceAction, sliceBusyLabel, sliceErrorRetryable, storesReply } from "./slice-action.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? "" : `got ${JSON.stringify(actual)}`);
}

const none = sliceAction({ cached: false, settingsChanged: false, force: false });
eq("none state", none.state, "none");
eq("none label", none.label, "Slice");
eq("none reslice", none.reslice, false);
eq("none recompute", none.recompute, true);

const cached = sliceAction({ cached: true, settingsChanged: false, force: false });
eq("cached state", cached.state, "cached");
eq("cached label", cached.label, "Show result");
eq("cached reslice", cached.reslice, false);
eq("cached recompute", cached.recompute, false);

const returned = sliceAction({ cached: true, settingsChanged: true, force: false });
eq("cached after settings return", returned.state, "cached");
eq("cached after settings return label", returned.label, "Show result");
eq("cached after settings return recompute", returned.recompute, false);

const changed = sliceAction({ cached: false, settingsChanged: true, force: false });
eq("changed state", changed.state, "changed");
eq("changed label", changed.label, "Re-slice");
eq("changed reslice", changed.reslice, false);
eq("changed recompute", changed.recompute, true);

const force = sliceAction({ cached: true, settingsChanged: false, force: true });
eq("force state", force.state, "force");
eq("force label", force.label, "Force re-slice");
eq("force reslice", force.reslice, true);
eq("force recompute", force.recompute, true);

const forceOnChange = sliceAction({ cached: true, settingsChanged: true, force: true });
eq("force still wins when the shown result differs", forceOnChange.state, "force");
eq("force still sends reslice", forceOnChange.reslice, true);

const forceMiss = sliceAction({ cached: false, settingsChanged: true, force: true });
eq("force on a miss stays a real re-slice", forceMiss.state, "changed");
eq("force on a miss does not pretend to bypass a cache", forceMiss.reslice, false);
eq("force on a miss still recomputes", forceMiss.recompute, true);

const forceFresh = sliceAction({ cached: false, settingsChanged: false, force: true });
eq("force with nothing cached is Slice", forceFresh.state, "none");
eq("force with nothing cached does not set reslice", forceFresh.reslice, false);

eq("busy recompute", sliceBusyLabel(true), "Slicing…");
eq("busy cache load", sliceBusyLabel(false), "Loading…");
check("an error that names a field is not worth a retry", !sliceErrorRetryable("belt.raftLayers needs a fixed layer height; turn adaptive layers off") && !sliceErrorRetryable("printOrder \"sequential\" is not available on a belt printer"));
check("a server failure and an unreadable reply are", sliceErrorRetryable("slice failed (502)") && sliceErrorRetryable("Unexpected end of JSON input"));

const speed = { mode: "single", strategy: "speed" };
const keyA = recipeKey({ layerHeight: 0.2, reslice: true, blend: speed, dataB64: "abc" }, "mesh-a");
const keyB = recipeKey({ blend: { strategy: "speed", mode: "single" }, layerHeight: 0.2 }, "mesh-a");
eq("recipe key ignores reslice, dataB64, and key order", keyA, keyB);
check("layer height changes the recipe", recipeKey({ layerHeight: 0.28, blend: speed }, "mesh-a") !== keyA);
check("mesh bytes change the recipe", recipeKey({ layerHeight: 0.2, blend: speed }, "mesh-b") !== keyA);
eq(
  "unset edit fields leave the recipe as it was before edits existed",
  recipeKey({ layerHeight: 0.2, blend: speed, supportEdits: undefined, includeSkeleton: undefined }, "mesh-a"),
  '{"blend":{"mode":"single""strategy":"speed"}"layerHeight":0.2}\nmesh-a',
);
eq(
  "a prune edit is part of the recipe",
  recipeKey({ layerHeight: 0.2, blend: speed, supportEdits: [{ kind: "prune", sites: [{ xy: [1, 2], z: 3 }] }] }, "mesh-a"),
  '{"blend":{"mode":"single""strategy":"speed"}"layerHeight":0.2"supportEdits":[{"kind":"prune""sites":[{"xy":[1,2,]"z":3},]},]}\nmesh-a',
);

const posed = (translation: number[], rotation = [1, 0, 0, 0, 1, 0, 0, 0, 1]) => ({
  layerHeight: 0.2,
  blend: speed,
  pose: { rotation, pivot: [10, 10, 5], translation },
});
const home = partFrameKey(posed([110, 110, 5]), "mesh-a");
eq("an X/Y move keeps the part frame", partFrameKey(posed([140, 95, 5]), "mesh-a"), home);
check("an X/Y move is still a new recipe", recipeKey(posed([140, 95, 5]), "mesh-a") !== recipeKey(posed([110, 110, 5]), "mesh-a"));
check("a Z move leaves the part frame", partFrameKey(posed([110, 110, 7]), "mesh-a") !== home);
check("a rotation leaves the part frame", partFrameKey(posed([110, 110, 5], [0, -1, 0, 1, 0, 0, 0, 0, 1]), "mesh-a") !== home);
check("a setting leaves the part frame", partFrameKey({ ...posed([140, 95, 5]), layerHeight: 0.28 }, "mesh-a") !== home);
check("other mesh bytes leave the part frame", partFrameKey(posed([110, 110, 5]), "mesh-b") !== home);
eq("no pose, the part frame is the recipe", partFrameKey({ layerHeight: 0.2 }, "mesh-a"), recipeKey({ layerHeight: 0.2 }, "mesh-a"));
const plate = (bx: number, bSettings: Record<string, unknown> = {}) => ({
  layerHeight: 0.2,
  objects: [
    { id: "a", ...posed([60, 110, 5]) },
    { id: "b", ...posed([bx, 110, 5]), settings: bSettings },
  ],
});
eq("a move of any plate object keeps the part frame", partFrameKey(plate(170), "plate"), partFrameKey(plate(150), "plate"));
check("a plate object's setting leaves the part frame", partFrameKey(plate(150, { supports: false }), "plate") !== partFrameKey(plate(150), "plate"));

const before = { frame: "frame-a", recipe: "recipe-a1" };
eq("the first reply is stored", storesReply(null, before), true);
eq("a pure move is not stored", storesReply(before, { frame: "frame-a", recipe: "recipe-a2" }), false);
eq("a tweak is stored", storesReply(before, { frame: "frame-b", recipe: "recipe-b1" }), true);
eq("the same recipe again is stored", storesReply(before, before), true);

eq("a fresh result needs no refresh", quietRefresh({ stale: false, cached: true, sameFrame: true }), false);
eq("an X/Y move refreshes on its own, after a disk-cache load too", quietRefresh({ stale: true, cached: false, sameFrame: true }), true);
eq("a stored recipe refreshes on its own", quietRefresh({ stale: true, cached: true, sameFrame: false }), true);
eq("a new recipe waits for Slice", quietRefresh({ stale: true, cached: false, sameFrame: false }), false);

eq("feed sorts object keys and writes no commas", feed({ b: 1, a: true }), '{"a":true"b":1}');
eq("feed keeps array order and a trailing comma", feed([1, 2]), "[1,2,]");
eq("same bytes, same fingerprint", fnv1aHex(new Uint8Array([1, 2, 3])), fnv1aHex(new Uint8Array([1, 2, 3])));
check("different bytes, different fingerprint", fnv1aHex(new Uint8Array([1, 2, 3])) !== fnv1aHex(new Uint8Array([1, 2, 4])));
const ascii = (text: string) => new TextEncoder().encode(text);
eq("FNV-1a 64 of nothing", fnv1aHex(new Uint8Array()), "cbf29ce484222325");
eq("FNV-1a 64 of a", fnv1aHex(ascii("a")), "af63dc4c8601ec8c");
eq("FNV-1a 64 of foobar", fnv1aHex(ascii("foobar")), "85944171f73967e8");
const megabyte = new Uint8Array(1 << 20);
for (let i = 0; i < megabyte.length; i++) megabyte[i] = Math.imul(i, 2654435761) >>> 24;
eq("a megabyte keeps the fingerprint saved projects carry", fnv1aHex(megabyte), "1fd4120eb1b09c60");
const stl = megabyte.subarray(0, 84 + 50 * 7);
eq("same mesh bytes, same session key", meshKeyHex(stl), meshKeyHex(stl.slice()));
check("a changed word changes the session key", meshKeyHex(stl) !== meshKeyHex(Uint8Array.from(stl, (b, i) => (i === 100 ? b ^ 1 : b))));
check("a changed tail byte changes the session key", meshKeyHex(stl) !== meshKeyHex(Uint8Array.from(stl, (b, i) => (i === stl.length - 1 ? b ^ 1 : b))));
eq("an unaligned view keys as its bytes do", meshKeyHex(megabyte.subarray(3, 3 + 434)), meshKeyHex(megabyte.slice(3, 3 + 434)));

eq("no coverage gaps, no warning", coverageWarning([]), null);
eq("one coverage gap", coverageWarning([{ areaMm2: 16 }]), "Supports leave 1 overhang patch unheld, 16.0 mm² in all.");
eq(
  "coverage gaps add up",
  coverageWarning([{ areaMm2: 375.24 }, { areaMm2: 2.5 }]),
  "Supports leave 2 overhang patches unheld, 377.7 mm² in all.",
);
eq("supports on, no air report", inAirWarning(undefined), null);
eq("supports off, nothing floats", inAirWarning({ islands: 0, overhangs: 0 }), null);
eq(
  "supports off, an island and two overhangs",
  inAirWarning({ islands: 1, overhangs: 2 }),
  "Supports are off. 1 island and 2 overhangs would print in the air.",
);
eq("supports off, overhangs only", inAirWarning({ islands: 0, overhangs: 1 }), "Supports are off. 1 overhang would print in the air.");

if (failed) throw new Error(`${failed} slice-action checks failed`);
console.log("slice-action: none, cached, changed, force ok");
