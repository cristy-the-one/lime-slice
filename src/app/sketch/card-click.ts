/** The click handler of the sketch cards. */
import { S } from "./state";
import { aboveOpen, addShapeAbove, backToLoft, cancelAbove, closeTheGap } from "./above";
import { leaveDemo, openDemo } from "./demo";
import { beginExtrude, commitExtrude, endExtrude, startOnFace } from "./extrude";
import { featureEdit } from "./feature";
import { pickListedAxis } from "./feature-strip";
import { beginHoles, drillEvery, dropAsk } from "./holes";
import { leaveEditing } from "./keys";
import { beginLoft, commitLoft, endLoft, takeLoftSketch } from "./loft";
import { endProfile } from "./profile";
import { armRevolveProbe, beginRevolve, commitRevolve, endRevolve } from "./revolve";
import { armSweepProbe, beginSweep, commitSweep, endSweep, madeSweep, roundedSweep, takeSweepSketch } from "./sweep";
import { enterNamed, publish, showMarks } from "./view";
import { pushToast } from "../../ui/toasts";
import { DEMO_KINDS, EDIT_DEMO_KINDS, type DemoKind } from "../../sketch/demos";
import { withWall, withTool, applyConstraint, withLook, activeSketch, finishSketch, sketchKey, reopenSketch, discardSketch } from "../../sketch/session";
import { isDrawTool } from "../../sketch/tools";
import { namesOpenEnds } from "../../sketch/reasons";
import { isConstrainTool } from "../../sketch/constrain";
import { cycleMode } from "../../sketch/extrude";
import { flipAxis } from "../../sketch/revolve";

export function installCardClicks(): void {
  S.cards?.addEventListener("click", (ev) => {
    // The card waits while an Apply is on its way, as the keys do.
    if (S.applying || S.holding) return;
    const target = ev.target instanceof Element ? ev.target.closest("button") : null;
    if (!(target instanceof HTMLButtonElement)) return;
    if (target.getAttribute("aria-disabled") === "true") {
      const why = target.dataset.reason || target.dataset.tip || target.title;
      if (namesOpenEnds(why)) showMarks("open");
      if (why) {
        S.host.readout(why);
        pushToast(why, "info");
      }
      return;
    }
    // --- P2. Show me, the Make row's How, and the way out of a demo. ---
    const shown = target.dataset.sketchDemo;
    if (shown && ([...DEMO_KINDS, ...EDIT_DEMO_KINDS] as readonly string[]).includes(shown)) {
      openDemo(shown as DemoKind);
      return;
    }
    if (target.dataset.sketchMakeHow != null) {
      S.makeHowOpen = !S.makeHowOpen;
      S.cardFocus = S.makeHowOpen ? ["#sketchMakeHow [data-sketch-demo]"] : ["[data-sketch-make-how]"];
      publish("skip");
      return;
    }
    if (target.dataset.sketchEditHow != null) {
      S.editHowOpen = !S.editHowOpen;
      S.cardFocus = S.editHowOpen ? ["#sketchEditHow [data-sketch-demo]"] : ["[data-sketch-edit-how]"];
      publish("skip");
      return;
    }
    // O1: Offset's wall options. The offset being typed keeps its line and distance, and its ghost follows.
    const wall = target.dataset.sketchWall;
    if (wall === "both" || wall === "close" || wall === "helper") {
      S.editor = withWall(S.editor, wall);
      S.cardFocus = [`[data-sketch-wall="${wall}"]`];
      publish("values");
      return;
    }
    if (target.dataset.sketchDemoLeave != null) {
      leaveDemo();
      return;
    }
    const plane = target.dataset.sketchPlane;
    if (plane === "XY" || plane === "XZ" || plane === "YZ" || plane === "workplane") {
      enterNamed(plane);
      return;
    }
    const tool = target.dataset.sketchTool;
    const picked = tool === "line" || tool === "rectangle" || tool === "select" || (typeof tool === "string" && isDrawTool(tool)) ? tool : null;
    if (picked) {
      if (S.gesture) endExtrude();
      if (S.revolve) endRevolve();
      if (S.loft) endLoft();
      if (S.sweep) endSweep();
      S.menuOpen = null;
      S.editor = withTool(S.editor, picked);
      publish("open");
      return;
    }
    // --- S4. Constraint commands are menu items on the sketch card. ---
    const constrain = target.dataset.sketchConstrain;
    if (constrain && (constrain === "remove" || isConstrainTool(constrain))) {
      if (S.gesture) endExtrude();
      if (S.revolve) endRevolve();
      if (S.loft) endLoft();
      if (S.sweep) endSweep();
      S.menuOpen = null;
      S.editor = applyConstraint(S.editor, constrain);
      publish("open");
      return;
    }
    if (target.dataset.sketchMenu === "draw" || target.dataset.sketchMenu === "constrain") {
      const which = target.dataset.sketchMenu;
      S.menuOpen = S.menuOpen === which ? null : which;
      // An open menu takes the focus, on its checked item or its first, so the arrow keys move through it.
      const list = `[data-sketch-menu="${which}"] + [role=menu]`;
      S.cardFocus = S.menuOpen ? [`${list} [aria-checked=true]`, `${list} [role^=menuitem]`] : [`[data-sketch-menu="${which}"]`];
      publish("skip");
      return;
    }
    if (target.dataset.sketchExtrude != null) {
      if (S.host.sketchHolesArmed()) S.host.endSketchHoles();
      if (S.revolve) endRevolve();
      if (S.loft) endLoft();
      if (S.sweep) endSweep();
      if (S.gesture) void commitExtrude();
      else beginExtrude();
      return;
    }
    // --- F2. The card's Revolve button. A second click applies, the same as Extrude. ---
    if (target.dataset.sketchRevolve != null) {
      if (S.gesture) endExtrude();
      if (S.loft) endLoft();
      if (S.sweep) endSweep();
      if (S.host.sketchHolesArmed()) S.host.endSketchHoles();
      if (S.revolve) void commitRevolve();
      else beginRevolve();
      return;
    }
    // --- E1. Close the gap: the red ends joined in one undo step. ---
    if (target.dataset.sketchCloseGap != null) {
      closeTheGap();
      return;
    }
    // --- L1. Add a shape above, and the strip of the shape above. ---
    if (target.dataset.sketchAbove != null && S.loft) {
      addShapeAbove();
      return;
    }
    if (target.dataset.sketchAboveDone != null) {
      backToLoft();
      return;
    }
    if (target.dataset.sketchAboveCancel != null) {
      cancelAbove();
      return;
    }
    // --- F3. Loft and sweep live on the card. A second click applies. ---
    if (target.dataset.sketchLoft != null) {
      if (S.gesture) endExtrude();
      if (S.revolve) endRevolve();
      if (S.sweep) endSweep();
      if (S.host.sketchHolesArmed()) S.host.endSketchHoles();
      if (S.loft) void commitLoft();
      else beginLoft();
      return;
    }
    if (target.dataset.sketchSweep != null) {
      if (S.gesture) endExtrude();
      if (S.revolve) endRevolve();
      if (S.loft) endLoft();
      if (S.host.sketchHolesArmed()) S.host.endSketchHoles();
      if (S.sweep) void commitSweep();
      else beginSweep();
      return;
    }
    // --- B20. A revolve turns the other way about the same axis. ---
    if (target.dataset.sketchFlip != null && S.revolve) {
      S.revolve = { ...S.revolve, axis: flipAxis(S.revolve.axis), follow: false };
      publish("open");
      armRevolveProbe();
      return;
    }
    // --- S1. Stand the shape up at the route's start, or keep it as drawn. ---
    if (target.dataset.sketchStance != null && S.sweep?.oneSketch) {
      const stance = S.sweep.oneSketch.stance === "up" ? "drawn" : "up";
      S.sweep = roundedSweep(madeSweep({ ...S.sweep, oneSketch: { ...S.sweep.oneSketch, stance } }));
      S.cardFocus = ["[data-sketch-stance]"];
      publish("open");
      armSweepProbe();
      return;
    }
    // --- S3. Round corners on or off. Off brings the sharp-corner reason back, with its red dot. ---
    if (target.dataset.sketchRound != null && S.sweep?.round) {
      S.sweep = roundedSweep({ ...S.sweep, round: { ...S.sweep.round, on: !S.sweep.round.on } });
      S.cardFocus = ["[data-sketch-round]"];
      publish("open");
      armSweepProbe();
      if (S.sweep.note) S.host.readout(S.sweep.note);
      return;
    }
    if (target.dataset.sketchRuled != null && S.loft) {
      S.loft = { ...S.loft, ruled: !S.loft.ruled, note: "" };
      publish("open");
      return;
    }
    // --- H1. Start on a face, and the answer to "Drill at every point and circle centre?". ---
    if (target.dataset.sketchFaceStart != null) {
      startOnFace();
      return;
    }
    if (target.dataset.sketchDrillYes != null) {
      drillEvery();
      return;
    }
    if (target.dataset.sketchDrillNo != null) {
      dropAsk();
      return;
    }
    // --- V1. A listed axis, picked without hovering. ---
    if (target.dataset.sketchAxis != null && S.revolve) {
      pickListedAxis(target.dataset.sketchAxis);
      return;
    }
    // --- F4. The card button does what H does. It is not a toolbar button. ---
    if (target.dataset.sketchHoles != null) {
      if (S.gesture || S.revolve || S.loft || S.sweep) return;
      beginHoles();
      return;
    }
    if (target.dataset.sketchMode != null && (S.gesture || S.revolve || S.loft || S.sweep)) {
      const asked = target.dataset.sketchMode;
      const picked = asked === "fuse" || asked === "cut" || asked === "new" || asked === "common" || asked === "auto" ? asked : null;
      const next = picked ?? cycleMode(S.sweep ? S.sweep.choice : S.loft ? S.loft.choice : S.revolve ? S.revolve.choice : S.gesture?.choice ?? "auto", featureEdit());
      if (S.sweep) S.sweep = { ...S.sweep, choice: next, note: "" };
      else if (S.loft) S.loft = { ...S.loft, choice: next, note: "" };
      else if (S.revolve) S.revolve = { ...S.revolve, choice: next };
      else if (S.gesture) S.gesture = { ...S.gesture, choice: next };
      // A mode picked with the pointer hands the keyboard back to the size box before the card is redrawn, so the
      // distance can be typed straight after. With no size box open, the rebuilt card keeps focus on the segment.
      S.hud.focus();
      publish("open");
      return;
    }
    if (target.dataset.sketchApply != null) {
      if (S.sweep) void commitSweep();
      else if (S.loft) void commitLoft();
      else if (S.revolve) void commitRevolve();
      else void commitExtrude();
      return;
    }
    if (target.dataset.sketchLook != null) {
      S.editor = withLook(S.editor, !S.editor.lookAround);
      publish("open");
      return;
    }
    if (target.dataset.sketchProfileUse != null) {
      endProfile(activeSketch(S.editor));
      return;
    }
    if (target.dataset.sketchProfileCancel != null) {
      endProfile(null);
      return;
    }
    if (target.dataset.sketchFinish != null) {
      // L1: Finish on the shape above goes back to the loft, with both sections picked.
      if (aboveOpen()) {
        backToLoft();
        return;
      }
      endExtrude();
      endRevolve();
      endLoft();
      endSweep();
      leaveEditing(finishSketch(S.editor));
      return;
    }
    if (target.dataset.sketchCancel != null) {
      // The prompt with Cancel goes away, so the keyboard lands on the button that started the feature.
      const started = S.sweep ? "sweep" : S.loft ? "loft" : S.revolve ? "revolve" : S.gesture ? "extrude" : "";
      if (started) S.cardFocus = [`[data-sketch-${started}]`];
      if (S.sweep) endSweep();
      else if (S.loft) endLoft();
      else if (S.revolve) endRevolve();
      else if (S.gesture) endExtrude();
      else leaveEditing(sketchKey(S.editor, "Escape", { ctrl: false, meta: false, shift: false }) ?? S.editor);
      return;
    }
    const openId = target.dataset.sketchOpen;
    if (openId) {
      const pinnedId = Number(openId);
      if (S.loft) {
        takeLoftSketch(pinnedId);
        return;
      }
      if (S.sweep) {
        takeSweepSketch(pinnedId);
        return;
      }
      S.host.closeTool();
      S.above = null;
      S.editor = reopenSketch(S.editor, pinnedId);
      S.aimKey = "";
      S.refsKey = "";
      publish("open");
      return;
    }
    const dropId = target.dataset.sketchDiscard;
    if (dropId) {
      S.editor = discardSketch(S.editor, Number(dropId));
      publish("open");
    }
  });
}
