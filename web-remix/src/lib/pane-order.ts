// The order a pane list runs in (ADR 0071): place (the default), activity or cache. The rules and the
// readings are web/'s, reused read-only (web/src/lib/pane-order.ts); this module only gives the
// shell one import for them beside `frozen-ranks.ts`, and the segment table the toggle draws.
import type { IconNode } from "lucide";
import { Clock, FolderTree, Hourglass } from "lucide";

import type { MessageKey } from "@web/lib/i18n";
import { PANE_ORDERS, type PaneOrder } from "@web/lib/pane-order";

export { activityAt, activityRanks, cacheRanks, coercePaneOrder, coldAt, inRankOrder, PANE_ORDERS } from "@web/lib/pane-order";
export type { PaneOrder };

/** web/'s `PaneOrderToggle` segments: the label key and the glyph, per order. */
export const ORDER_SEGMENTS = {
  place: { label: "paneOrder.place", icon: FolderTree },
  activity: { label: "paneOrder.activity", icon: Clock },
  cache: { label: "paneOrder.cache", icon: Hourglass },
} as const satisfies Record<PaneOrder, { label: MessageKey; icon: IconNode }>;

/** The ranked list's heading, which names the order in words (ADR 0071). */
export function rankedHeading(order: PaneOrder): MessageKey {
  return order === "cache" ? "paneOrder.coldest" : "paneOrder.recent";
}

export function isRanked(order: PaneOrder): boolean {
  return order !== "place";
}

/** Every order, for a test or a loop that must not hard-code them. */
export const ORDERS: readonly PaneOrder[] = PANE_ORDERS;
