/**
 * --- Lessons on an op's card (docs/plan-recipe-ingredients.md I15). The Model tool on screen shows, under its fields,
 * the newest lessons about its kind of step: the same "Seen in practice" an agent gets from guide {kind}, so a person
 * reads "aim nearPoint at material" where they set a fillet. The list is the library's, read by the Plugins panel;
 * Remove is there (Lessons).
 */
import { lessonsAbout, toolLessonKinds, type Lesson } from "../plugins/library";

let lessons: readonly Lesson[] = [];
let shown: string | null = null;

/** The library was read again. */
export function setLessons(next: readonly Lesson[]) {
  lessons = next;
  showLessonsFor(shown);
}

/** The tool on screen (null when none, or a card that is not a tool): its lessons, or nothing. */
export function showLessonsFor(tool: string | null) {
  shown = tool;
  const box = document.querySelector<HTMLElement>("#modelLessons");
  if (!box) return;
  const rows = tool ? lessonsAbout(lessons, toolLessonKinds(tool)) : [];
  box.hidden = rows.length === 0;
  if (rows.length === 0) {
    box.replaceChildren();
    return;
  }
  const head = Object.assign(document.createElement("h4"), { textContent: "Seen in practice" });
  head.dataset.tip = "Lessons runs taught about this kind of step. Plugins… ▸ Lessons removes one.";
  const ul = document.createElement("ul");
  for (const row of rows) ul.append(Object.assign(document.createElement("li"), { textContent: row.text }));
  box.replaceChildren(head, ul);
}
