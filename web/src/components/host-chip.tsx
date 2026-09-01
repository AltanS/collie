import { Server, ServerOff } from "lucide-react";

import { cn } from "@/lib/utils";
import { AddressTag } from "@/components/ui/address-tag";
import { HOST_TEXT_CLASSES, hostName, hostSlot } from "@/lib/hosts";
import type { HostState } from "@/lib/host-health";
import { useHostHealth, usePack } from "@/components/pack-provider";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface HostChipProps {
  /** The machine this row/sheet/send is about. Undefined = nothing to say (and nothing renders). */
  host: string | undefined;
  /**
   * Override the derived tier-2 state, for a surface that has already resolved it (the server
   * switcher renders its own rows and would otherwise derive the same fact twice).
   */
  state?: HostState;
  /**
   * `tag` — the default pill. `target` — extra emphasis for a write surface's own HEADER, a touch
   * larger, with the "on" preposition; it is a pill among pills there (the dock's title row, a
   * sheet's title). `caption` — no pill at all, a small uppercase run: the host standing in a line
   * of chrome type, where a bordered pill would read as a second object dropped into the sentence
   * rather than as part of it. Today that is the composer's status strip, above the controls row,
   * where the run takes the slot a section label used to occupy and wears the same 10px uppercase
   * muted type it did. It is also the narrowest form the chip has.
   */
  variant?: "tag" | "target" | "caption";
  className?: string;
}

// The one place that answers "which machine is this?", and the one place that decides whether the
// question is even worth asking.
//
// ── THE HIDE RULE LIVES HERE, NOT IN THE CALLERS ─────────────────────────────
// Renders `null` when the pack is a single machine — i.e. for every install that exists today —
// which is why callers may mount it unconditionally. If each caller had to ask "am I on a pack?"
// first, a solo install would eventually grow a stray chip and, far worse, a pack install would
// eventually drop one at the surface that mattered.
//
// ── AND WHY IT IS NEVER THE SESSION SWITCHER'S TWIN ──────────────────────────
// Two lookalike pills, one changing machines and one changing sessions, is a mis-tap waiting to
// happen (milestone constraint). So this is deliberately NOT a control: no tap target, no chevron, a
// server glyph rather than the switcher's layers, and it is a plain text node — a host name comes
// from the operator's `join` label and is rendered as text, never markup, like every other
// user-supplied string that reaches this UI.
export function HostChip({ host, state, variant = "tag", className }: HostChipProps) {
  useLocale();
  const { servers, multi } = usePack();
  const health = useHostHealth(host);
  // No pack, or nothing to name: the whole dimension is invisible. (Hooks run first — the hide rule
  // is a render decision, not a reason to call a hook conditionally.)
  if (!multi || host === undefined) return null;

  const name = hostName(servers, host) ?? host;
  // The machine's IDENTITY tint, or null when there is nothing to tell apart (lib/hosts.ts). It is
  // read here and not in AddressTag for the same reason the hide rule is here: which machine a row
  // is about is a fact about the snapshot, and this is the one component that already holds it.
  const slot = hostSlot(servers, host);
  // TIER 2, and only tier 2: this chip degrades when the LEAD can't reach this member. It says
  // nothing about whether the phone can reach the lead — that is the header pill, the banner and the
  // dog, all reading one shared clock, and duplicating their answer here is how two surfaces start
  // disagreeing about the same outage. An unlisted host (a member that departed while you were
  // looking at it) resolves to `unknown` rather than being dropped or quietly assumed healthy.
  //
  // ── AND WHY THE CONDITION IS `writable`, NOT `state !== "live"` ──────────────
  // `state === "stale"` is a statement about the AGE of the lead's receipt, never a verdict on the
  // machine (lib/host-health.ts). This chip used to degrade on `state !== "live"` alone and append
  // "(unreachable)" with it, so a peer answering every request — its receipt merely older than the
  // sweep's cadence — was announced down to a screen reader, beside a composer that was accepting
  // sends. The dashed border and the word are the same fact as the refusal: the lead's plain
  // boolean, unsmoothed, exactly what `writeRefusal` gates on. Absent health on a pack is a departed
  // member, which is not writable either.
  const unreachable = !health?.writable;
  // ONE condition drives BOTH the styling and the label, so the two can never drift into a chip that
  // looks fine and reads down (or the reverse). The word itself is narrower than the styling: only
  // `!writable` may spell "unreachable".
  const degraded =
    unreachable || health?.incompatible === true || (state ?? health?.state ?? "unknown") === "unknown";
  const target = variant === "target";
  const caption = variant === "caption";
  // The name is decorative repetition for a screen reader if it were bare text, so the WHOLE chip
  // carries one label that says what it MEANS. Both write-surface variants say "sends to": `target`
  // heads a dock or sheet that is about to write, and `caption` stands on the composer's own status
  // strip, a thumb's width from the box being typed into. "Host: attic" there would be a fact with no
  // verb, beside the one control whose whole question is where the text is going.
  const label = t(target || caption ? "connection.host.ariaSends" : "connection.host.ariaHost", {
    name,
    unreachable: unreachable ? t("connection.host.ariaUnreachableSuffix") : "",
  });

  // THE CAPTION RUN IS NOT A PILL, which is why it is not an AddressTag. It is a small uppercase run
  // standing in a line of chrome type — the composer's status band — where a bordered pill would read
  // as a second object dropped into the sentence rather than as part of it. It has no border to dash,
  // so the SHAPE of the fault moves into the glyph (ServerOff rather than Server), because colour
  // alone is the encoding WCAG 1.4.1 names and a red host name a few px from the composer's own red
  // refusal copy is exactly the confusion that rule exists for.
  //
  // `text-[10px]/3`, one utility and never `text-[10px] leading-3`: tailwind-merge lists `leading` as
  // conflicting with `font-size`, so ANY later `text-<size>` in the same cn() silently deletes an
  // earlier `leading-*`. It did — the run rendered at a 15px line and grew the pane header to 63px.
  //
  // `size-2.5` (10px) rather than the pills' `size-3`, and that is a MEASUREMENT of the band it
  // stands in, not a taste: the band's content box is 12px, so a 12px glyph IS the box and touches
  // both rules. At 10px it clears them and shares the caps' optical centre. composer.tsx holds the
  // full sum.
  if (caption) {
    return (
      <span
        aria-label={label}
        className={cn(
          "inline-flex min-w-0 items-center gap-1 text-[10px]/3 font-medium uppercase tracking-wide",
          // Degraded first, always: the run is two hundred pixels from the box being typed into, and
          // "which machine" must never outrank "that machine is not taking writes". The NAME stays
          // this colour either way — only the glyph below carries the identity tint.
          degraded ? "text-status-blocked" : "text-muted-foreground",
          className,
        )}
      >
        {degraded ? (
          <ServerOff className="size-2.5 shrink-0" aria-hidden />
        ) : (
          <Server
            className={cn("size-2.5 shrink-0", slot !== null && HOST_TEXT_CLASSES[slot])}
            aria-hidden
          />
        )}
        <span className="truncate" aria-hidden>
          {name}
        </span>
      </span>
    );
  }

  return (
    <AddressTag
      aria-label={label}
      glyph={<Server className="size-3 shrink-0" aria-hidden />}
      prefix={target ? t("connection.host.onPrefix") : undefined}
      name={name}
      size={target ? "md" : "sm"}
      tone={degraded ? "alert" : "quiet"}
      slot={slot}
      className={className}
    />
  );
}
