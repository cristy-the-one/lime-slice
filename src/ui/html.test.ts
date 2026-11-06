/**
 * Hostile names through the markup builders: a name like `<img src=x onerror=alert(1)>`, quotes or `&` must stay text.
 * Each builder is rendered once with a plain name and once with the hostile ones; the elements and attributes the two
 * produce must be the same, so nothing in a name became an element or an attribute.
 */
import { escapeHtml, html, raw } from "./html.ts";
import { inspectRowsHtml, profileOptionsHtml } from "./name-lists.ts";
import { modelAlignToHtml, alignHtml } from "../app/align-ui.ts";
import { builtinLibrary, heatNoteHtml, machinePickHtml } from "./machine-library.ts";

let failed = 0;

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${a}, expected ${e}`);
}

const HOSTILE = [`<img src=x onerror=alert(1)>`, `"><script>alert(1)</script>`, `' onmouseover='alert(1)`, `Tom & Jerry's "best" <b>`];

/** Every element and attribute name the markup makes, in order: what a parser builds, minus the text. */
function skeleton(markup: string): string[] {
  const out: string[] = [];
  const tag = /<\/?([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
  for (let m = tag.exec(markup); m; m = tag.exec(markup)) {
    out.push(m[1]!.toLowerCase());
    const attr = /\s+([^\s=>/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;
    for (let a = attr.exec(m[2]!); a; a = attr.exec(m[2]!)) out.push(`@${a[1]!.toLowerCase()}`);
  }
  return out;
}

/** The builder renders the same elements and attributes whatever the names are, and keeps every name as text. */
function sameShape(name: string, render: (text: string) => string) {
  const plain = skeleton(render("Plain name"));
  for (const hostile of HOSTILE) {
    const out = render(hostile);
    eq(`${name}: ${hostile} adds no element or attribute`, skeleton(out), plain);
    eq(`${name}: ${hostile} never appears raw`, out.includes(hostile), false);
    eq(`${name}: ${hostile} appears escaped`, out.includes(escapeHtml(hostile)), true);
  }
}

// The template itself.
eq("text is escaped", String(html`<b>${"<i>&\"'"}</b>`), "<b>&lt;i&gt;&amp;&quot;&#39;</b>");
eq("a nested fragment goes in as it is", String(html`<ul>${html`<li>${"a<b"}</li>`}</ul>`), "<ul><li>a&lt;b</li></ul>");
eq("an array is joined, each item escaped", String(html`${["<a>", html`<br>`, 3]}`), "&lt;a&gt;<br>3");
eq("nothing renders as empty", String(html`[${null}${undefined}${false}${true}]`), "[]");
eq("raw is the only way in unescaped", String(html`${raw("<hr>")}`), "<hr>");
eq("numbers are text", String(html`<i style="top:${(12.5).toFixed(2)}%">`), `<i style="top:12.50%">`);

// Inspect's object list (names from files and MCP).
sameShape("Inspect rows", (name) => String(inspectRowsHtml([{ id: "a", name, size: "10 × 10 × 10" }, { id: name, name: `${name} 2`, size: "1 × 1 × 1" }], "a")));
{
  const rows = String(inspectRowsHtml([{ id: "a", name: "plinth", size: "1 × 1 × 1" }, { id: "b", name: "face_1", size: "1 × 1 × 1", hidden: true }, { id: "c", name: "crank", size: "1 × 1 × 1" }], "a"));
  eq("Inspect rows: a hidden object's eye is pressed and says Show", rows.includes(`aria-pressed="true" aria-label="Show face_1"`), true);
  eq("Inspect rows: a shown object's eye says Hide", rows.includes(`aria-label="Hide crank"`), true);
  eq("Inspect rows: the open object's eye is disabled", /aria-label="Hide plinth"[^>]*disabled/.test(rows), true);
  eq("Inspect rows: the row is marked hidden", rows.includes(`data-hidden="true"`), true);
}
eq("Inspect rows: an empty plate says so", String(inspectRowsHtml([], null)), `<p class="model-note">Nothing on the plate.</p>`);

// The settings profile list.
sameShape("Profile list", (name) => String(profileOptionsHtml([{ id: "p1", name }, { id: name, name: "Zeta" }], "p1")));
eq("Profile list: sorted by name, the pick selected", String(profileOptionsHtml([{ id: "b", name: "B" }, { id: "a", name: "A" }], "b")), `<option value="a">A</option><option value="b" selected>B</option>`);

// The printer chip's printer and filament lists, and the heat note that names the filament.
const library = builtinLibrary();
sameShape("Printer list", (name) => String(machinePickHtml({ ...library, printers: library.printers.map((printer, i) => (i === 0 ? { ...printer, name, id: name } : printer)), printerId: name })));
sameShape("Filament list", (name) => String(machinePickHtml({ ...library, filaments: library.filaments.map((filament, i) => (i === 0 ? { ...filament, name } : filament)) })));
sameShape("Heat note", (name) => String(heatNoteHtml({ nozzleC: 250, bedC: 60, nozzleAskC: 260, bedAskC: 100 }, name, "note")));

// The Align to… lists (object names).
sameShape("Model Align to", (name) => String(modelAlignToHtml([{ id: "o1", name }, { id: "o2", name: "Other" }])));
sameShape("Place Align to", (name) => String(alignHtml([{ id: "o1", name }])));

if (failed) throw new Error(`${failed} html checks failed`);
console.log("html: hostile names stay text in every converted list");
