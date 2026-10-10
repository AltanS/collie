// Text helpers shared by the pi grammars. Leaf module: no imports from the adapter or the detectors.

/** Trailing pad off. pi pads every row to the terminal width; leading indentation is evidence. */
export function rstrip(text: string): string {
  return text.replace(/\s+$/, "");
}
