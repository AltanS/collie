// The way back from any theme (F3): `#theme=collie` on the app's address.
//
// A theme the parser accepts can still make the Theme card hard to use (a low-contrast muted text, a
// border that vanishes). This escape is the one control no theme can draw: it is a URL. Open the app
// with `#theme=collie` and the device wears Collie again, and a theme being tried in the tab is
// dropped. Nothing else changes: the library, the typeface and the pairing stay as they are.
//
// Two readers, one rule. `public/theme-init.js` reads the hash before first paint and skips the stored
// theme; `initTheme` (store.ts) then writes Collie as the device's choice and removes the hash, so a
// reload or a bookmark does not repeat it. `theme-init.test.ts` holds the script's pattern equal to
// THEME_ESCAPE_SOURCE.

/** The hash that puts Collie back on: `#theme=collie`, alone or as one `&`-joined part of the hash. */
export const THEME_ESCAPE_SOURCE = "(?:^#|&)theme=collie(?:&|$)";

const THEME_ESCAPE = new RegExp(THEME_ESCAPE_SOURCE);

/** True when `hash` (a `location.hash`, with its `#`) asks for Collie. */
export function isThemeEscape(hash: string): boolean {
  return THEME_ESCAPE.test(hash);
}

/**
 * The hash with the escape taken out, as a `location.hash` value: `""` when nothing else was in it,
 * else `#` and the other parts in their order.
 */
export function withoutThemeEscape(hash: string): string {
  const parts = hash.replace(/^#/, "").split("&").filter((part) => part !== "theme=collie" && part !== "");
  return parts.length === 0 ? "" : `#${parts.join("&")}`;
}
