/**
 * Split to print's Export… (docs/plan-split-connectors.md, D12): the dialog that asks which file to write for the pieces an
 * export target left in Model. It only asks; `app/split-export.ts` writes the files.
 *
 * The pins of a dowelled cut, `<source>-pins`, are one more name after the last piece in `names`, and one more line in each hint.
 */

export type PieceFormat = "stl" | "3mf" | "step";

/** The file names each format writes, for the dialog's hints and for the writer. */
export function pieceFiles(stem: string, names: readonly string[]): Record<PieceFormat, string[]> {
  return { stl: names.map((name) => `${name}.stl`), "3mf": [`${stem}.3mf`], step: [`${stem}.step`] };
}

/** Which format the user chose, or null for Cancel, Escape, or a click outside the card. */
export function askPieceExport(files: Record<PieceFormat, string[]>, note: string): Promise<PieceFormat | null> {
  const sheet = document.querySelector<HTMLElement>("#splitExport");
  if (!sheet) return Promise.resolve(null);
  const hint = (selector: string, text: string) => {
    const node = sheet.querySelector<HTMLElement>(selector);
    if (node) node.textContent = text;
  };
  const stl = files.stl;
  hint("#splitExportStl", stl.length > 2 ? `${stl[0]}, ${stl[1]}, … ${stl.at(-1)}` : stl.join(", "));
  hint("#splitExport3mf", `${files["3mf"][0]}, every piece named`);
  hint("#splitExportStep", `${files.step[0]}, every piece named`);
  hint("#splitExportNote", note);
  sheet.hidden = false;
  document.documentElement.dataset.overlay = "splitExport";
  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  sheet.querySelector<HTMLButtonElement>('[data-format="stl"]')?.focus();
  return new Promise((resolve) => {
    const finish = (answer: PieceFormat | null) => {
      sheet.hidden = true;
      if (document.documentElement.dataset.overlay === "splitExport") delete document.documentElement.dataset.overlay;
      sheet.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey, true);
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
      resolve(answer);
    };
    const onClick = (ev: MouseEvent) => {
      const choice = (ev.target as HTMLElement).closest<HTMLElement>("[data-format]")?.dataset.format;
      if (choice === "stl" || choice === "3mf" || choice === "step") finish(choice);
      else if (choice === "cancel" || ev.target === sheet) finish(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(null);
    };
    sheet.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey, true);
  });
}
