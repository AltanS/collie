// LAB CODE (strip-head round B, 2026-11-21). Goes when a proposal is picked.
//
// Which proposal of the tab strip and the pane header this tab draws: `?th=1|2|3` in the URL picks one and
// keeps it for the tab in sessionStorage, `?th=0` goes back to today's look. The choice is written on <html>
// as `data-th`, so the proposals' paint lives in index.css under `:root[data-th="n"]`, and the few
// components that change shape read `stripHeadVariant()`.

export type StripHeadVariant = "today" | "1" | "2" | "3";

const KEY = "collie:lab:strip-head";

function parse(raw: string | null): StripHeadVariant | null {
  if (raw === "1" || raw === "2" || raw === "3") return raw;
  if (raw === "0" || raw === "today") return "today";
  return null;
}

function read(): StripHeadVariant {
  try {
    const fromUrl = parse(new URLSearchParams(window.location.search).get("th"));
    if (fromUrl !== null) {
      window.sessionStorage.setItem(KEY, fromUrl);
      return fromUrl;
    }
    return parse(window.sessionStorage.getItem(KEY)) ?? "today";
  } catch {
    return "today";
  }
}

const variant: StripHeadVariant = read();

export function stripHeadVariant(): StripHeadVariant {
  return variant;
}

/** Write the choice on <html>, once, before the first paint of the app. */
export function applyStripHeadVariant(): void {
  if (variant === "today") return;
  document.documentElement.dataset.th = variant;
}
