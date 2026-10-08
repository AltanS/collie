// Classifier for the sticky-mode trap: "Type into terminal" armed once, then
// every chat message streams into the shell. Called with what the armed
// session typed and the already-polled mirror tail — never triggers a read
// itself. Fail-closed by construction: unknown shells and key bursts answer
// false (the status quo), so a miss costs nothing and a hit only ever raises
// a dismissible notice, never a send.

// Shell rejections observed in the wild, lowercased once at the call site.
// Deliberately exact substrings, not patterns: a new dialect that is not
// listed keeps the status quo instead of buying a false notice.
const REJECTIONS = [
  "command not found", // bash/zsh/sh
  "befehl nicht gefunden", // bash de
  "unknown command", // fish
  "not recognized as an internal or external command", // cmd
  "not recognized as the name of a cmdlet", // powershell
];

// A burst of terminal keys (picker filter, y/n, arrows) against a chat
// sentence. Floor doubles as the correlation: the caller checks at disarm,
// so a message-like text plus a rejection on screen is the trap, not a
// coincidence. Message-like alone is not enough for a LATE check (the mirror
// may land after the disarm): the shell always echoes the offending command
// name, so the session's first token must also be on screen. That binds this
// session's typing to this rejection across the poll gap.
//
// BOUND (tail length): the mirror holds up to 600 lines, so a stale rejection
// plus a common first word ("please") can in principle coincide without the
// trap. The disarm-time session is the other half of the conjunction — a
// notice needs THIS typing, not just any rejection — which keeps the residual
// risk at one dismissible notice, never a send.
const MESSAGE_FLOOR = 12;

/** True when text reads as a chat sentence rather than a key burst. */
export function isMessageLike(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= MESSAGE_FLOOR && trimmed.includes(" ");
}

/** True when an armed direct-typing session visibly typed chat into a shell. */
export function looksMisdirected(sessionText: string, paneText: string): boolean {
  if (!isMessageLike(sessionText)) return false;
  const first = sessionText.trim().split(/\s+/)[0]!.replace(/^['"]+|['"]+$/g, "");
  if (first.length < 2) return false;
  const tail = paneText.toLowerCase();
  if (!tail.includes(first.toLowerCase())) return false;
  return REJECTIONS.some((rejection) => tail.includes(rejection));
}
