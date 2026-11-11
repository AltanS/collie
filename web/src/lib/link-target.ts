// Where a link in a Decision's body really goes, as a short line a person reads before a tap. A named
// link `[the CI run](https://host/path)` shows only its label, and a Decision asks for attention, so a
// label that hides a wrong address is a trap. The body shows the address beside the label whenever
// the label is not the address (components/markdown-text.tsx, `showLinkTargets`).
//
// The host is the part a person must see whole, so it is never cut. Only the path is cut, in the
// middle. The host is what the `URL` parser says it is: its ASCII form (`xn--`), so look-alike letters
// cannot hide, and without userinfo, so `https://good.com@evil.com/` reads as `evil.com`.

/** The longest target line shown before the path is cut. The host is never cut, so a long host passes it. */
export const TARGET_MAX = 48;
/** The path keeps at least this many characters, whatever the host takes, so a long host still shows a path. */
const PATH_MIN = 16;

function parseWeb(href: string): URL | null {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The address with no scheme and no trailing slash, to compare a label with it. */
function bare(address: string, scheme: string | null): string {
  const lead = /^(https?):\/\//i.exec(address);
  // A label that names the other scheme is not the address: `http://x` for `https://x` stays a mismatch.
  const stripped = lead === null ? address : lead[1]!.toLowerCase() === scheme ? address.slice(lead[0].length) : address;
  return stripped.replace(/\/+$/, "");
}

/** Cuts a path in the middle with an ellipsis, keeping more of the tail (the last segment names the page). */
function cutMiddle(path: string, budget: number): string {
  if (path.length <= budget) return path;
  const keep = Math.max(budget - 1, 2);
  const head = Math.floor(keep / 2);
  return `${path.slice(0, head)}…${path.slice(path.length - (keep - head))}`;
}

/** The shown target in two pieces, so the host can be drawn as one unbroken word and the path as the part that wraps. */
export interface LinkTargetParts {
  host: string;
  /** The path (cut in the middle when long), then `?…` or `#…` when a query or fragment was dropped. */
  rest: string;
}

/** The line as one string, for tests and plain text. */
export function targetText(parts: LinkTargetParts): string {
  return `${parts.host}${parts.rest}`;
}

/**
 * The target shown beside a link: host plus path, no scheme. Up to {@link TARGET_MAX} characters it keeps
 * the query and fragment; longer, those go first and a `?…` (or `#…`) says so, then the path is cut in
 * the middle. Null for a target that is not an http or https address.
 */
export function linkTargetParts(href: string): LinkTargetParts | null {
  const url = parseWeb(href);
  if (url === null) return null;
  const path = url.pathname === "/" ? "" : url.pathname;
  const whole = `${url.host}${path}${url.search}${url.hash}`;
  if (whole.length <= TARGET_MAX) return { host: url.host, rest: `${path}${url.search}${url.hash}` };
  // A cut is never silent: a dropped query or fragment leaves its mark.
  const mark = url.search !== "" ? "?…" : url.hash !== "" ? "#…" : "";
  const budget = Math.max(TARGET_MAX - url.host.length - mark.length, PATH_MIN);
  return { host: url.host, rest: `${cutMiddle(path, budget)}${mark}` };
}

/**
 * The target to show beside a link whose visible label is `label`, or null when the label already is the
 * address (a bare URL or an autolink, also with a trailing slash or the scheme missing) and for a target
 * that is not a web address. A label that looks like another address is a mismatch like any other.
 */
export function linkTargetBeside(label: string, href: string): LinkTargetParts | null {
  const url = parseWeb(href);
  if (url === null) return null;
  const scheme = url.protocol.slice(0, -1);
  const shown = bare(label.trim(), scheme);
  if (shown === bare(href, scheme) || shown === bare(url.href, scheme)) return null;
  return linkTargetParts(href);
}
