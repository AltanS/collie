/**
 * The product's name, "ColliePWA": "Collie" in the text colour, "PWA" in the muted ink at rest, and
 * the herd's three colours (P done, W working, A blocked) under a pointer on the lockup
 * (`.wordmark-lockup`, index.css `.wordmark-ink`), as on the website (collie-website
 * `components/wordmark.tsx`).
 *
 * NO APPLICATION STATE MAY EVER DRIVE THESE INKS. The trigger is the reader's pointer; the colours are
 * fixed per letter. Do not wire these letters to an agent count, a connection or a build.
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
