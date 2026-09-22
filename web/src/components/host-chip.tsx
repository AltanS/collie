import { Server, ServerOff } from "lucide-react";

import { cn } from "@/lib/utils";
import { AddressTag } from "@/components/ui/address-tag";
import { HOST_TEXT_CLASSES, hostName, hostSlot } from "@/lib/hosts";
import { linkPresentation, type HostState } from "@/lib/host-health";
import { useHostHealth, useCrew } from "@/components/crew-provider";
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
   *
   * `bare` — no pill and no uppercase either: the name in the same small mono a path line wears, for
   * the END of the pane header's path line, where the machine and the working directory are one
   * address and a bordered pill would read as a second object dropped on the end of it. It shares
   * `caption`'s drawing rules — the tint on the glyph, the fault in the glyph's SHAPE — and differs
   * from it only in type, which is why the two are one branch below.
   */
  variant?: "tag" | "target" | "caption" | "bare";
  /**
   * This chip stands ON a write surface, so its accessible name says "sends to <name>" rather than
   * "host: <name>". `target` and `caption` imply it and need not pass it.
   *
   * It is a separate flag rather than a fourth variant because it is a fact about the SURFACE, not
   * about the drawing: the actions belt opens with an ordinary `tag` — a pill among 32px pills, at
   * the pill register — and that pill still names the machine every button beside it writes to. A
   * `tag` on a dashboard row names which machine a row is ABOUT and keeps "host:", which is why
   * this cannot simply be the variant's default.
   */
  sends?: boolean;
  className?: string;
}

// The one place that answers "which machine is this?", and the one place that decides whether the
// question is even worth asking.
//
// ── THE HIDE RULE LIVES HERE, NOT IN THE CALLERS ─────────────────────────────
// Renders `null` when the crew is a single machine — i.e. for every install that exists today —
// which is why callers may mount it unconditionally. If each caller had to ask "am I on a crew?"
// first, a solo install would eventually grow a stray chip and, far worse, a crew install would
// eventually drop one at the surface that mattered.
//
// ── AND WHY IT IS NEVER THE SESSION SWITCHER'S TWIN ──────────────────────────
// Two lookalike pills, one changing machines and one changing sessions, is a mis-tap waiting to
// happen (milestone constraint). So this is deliberately NOT a control: no tap target, no chevron, a
// server glyph rather than the switcher's layers, and it is a plain text node — a host name comes
// from the operator's `join` label and is rendered as text, never markup, like every other
// user-supplied string that reaches this UI.
/** THE HIDE RULE, ASKED RATHER THAN GUESSED. `true` exactly when {@link HostChip} would draw
 *  something for this host. Every caller mounts the chip unconditionally and lets it answer for
 *  itself, which is the rule this file's header states; this is the one definition behind it. */
function useHostChipShown(host: string | undefined): boolean {
  const { multi } = useCrew();
  return multi && host !== undefined;
}

export function HostChip({ host, state, variant = "tag", sends, className }: HostChipProps) {
  useLocale();
  const { servers } = useCrew();
  const health = useHostHealth(host);
  const shown = useHostChipShown(host);
  // No crew, or nothing to name: the whole dimension is invisible. (Hooks run first — the hide rule
  // is a render decision, not a reason to call a hook conditionally.)
  if (!shown || host === undefined) return null;

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
  // boolean, unsmoothed, exactly what `writeRefusal` gates on. Absent health on a crew is a departed
  // member, which is not writable either.
  const unreachable = !health?.writable;
  // ONE condition drives BOTH the styling and the label, so the two can never drift into a chip that
  // looks fine and reads down (or the reverse). The word itself is narrower than the styling: only
  // `!writable` may spell "unreachable".
  const degraded =
    unreachable || health?.incompatible === true || (state ?? health?.state ?? "unknown") === "unknown";
  // WHICH degraded reading this is (§10.2's presentation split), from the lead's own answer and never
  // re-derived here — the crew page reads the same function, so the two screens cannot describe one
  // machine two ways. It takes `unreachable` and not `degraded` for the reason above: only
  // `!writable` may put a WORD on this chip, and an absent `linkState` keeps that word as it is.
  const link = linkPresentation(unreachable, health?.linkState);
  // ONE value for the styling, and it reads `link` wherever `link` says anything. Reconnecting is the
  // quiet fault: the lead is retrying inside its budget and will most likely have it back on the next
  // poll, so it is dashed and amber rather than red. Everything else keeps today's alert exactly.
  const tone = link === "reconnecting" ? "waiting" : degraded ? "alert" : "quiet";
  const target = variant === "target";
  const caption = variant === "caption";
  const bare = variant === "bare";
  // The name is decorative repetition for a screen reader if it were bare text, so the WHOLE chip
  // carries one label that says what it MEANS. Every write surface says "sends to": `target` heads a
  // dock or sheet that is about to write, `caption` was the composer's own status band, and `sends`
  // is the flag the actions belt passes on its opening `tag` — a thumb's width from the box being
  // typed into, and beside five buttons that all write. "Host: attic" there would be a fact with no
  // verb, beside the one control whose whole question is where the text is going.
  const label = t(target || caption || sends === true ? "connection.host.ariaSends" : "connection.host.ariaHost", {
    name,
    unreachable: linkSuffix(link),
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
  // full sum, and the path line `bare` stands on is the same 12px box, so the number holds there too.
  // `bare` IS THE CAPTION'S TWIN, one line of type apart. It stands at the end of the pane header's
  // path line rather than in a band of chrome, so it wears that line's own register — 11px mono, the
  // muted meta colour, no uppercase and no tracking — and the machine reads as the outermost part of
  // the address the path finishes. Everything else is the caption's, deliberately: the same tint on
  // the same glyph, the same `ServerOff` for a fault, the same one label for the whole run. A second
  // branch here is how the two would start describing one machine two different ways.
  if (caption || bare) {
    return (
      <span
        aria-label={label}
        className={cn(
          "inline-flex min-w-0 gap-1",
          // `bare` STANDS ON ITS BASELINE; `caption` still centres. An SVG has no baseline of its
          // own, so CSS synthesises one from its bottom margin edge — which puts the Server glyph's
          // BOX bottom on the name's baseline, and puts BOTH on the same line as the `CacheChip`
          // beside it, which aligns the same way (cache-chip.tsx § THE NUMBER STANDS ON THE
          // GLYPH'S BOTTOM EDGE). Centred, the 10px glyph sat about 1px high of the 11px word and
          // the row's two glyphs sat on two different lines — Altan's screenshot of the path line.
          // A box edge is not ink, though, and lucide's own paths sit a little inside their box —
          // measured in real Chromium at device resolution, the Server glyph's INK foot still sat
          // 0.26px above `lodge`'s own ink foot with the boxes flush. The `translate-y-[0.26px]`
          // below on the glyphs is that ink nudge, `bare` only — the caption run is alone in a band
          // of chrome type with nothing to line up with, and its 10px glyph in a 12px box reads flush
          // there regardless, so it is left as it is.
          caption
            ? "items-center text-[10px]/3 font-medium uppercase tracking-wide"
            : // `max-w-[8rem]` and `shrink-0` are AddressTag's one decision, kept here too (issue
              // #264): the run never gives up width to its neighbours, and the NAME truncates inside
              // it instead. Without the cap, a member id derived from a long hostname (26 chars,
              // search domain appended) held its whole width on the dashboard row, and every card on
              // that machine grew wider than a 375px phone, so the page panned sideways.
              "max-w-[8rem] shrink-0 items-baseline font-mono text-[11px]/3",
          // Degraded first, always: the run is two hundred pixels from the box being typed into, and
          // "which machine" must never outrank "that machine is not taking writes". The NAME stays
          // this colour either way — only the glyph below carries the identity tint.
          tone === "alert" ? "text-status-blocked" : tone === "waiting" ? "text-status-working" : "text-muted-foreground",
          className,
        )}
      >
        {tone !== "quiet" ? (
          <ServerOff className={cn("size-2.5 shrink-0", bare && "translate-y-[0.26px]")} aria-hidden />
        ) : (
          <Server
            className={cn(
              "size-2.5 shrink-0",
              bare && "translate-y-[0.26px]",
              slot !== null && HOST_TEXT_CLASSES[slot],
            )}
            aria-hidden
          />
        )}
        {/* `min-w-0`: a flex item will not shrink below its content without it, so `truncate`
            alone never cut the name short inside the capped run (issue #264). */}
        <span className="min-w-0 truncate" aria-hidden>
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
      tone={tone}
      slot={slot}
      className={className}
    />
  );
}

/**
 * The chip's whole label, appended to the name: what is wrong, in the operator's language, or `""`
 * when nothing is.
 *
 * A screen reader gets the same three readings the eye does, which is the point — the amber and the
 * red are not on the accessibility tree, and a chip that looked different and read identical would be
 * the drift this file's header is written against.
 */
function linkSuffix(link: ReturnType<typeof linkPresentation>): string {
  switch (link) {
    case "ok":
      return "";
    case "reconnecting":
      return t("connection.host.ariaSuffix", { word: t("connection.host.reconnecting") });
    case "attention":
      return t("connection.host.ariaSuffix", { word: t("connection.host.attention") });
    case "unreachable":
      // The one word that keeps its own key: it is the string every released build already ships,
      // and an absent `linkState` has to read exactly as it read before this split existed.
      return t("connection.host.ariaUnreachableSuffix");
  }
}
