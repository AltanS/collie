import { Layers } from "lucide-react";

import { AddressTag } from "@/components/ui/address-tag";
import { primarySession } from "@/lib/hosts";
import { usePack } from "@/components/pack-provider";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface SessionChipProps {
  /** The session this row's pane lives in — `PaneWire.session`. Undefined = nothing to say. */
  session: string | undefined;
  className?: string;
}

// The other half of a pane's address: WHICH Herdr session on the machine. The sibling of HostChip,
// built on the same primitive so the two match wherever a row names both.
//
// ── THE HIDE RULE LIVES HERE, LIKE ITS SIBLING'S ─────────────────────────────
// Renders `null` unless there is something to say, so callers may mount it unconditionally:
//
//   • the pane names no session — every un-widened read, which is every read the app made before
//     the "All sessions" view existed;
//   • the pane names the PRIMARY session — the one an absent `?s=` already means. Marking those
//     would put a chip on every row of the widened list and say nothing with it; the rows that are
//     somewhere unexpected are the ones worth marking. This is the same shape as HostChip going
//     quiet on a solo install.
//
// Not a control, for the reason HostChip is not one: two lookalike pills, one of them tappable, on
// the surface where a mis-tap means typing into the wrong terminal. The `Layers` glyph is the
// session switcher's own, so the pill and the control that changes it name the same dimension —
// the SHAPE says which is which (a pill is a fact, the switcher is a button).
//
// The registry comes from CONTEXT, not from a prop — the same seam, and for the same reason, that
// HostChip takes the pack roster from. Half the surfaces that render one of these are unit-tested
// without a router, so reading the root loader is not available (pack-provider.tsx states that
// argument at length); a prop chain reaching every list, sheet and row is a prop chain someone will
// break. With no provider the registry is empty, which reads as "nothing to say".
export function SessionChip({ session, className }: SessionChipProps) {
  useLocale();
  const { sessions } = usePack();
  if (session === undefined || session === primarySession(sessions)) return null;
  return (
    <AddressTag
      // As with the host chip, the inner text is aria-hidden, so this one label has to carry the
      // MEANING: a bare session name is a noun with no verb.
      aria-label={t("connection.session.ariaIn", { name: session })}
      glyph={<Layers className="size-3 shrink-0" aria-hidden />}
      name={session}
      className={className}
    />
  );
}
