/**
 * The product's name, "ColliePWA", with its last three letters in the herd's three colours: P
 * `--status-done`, W `--status-working`, A `--status-blocked` (index.css, `.wordmark-ink`).
 *
 * THE APP DIFFERS FROM THE WEBSITE ON PURPOSE. The website's wordmark (collie-website
 * `components/wordmark.tsx`) rests in grey and takes these colours under a pointer. Here the name is
 * coloured by default, at rest too (Altan's call, 2026-10-24).
 *
 * NO APPLICATION STATE MAY EVER DRIVE THESE INKS. The three colours are fixed per letter and always
 * land on the same three letters, so the name never reads as a live status. Do not wire these letters
 * to an agent count, a connection or a build.
 *
 * The letters are three elements because each takes its own ink and the stylesheet reaches them by
 * position (`:nth-child`). `stem` is a text node and does not count. Do not wrap them, and do not put
 * an element before them. The name is not translated.
 */

/** The product's name outside the app. Written down once; the split below is derived from it. */
export const PRODUCT_NAME = "ColliePWA";

const SUFFIX = "PWA";

/** The tracking is on the WHOLE name, as on the website: a colour change mid-word closes up without a little air. */
export function Wordmark({ className = "" }: { className?: string }) {
  const stem = PRODUCT_NAME.endsWith(SUFFIX) ? PRODUCT_NAME.slice(0, -SUFFIX.length) : PRODUCT_NAME;
  const tail = PRODUCT_NAME.slice(stem.length);
  return (
    <span className={`tracking-[0.03em] ${className}`}>
      {stem}
      {[...tail].map((letter, i) => (
        <span key={`${letter}${String(i)}`} className="wordmark-ink">
          {letter}
        </span>
      ))}
    </span>
  );
}
