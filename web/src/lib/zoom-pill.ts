// Whether the belt's Zoom pill is drawn (`components/actions-row.tsx`, `components/output-zoom.tsx`).
//
// THE RULE. The pill zooms the terminal screen, so it belongs to the Screen view: it is drawn only
// while the pane view shows the terminal mirror, and never while it shows Chat. In Chat the same
// icon, a magnifier with a plus, had nothing to point at. A pane with no screen has no pill either,
// as before (the caller passes no zoom for it).
//
// THE SETTING. Two choices: `screen` (the rule above, the default) and `off` (never). The theme
// file can say the same with its surface word `zoom` (`screen` or `none`, lib/theme/surface.ts).
// PRECEDENCE: a choice the person made on this device wins; with none, the active theme's word
// decides; with neither, `screen`. The device choice is stored as `null` until it is made, so a
// device that never opened the setting follows its theme.

import type { JsonValue } from "@/lib/json";
import type { PaneBody } from "@/lib/chat-gate";
import type { SurfaceWord } from "@/lib/theme/surface";

/** The choices of the Settings control, the default first. */
export const ZOOM_PILLS = ["screen", "off"] as const;
export type ZoomPill = (typeof ZOOM_PILLS)[number];

/** A stored value as a choice; anything unknown reads as "never chosen". */
export function coerceZoomPill(raw: JsonValue | undefined): ZoomPill | null {
  return ZOOM_PILLS.find((choice) => choice === raw) ?? null;
}

/** The choice in force: the device's own when made, else the theme's word, else `screen`. */
export function effectiveZoomPill(device: ZoomPill | null, themeWord: SurfaceWord<"zoom"> | undefined): ZoomPill {
  if (device !== null) return device;
  return themeWord === "none" ? "off" : "screen";
}

/** True when the Zoom pill is drawn: the choice allows it and the view shows the Screen. */
export function zoomPillShown(options: {
  body: PaneBody;
  device: ZoomPill | null;
  themeWord: SurfaceWord<"zoom"> | undefined;
}): boolean {
  if (options.body !== "terminal") return false;
  return effectiveZoomPill(options.device, options.themeWord) === "screen";
}
