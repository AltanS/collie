import { Server, ServerOff } from "lucide-react";

import { cn } from "@/lib/utils";
import { hostName } from "@/lib/hosts";
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
   * `tag` — the default pill. `target` — extra emphasis for the write surfaces, a touch larger,
   * with the "on" preposition. `caption` — no pill at all: the pane header's line 1, where the host
   * is one word in a small uppercase run beside the status word, and a bordered chip would read as
   * a second object rather than as part of that sentence.
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

  return (
    <span
      // The name is decorative repetition for a screen reader if it were bare text, so the whole
      // chip carries one label that says what it MEANS.
      aria-label={t(target ? "connection.host.ariaSends" : "connection.host.ariaHost", {
        name,
        unreachable: unreachable ? t("connection.host.ariaUnreachableSuffix") : "",
      })}
      className={cn(
        "inline-flex items-center gap-1 font-medium",
        // The caption is a text run inside the identity block, so it MAY give up width (the machine
        // is a nice-to-know; the status word beside it is the answer and stays `shrink-0`). The pill
        // may not: everywhere else it is the last thing to go and the name truncates first. Same
        // reason it drops the 8rem cap — that cap showed 99px of a 170px `macbook-pro-16-2023.local`
        // in a row that now has the room.
        // `text-[10px]/3`, one utility and not `text-[10px] leading-3`: tailwind-merge lists
        // `leading` as conflicting with `font-size` (a named Tailwind size sets both), so ANY later
        // `text-<size>` in this same cn() silently deletes an earlier `leading-*`. It did — the
        // caption rendered at a 15px line and grew the pane header to 63px. The slash form cannot be
        // split apart, and the size ternary below is now gated so it never runs for the caption.
        caption
          ? "min-w-0 text-[10px]/3 uppercase tracking-wide"
          : cn("max-w-[8rem] shrink-0 rounded-md border px-1.5 py-0.5", target ? "text-[11px]" : "text-[10px]"),
        degraded
          ? // Unreachable is a STATE, not a disappearance (PACK_PROTOCOL.md §10.2) — it stays legible,
            // dashed rather than dimmed, so a blocked agent on a down machine is never greyed away.
            // In the caption there is no border to dash, so the SHAPE of the fault moves into the
            // glyph — ServerOff rather than Server — because colour alone is the one encoding
            // WCAG 1.4.1 names, and a red host name 15px from a possibly-red status word is exactly
            // the confusion that rule exists for.
            caption
            ? "text-status-blocked"
            : "border-dashed border-status-blocked/50 bg-status-blocked/10 text-status-blocked"
          : caption
            ? "text-muted-foreground"
            : "border-border bg-muted/60 text-muted-foreground",
        className,
      )}
    >
      {caption && degraded ? (
        <ServerOff className="size-3 shrink-0" aria-hidden />
      ) : (
        <Server className="size-3 shrink-0" aria-hidden />
      )}
      {target && (
        <span className="shrink-0 text-muted-foreground/70" aria-hidden>
          {t("connection.host.onPrefix")}
        </span>
      )}
      <span className="truncate" aria-hidden>
        {name}
      </span>
    </span>
  );
}
