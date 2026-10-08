import type { TranscriptEntry } from "./types";

// WHERE A MASK SHOWS UP ON THE PHONE. The bridge hides known secret shapes before text leaves the
// machine (bridge/redact.ts): one `•` per hidden character, the vendor prefix left readable, so
// `sk-o••••••••` is a key the phone was never given. Two screens need to know when that happened,
// the pane (a one-time line that explains the dots) and the composer (a caution that a pasted
// line is dots, not the secret).
//
// FOUR OR MORE, NOT ONE. A lone `•` is an ordinary bullet in a list or a separator in a status
// line, and agents draw those all day. The shortest secret the bridge masks leaves far more than
// three dots, so a run of four keeps real bullets from raising the notice and costs no real mask.
const MASK_RUN = /•{4,}/;

/** Whether `text` holds a run of the bridge's mask character, long enough to be one. */
export function holdsMask(text: string): boolean {
  return MASK_RUN.test(text);
}

/**
 * The same question over a Chat window: any turn's spoken text, or a tool's result text, holding a
 * mask. Thinking and tool summaries are left out, so the check stays to the text the reader is
 * shown as the turn itself, and a branch the agent rewound past (`abandoned`) is hidden by the view.
 */
export function entriesHoldMask(entries: readonly TranscriptEntry[]): boolean {
  for (const entry of entries) {
    if (entry.abandoned) continue;
    for (const part of entry.parts) {
      if (part.kind === "text" && holdsMask(part.text)) return true;
      if (part.kind === "tool" && part.result !== undefined && holdsMask(part.result.text)) return true;
    }
  }
  return false;
}
