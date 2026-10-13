import { asJsonNumber, asJsonObject, asJsonString } from "@/lib/json";
import type { AgentView } from "@/lib/types";

// A DURABLE PANE'S SUBTITLE AND BADGE, read from a body that may have crossed a crew link.
//
// The bridge cleaned and capped both (WIRE.md 7.9), but a peer's pane arrives as the peer sent it,
// so a field of the wrong shape reads as absent here and a pane is never drawn from half a shape.
// Text only, never markup: both strings came from a program.

/** The pane's subtitle, or null when it carries none. */
export function paneSubtitle(pane: Pick<AgentView, "subtitle">): string | null {
  const text = asJsonString(pane.subtitle)?.trim();
  return text === undefined || text === "" ? null : text;
}

/**
 * The pane's badge as the text the chip draws, or null when there is nothing to draw. A count of zero is
 * the same as no mark, so a program that counts open questions need not clear it. Anything that is not
 * exactly one of `{ count }` with a whole number from 1 to 9999, or `{ text }` with a non-empty string,
 * reads as absent.
 */
export function paneBadge(pane: Pick<AgentView, "badge">): string | null {
  const badge = asJsonObject(pane.badge);
  if (badge === undefined) return null;
  const count = asJsonNumber(badge.count);
  const text = asJsonString(badge.text)?.trim();
  // Exactly one key, as the adapter keeps it; both is a bad shape.
  if (badge.count !== undefined && badge.text !== undefined) return null;
  if (count !== undefined) return Number.isInteger(count) && count >= 1 && count <= 9999 ? String(count) : null;
  return text === undefined || text === "" ? null : text;
}
