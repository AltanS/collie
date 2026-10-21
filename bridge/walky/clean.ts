// A message body as a target pane may receive it (M62 README, decision 6). The Send Protocol's own
// line rule runs first (`sendLines`, web/src/lib/surface/send.ts): line breaks split the text, the
// paste markers are cut, a Tab becomes one space, and every C0, DEL and C1 control byte is dropped.
// On top of it this drops the marks that change how a line reads without being seen: the direction
// marks and embeddings (U+200E, U+200F, U+061C, U+202A to U+202E, U+2066 to U+2069), the zero-width
// characters (U+200B to U+200D, U+2060, U+FEFF) and the soft hyphen. U+2028 and U+2029 are line breaks.
// Then the body is capped at 4,000 characters, counted as code points so no pair is split. Last, a
// line that could pass for a header (it starts with `[walky-talky`) gets one leading space, so a body
// can never open a second message on the screen or in the log (types.ts `escapeBody`).

import { sendLines } from "../../web/src/lib/surface/send.ts";
import { escapeBody, WALKY_BODY_MAX } from "./types.ts";

/**
 * The reason a body past the cap is refused with. A cut body can change what it says, so the sender's
 * bridge never cuts one in silence: the send is refused and the sender shortens it.
 */
export const BODY_TOO_LONG = "body over 4,000 characters";

/** Every invisible format character the body drops. */
const INVISIBLE = /[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu;

export interface CleanBody {
  /** The cleaned body, or the empty string when nothing is left. */
  readonly body: string;
  /** True when the cap cut it. */
  readonly cut: boolean;
}

/** Clean one body. Leading and trailing blank lines go; a blank line in between stays. */
export function cleanBody(raw: string, max = WALKY_BODY_MAX): CleanBody {
  const unified = raw.replace(/[\u2028\u2029]/gu, "\n").replace(INVISIBLE, "");
  const lines = sendLines(unified).map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const joined = escapeBody(lines.join("\n"));
  const points = [...joined];
  if (points.length <= max) return { body: joined, cut: false };
  return { body: points.slice(0, max).join("").trimEnd(), cut: true };
}
