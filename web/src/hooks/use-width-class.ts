import { useState } from "react";

import { useTypingFocus } from "@/hooks/use-keyboard";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useWideLayoutMode } from "@/lib/wide-layout-store";
import {
  EXPANDED_QUERY,
  EXPANDED_WIDTH_QUERY,
  heldWidthClass,
  KEYBOARD_CLOSE_LINGER_MS,
  MEDIUM_QUERY,
  MEDIUM_WIDTH_QUERY,
  type WidthClass,
} from "@/lib/wide-layout";

function classOfQueries(expanded: boolean, medium: boolean): WidthClass {
  if (expanded) return "expanded";
  return medium ? "medium" : "compact";
}

/**
 * The window's width class (ADR 0120): compact below 600px, medium from 600px, expanded from 900px.
 * Compact at every width while the window is under 480px tall, so a phone held sideways keeps the
 * phone layout. Compact at every width too when this device set Large-screen layout to Off. Read from the window's size with two media queries and nothing else. The fold APIs are not read:
 * a Fold held flat open reports one segment and the posture `continuous`, so they cannot tell an open
 * Fold from a tablet, and the width can.
 *
 * The height rule has one exception. The soft keyboard shrinks the page height, and a drop to compact
 * would unmount the focused field and close the keyboard (issue 751). So while a field that types has
 * focus, a wide class holds, as wide as the width alone allows. Focus never raises a compact class. The hold lasts one second past the focus,
 * so a tap outside the field lands before any drop.
 */
export function useWidthClass(): WidthClass {
  const medium = useMediaQuery(MEDIUM_QUERY);
  const expanded = useMediaQuery(EXPANDED_QUERY);
  const mediumWide = useMediaQuery(MEDIUM_WIDTH_QUERY);
  const expandedWide = useMediaQuery(EXPANDED_WIDTH_QUERY);
  const typing = useTypingFocus(KEYBOARD_CLOSE_LINGER_MS);
  const mode = useWideLayoutMode();
  const fromWindow = classOfQueries(expanded, medium);
  const byWidth = classOfQueries(expandedWide, mediumWide);
  const [last, setLast] = useState<WidthClass>(fromWindow);
  const held = mode === "off" ? "compact" : heldWidthClass(fromWindow, last, typing, byWidth);
  // Derived state during render: React re-renders at once with the new value.
  if (held !== last) setLast(held);
  return held;
}
