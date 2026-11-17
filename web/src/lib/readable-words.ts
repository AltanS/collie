// ── WORDS A PERSON CAN READ ──────────────────────────────────────────────────────────────────────
//
// A refusal's words reach the thumb as a sentence. Some answers carry no sentence at all: a proxy's
// HTML error page, a raw JSON body, or the phone's own developer line with the route path in it. This
// is the one test for those, so the display layer can say the status number in a short sentence
// instead (M102 spec 11, invariant I2). No markup, no JSON, no route path, at most the status.

/** True when `text` is words a person can read: not empty, no markup, not JSON, no route path. */
export function isReadableWords(text: string): boolean {
  const words = text.trim();
  if (words === "") return false;
  if (/<\/?[a-z][^>]*>/iu.test(words)) return false;
  if (words.startsWith("{") || words.startsWith("[")) return false;
  if (/\{"|\["/u.test(words)) return false;
  return !/\/api\//u.test(words);
}
