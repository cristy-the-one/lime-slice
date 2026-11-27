/**
 * The first chunk's whole share of the person's fonts: a hook that src/app/user-fonts.ts fills when it loads (with Model's
 * Text card, or the first project opened or saved). Until then the shelf is empty, so there is nothing to drop.
 */
export const userFontsHook: { drop: (() => void) | null } = { drop: null };

/** A new project, or another one opened, leaves behind the fonts the last one brought (`dropProjectFonts` in user-fonts.ts). */
export function dropProjectFonts(): void {
  userFontsHook.drop?.();
}
