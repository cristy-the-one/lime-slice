/** The Draw, Edit and Make tool rows, the footer, and the Constrain menu. */
import { S } from "./state";
import { aboveOpen, aboveStrip, gapToClose } from "./above";
import { textButton, toolButton } from "./cards";
import { demoStrip, makeHow, showMeButton } from "./demo";
import { featureStrip, howControl } from "./feature-strip";
import { ARC_ICON, EDIT_LABELS, MAKE_LABELS, formatHeight, sketchKeyLabel } from "./helpers";
import { askOpen, askStrip } from "./holes";
import { profileNote } from "./profile";
import { markBlocked, startActive, startWhy } from "./starts";
import { type IconNode, PenLine, Square, Circle, Spline, Hexagon, RectangleHorizontal, createElement } from "lucide";
import { keyOf, tipWithShortcut } from "../../ui/commands";
import { EDIT_DEMO_LEAD, EDIT_DEMO_KINDS, DEMOS } from "../../sketch/demos";
import { hasOpenEnds } from "../../sketch/edit";
import { type SketchTool, activeSketch, constrainChoices } from "../../sketch/session";
import { EDIT_BUTTONS, PURPOSE, ASSIST_PURPOSE, MAKE_BUTTONS, REASON } from "../../sketch/reasons";
import { isConstrainTool, CONSTRAIN_MENU } from "../../sketch/constrain";

export function editingRow(): Node[] {
  const feature = S.gesture || S.revolve || S.loft || S.sweep;
  return [
    ...(S.demo ? [demoStrip()] : []),
    sketchSection("Draw", "draw", drawTools()),
    sketchSection("Edit", "edit", editTools()),
    S.profile ? profileStrip() : feature ? featureStrip() : aboveOpen() ? aboveStrip() : askOpen() ? askStrip() : sketchSection("Make", "make", makeTools()),
    sketchFooter(),
  ];
}

/** In place of Make while a split's profile is drawn: its name, what the chain still needs, and How. */
function profileStrip(): HTMLElement {
  const strip = document.createElement("section");
  strip.className = "sketch-section sketch-feature sketch-profile";
  strip.dataset.sketchSection = "profile";
  const head = document.createElement("div");
  head.className = "sketch-feature-row";
  const name = document.createElement("p");
  name.className = "sketch-feature-name";
  name.textContent = "Sketch profile";
  head.append(name, howControl("profile"));
  const note = document.createElement("p");
  note.className = "sketch-profile-note model-note";
  note.id = "sketchProfileNote";
  note.setAttribute("role", "status");
  const sentence = profileNote();
  note.textContent = sentence;
  note.hidden = sentence === "";
  strip.append(head, note);
  return strip;
}

function sketchSection(title: string, kind: string, children: Node[]): HTMLElement {
  const node = document.createElement("section");
  node.className = `sketch-section sketch-section-${kind}`;
  node.dataset.sketchSection = kind;
  const heading = document.createElement("h3");
  heading.className = "sketch-section-title";
  heading.textContent = title;
  const body = document.createElement("div");
  body.className = `sketch-section-body sketch-${kind}`;
  body.append(...children);
  node.append(heading, body);
  return node;
}

/** Line through Slot, in one order, in every sketch state. */
function drawTools(): Node[] {
  const tools: { tool: SketchTool; label: string; id: string; icon: IconNode }[] = [
    { tool: "line", label: "Line", id: "sketch-line", icon: PenLine },
    { tool: "rectangle", label: "Rectangle", id: "sketch-rect", icon: Square },
    { tool: "circle", label: "Circle", id: "sketch-circle", icon: Circle },
    { tool: "arc", label: "Arc", id: "sketch-arc", icon: ARC_ICON },
    { tool: "spline", label: "Spline", id: "sketch-spline", icon: Spline },
    { tool: "polygon", label: "Polygon", id: "sketch-polygon", icon: Hexagon },
    { tool: "slot", label: "Slot", id: "sketch-slot", icon: RectangleHorizontal },
  ];
  return tools.map((item) => iconTool(item.tool, item.label, keyOf(item.id) ?? "", item.icon));
}

/** P1: the Edit row comes from `EDIT_BUTTONS`, so a button cannot ship without its purpose line. */
function editTools(): Node[] {
  const out: Node[] = EDIT_BUTTONS.map((id) => {
    if (id === "constrain") return constrainMenu();
    const { label, command } = EDIT_LABELS[id];
    return namedTool(id, label, tipWithShortcut(PURPOSE[id], command ? keyOf(command) : undefined));
  });
  // P2 for the Edit tools: a ? after them whose How lists a Show me for each one. A demo has none of its own.
  if (!S.demo) out.push(...editHow());
  // O1: Offset's wall options, under the row while Offset is on.
  if (S.editor.tool === "offset") out.push(wallRow());
  return out;
}

/** O1: Both sides, Close the ends, and Keep the line as a helper, each pressed while on. */
function wallRow(): HTMLElement {
  const row = document.createElement("div");
  row.className = "sketch-wall";
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "Offset options");
  const wall = S.editor.draw.wall;
  const ends = offsetHasEnds();
  const option = (key: "both" | "close" | "helper", label: string, tip: string) => {
    const button = textButton(label, { sketchWall: key });
    button.setAttribute("aria-pressed", wall[key] ? "true" : "false");
    button.dataset.tip = tip;
    button.title = tip;
    return button;
  };
  row.append(option("both", "Both sides", ASSIST_PURPOSE.wallBoth));
  // A closed outline has no ends to close; a line about to be offset may, so the option shows until one is picked.
  if (ends !== false) row.append(option("close", "Close the ends", ASSIST_PURPOSE.wallClose));
  // With one side closed, the line is the wall's other side, so it can't be a helper.
  if (wall.both || !wall.close || ends === false) row.append(option("helper", "Keep the line as a helper", ASSIST_PURPOSE.wallHelper));
  const gesture = S.editor.draw.gesture;
  if (gesture?.kind === "offset" && Math.abs(gesture.distance) > 1e-6 && (wall.both || wall.close)) {
    const note = document.createElement("p");
    note.className = "sketch-wall-note";
    note.setAttribute("role", "status");
    const thick = Math.abs(gesture.distance) * (wall.both ? 2 : 1);
    note.textContent = `Wall ${formatHeight(thick)} mm`;
    row.append(note);
  }
  return row;
}

/** O1: whether the offset being made has two ends to close: null before a line is picked. */
export function offsetHasEnds(): boolean | null {
  const gesture = S.editor.draw.gesture;
  const sketch = activeSketch(S.editor);
  if (gesture?.kind !== "offset" || !sketch) return null;
  return hasOpenEnds(sketch, gesture.ids);
}

/** P2 on the Edit row: a ? after the tools, whose How lists a Show me for each Edit tool. */
function editHow(): Node[] {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn sketch-make-how sketch-edit-how";
  button.textContent = "?";
  button.dataset.sketchEditHow = "";
  button.setAttribute("aria-label", "Edit tool demos");
  button.setAttribute("aria-expanded", S.editHowOpen ? "true" : "false");
  button.setAttribute("aria-controls", "sketchEditHow");
  button.dataset.tip = ASSIST_PURPOSE.editHow;
  button.title = button.dataset.tip;
  const pop = document.createElement("div");
  pop.id = "sketchEditHow";
  pop.className = "sketch-how-pop sketch-make-how-pop";
  pop.setAttribute("role", "group");
  pop.setAttribute("aria-label", "Show me");
  pop.hidden = !S.editHowOpen;
  const lead = document.createElement("p");
  lead.className = "sketch-how-lead";
  lead.textContent = EDIT_DEMO_LEAD;
  const row = document.createElement("div");
  row.className = "sketch-how-demos";
  for (const kind of EDIT_DEMO_KINDS) row.append(showMeButton(kind, DEMOS[kind].label));
  pop.append(lead, row);
  return [button, pop];
}

/** P1: the Make row comes from `MAKE_BUTTONS`. Holes stays on the row off a face, greyed with the reason. */
function makeTools(): Node[] {
  const out: Node[] = MAKE_BUTTONS.map((id) => {
    const { label, command, data } = MAKE_LABELS[id];
    const button = textButton(sketchKeyLabel(label, command), { [data]: "" });
    button.dataset.tipIdle = tipWithShortcut(PURPOSE[id], keyOf(command));
    markBlocked(button, startActive(id) ? "" : startWhy(id));
    return button;
  });
  // E1: only while the drawing has open ends that one click can close, beside Extrude.
  if (gapToClose()) {
    const close = textButton("Close the gap", { sketchCloseGap: "" });
    close.classList.add("sketch-assist");
    close.dataset.tipIdle = ASSIST_PURPOSE.closeGap;
    markBlocked(close, "");
    out.splice(1, 0, close);
  }
  // H1: off a face, Holes keeps its reason and Start on a face sits beside it.
  if (startWhy("holes") === REASON.holesFace) {
    const start = textButton("Start on a face", { sketchFaceStart: "" });
    start.classList.add("sketch-assist");
    start.dataset.tipIdle = ASSIST_PURPOSE.faceStart;
    markBlocked(start, "");
    out.push(start);
  }
  // P2: the Make row's How, with Show me for each tool. A demo has none of its own.
  if (!S.demo) out.push(...makeHow());
  return out;
}

function sketchFooter(): HTMLElement {
  const foot = document.createElement("div");
  foot.className = "sketch-foot";
  foot.dataset.sketchSection = "foot";
  const look = textButton(S.editor.lookAround ? "Lock view" : "Look around", { sketchLook: S.editor.lookAround ? "1" : "0" });
  look.dataset.tip = tipWithShortcut(S.editor.lookAround ? "Lock the view for drawing" : "Look around the sketch", keyOf("sketch-look"));
  if (S.profile) {
    const use = textButton("Use profile", { sketchProfileUse: "" });
    use.classList.add("primary");
    use.dataset.tip = "Cut along this chain";
    foot.append(look, textButton("Cancel", { sketchProfileCancel: "" }), use);
    return foot;
  }
  // P2: a demo is never kept. Its one way out puts the person's sketch back.
  if (S.demo) {
    const back = textButton("Back to my sketch", { sketchDemoLeave: "" });
    back.classList.add("primary");
    back.dataset.tip = "Close the demo and go back to your sketch, as you left it (Esc twice)";
    back.title = back.dataset.tip;
    foot.append(look, back);
    return foot;
  }
  const finish = textButton("Finish sketch", { sketchFinish: "" });
  // L1: on the shape above, Back to loft is the one primary button; Finish does the same.
  if (!(S.gesture || S.revolve || S.loft || S.sweep) && !aboveOpen()) finish.classList.add("primary");
  foot.append(look, finish);
  return foot;
}

function iconTool(tool: SketchTool, label: string, shortcut: string, icon: IconNode): HTMLButtonElement {
  const node = toolButton(tool, "");
  node.classList.add("sketch-icon");
  node.replaceChildren(createElement(icon, { width: 16, height: 16, "aria-hidden": "true" }));
  node.setAttribute("aria-label", label);
  node.dataset.tip = tipWithShortcut(label, shortcut);
  node.title = node.dataset.tip;
  return node;
}

function namedTool(tool: SketchTool, label: string, tip: string): HTMLButtonElement {
  const node = toolButton(tool, label);
  node.dataset.tip = tip;
  node.title = tip;
  return node;
}

function constrainMenu(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "sketch-menu";
  const current = isConstrainTool(S.editor.tool) ? CONSTRAIN_MENU.find((item) => item.action === S.editor.tool) : undefined;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "btn";
  open.dataset.sketchMenu = "constrain";
  open.dataset.tip = PURPOSE.constrain;
  open.title = PURPOSE.constrain;
  open.textContent = current?.label ?? "Constrain";
  open.setAttribute("aria-haspopup", "menu");
  open.setAttribute("aria-expanded", S.menuOpen === "constrain" ? "true" : "false");
  const menu = document.createElement("div");
  menu.className = "sketch-menu-list";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Constraints");
  menu.hidden = S.menuOpen !== "constrain";
  let group = "";
  let section: HTMLElement = menu;
  // K1: with something selected, only the rules that fit it are listed. Nothing selected lists every rule.
  const fit = constrainChoices(S.editor);
  if (fit) {
    const why = document.createElement("p");
    why.className = "sketch-menu-label";
    why.dataset.sketchMenuFit = String(fit.length);
    why.textContent = fit.length ? "Rules that fit the selection. Click empty space to see all." : "Nothing fits this selection. Click empty space to see every rule.";
    menu.append(why);
  }
  for (const item of CONSTRAIN_MENU) {
    if (fit && !fit.includes(item.action)) continue;
    if (item.group !== group) {
      group = item.group;
      const name = item.group === "geom" ? "Geometry" : item.group === "size" ? "Size" : "Edit";
      const heading = document.createElement("p");
      heading.className = "sketch-menu-label";
      heading.textContent = name;
      heading.setAttribute("aria-hidden", "true");
      section = document.createElement("div");
      section.setAttribute("role", "group");
      section.setAttribute("aria-label", name);
      section.style.display = "contents";
      menu.append(heading, section);
    }
    const node = document.createElement("button");
    node.type = "button";
    node.className = "btn";
    // "Remove constraint" is a command; the others arm a constraint tool, one at a time.
    const command = item.action === "remove";
    node.setAttribute("role", command ? "menuitem" : "menuitemradio");
    node.dataset.sketchConstrain = item.action;
    node.textContent = item.label;
    if (!command) node.setAttribute("aria-checked", S.editor.tool === item.action ? "true" : "false");
    section.append(node);
  }
  wrap.append(open, menu);
  return wrap;
}
