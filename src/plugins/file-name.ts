/** Whether a dropped or picked file's name is a plugin file to import (`.lime-plugin.rs`, or a library `.rs`). */
export function isPluginFileName(name: string): boolean {
  return /\.rs$/i.test(name);
}
