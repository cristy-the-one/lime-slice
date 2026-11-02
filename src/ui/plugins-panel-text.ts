/**
 * --- The Plugins panel's words (plugin milestone 7), apart from its DOM so the unit chain checks them: what each
 * button is for (R4 of docs/plan-sketch-for-people.md), and why Apply or Preview is greyed, each ending with what to
 * do next (R1).
 */
/** R4: what each of the card's buttons is for. */
export const PURPOSE = {
  search: "Find a plugin by a word of its title, description or name.",
  preview: "Build it once to look at it. Nothing is kept: the part stays as it is.",
  live: "Preview again by itself after each change, while a preview takes under a second.",
  apply: "Run the plugin and keep the result as one History step. Undo takes it back.",
  source: "Read the plugin's code. It cannot be changed here.",
  reveal: "Show the plugin's file in its folder, to send it or edit it elsewhere.",
  add: "Copy this project's plugin into your library, so other projects can use it.",
  remove: "Take the plugin out of your library. Parts built with it keep their code in their project.",
  back: "Back to the list of plugins.",
  how: "How plugins work, and a demo to try.",
  presets: "Fill the form with values kept under a name.",
} as const;

/** R1: why Apply or Preview is greyed, each ending with what to do. */
export const REASON = {
  pick: "No plugin is open yet. Click one in the list.",
  needsPart: "This plugin changes a part, and none is open. Select a part in the objects list, then open it in Model.",
  busy: "A plugin is running. Wait a moment for it to finish.",
  demoApply: "This is a demo, so nothing is added to your part. Click Back to my plugins.",
} as const;
