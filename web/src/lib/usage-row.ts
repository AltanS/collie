// How the usage row of a session draws its gauges (components/model-tag.tsx): as a whole percentage, or as
// five dots. A per-device choice in Settings, Appearance.
//
// PERCENT BY DEFAULT. The dots round down to a fifth (81% shows four), so 41% and 59% look alike; the
// number is the exact figure the harness reported. Both draw the same quantity, the share USED, and
// both turn to the working colour from 80%. A device that never chose, and one whose stored value is
// not a choice this build knows, gets Percent.

import type { JsonValue } from "@/lib/json";

/** The choices of the Settings control, the default first. */
export const USAGE_ROWS = ["percent", "dots"] as const;
export type UsageRow = (typeof USAGE_ROWS)[number];

export const DEFAULT_USAGE_ROW: UsageRow = "percent";

/** A stored value as a choice; anything unknown reads as the default. */
export function coerceUsageRow(raw: JsonValue | undefined): UsageRow {
  return USAGE_ROWS.find((choice) => choice === raw) ?? DEFAULT_USAGE_ROW;
}
