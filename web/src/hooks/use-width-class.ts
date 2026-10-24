import { useMediaQuery } from "@/hooks/use-media-query";
import { useWideLayoutMode } from "@/lib/wide-layout-store";
import { EXPANDED_QUERY, MEDIUM_QUERY, type WidthClass } from "@/lib/wide-layout";

/**
 * The window's width class (ADR 0120): compact below 600px, medium from 600px, expanded from 900px.
 * Compact at every width while the window is under 480px tall, so a phone held sideways keeps the
 * phone layout. Compact at every width too when this device set Large-screen layout to Off. Read from the window's size with two media queries and nothing else. The fold APIs are not read:
 * a Fold held flat open reports one segment and the posture `continuous`, so they cannot tell an open
 * Fold from a tablet, and the width can.
 */
export function useWidthClass(): WidthClass {
  const medium = useMediaQuery(MEDIUM_QUERY);
  const expanded = useMediaQuery(EXPANDED_QUERY);
  const mode = useWideLayoutMode();
  if (mode === "off") return "compact";
  if (expanded) return "expanded";
  return medium ? "medium" : "compact";
}
