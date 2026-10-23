/** The file name Save offers: the project's own, else the selected object's name. */
export function projectFileName(title: string | null, objectName: string): string {
  const own = title?.trim() ?? "";
  if (/\.lime$/i.test(own) && own.length > ".lime".length) return own;
  return `${objectName.replace(/\.(stl|3mf|step|stp|lime)$/i, "")}.lime`;
}
