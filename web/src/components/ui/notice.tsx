import type { ReactNode } from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The app's ONE notice surface: a tinted band or box that says something is not normal.
 *
 * Before this existed there were six hand-rolled ones (DESIGN.md §1 lists them: three heights,
 * three gutters, two radii and two different opinions about whether a notice has an edge at all),
 * and the top of the app moved every time its state changed. This is the primitive they collapse
 * into. It knows shape, tone and semantics; it knows nothing about connections, updates or panes,
 * and it never calls `t()` — the words arrive as children from the feature that owns the condition.
 *
 * It deliberately does NOT decide visibility, own a timer, own a position, or portal. A notice that
 * appears and disappears does so through `ui/collapse.tsx`; a strip that competes with other strips
 * is arbitrated by `ui/strip-host.tsx`; a transient one floats in `ui/toast-viewport.tsx`.
 */

/**
 * Severity, as a TONE rather than a category. This is the correction the six-banner zoo needed:
 * severity and category had been conflated, so every new severity grew a new component. Tone is a
 * colour and a level of politeness that any notice can carry.
 */
export type NoticeTone = "info" | "caution" | "danger" | "success" | "neutral";

/**
 * The two placements, and there are only two (DESIGN.md §4): `strip` is viewport chrome above the
 * header — full-bleed, closes its own bottom edge with a rule; `box` is content, inset on the
 * page's 16px gutter with a full border and the house 2px corner.
 */
export type NoticeVariant = "strip" | "box";

/** How, or whether, a screen reader is interrupted. See {@link NoticeProps.announce}. */
export type NoticeAnnounce = "alert" | "status" | "none";

/**
 * Whole-surface tap is EXCLUSIVE with an action cluster, at the type level.
 *
 * Not a style preference: a `<button>` wrapping a second `<button>` is invalid HTML, and the
 * browsers that tolerate it disagree about which one a tap fires. Expressing the exclusion in the
 * union means a caller cannot write the broken combination and discover it in the field — the
 * third member exists only so that a dismiss control cannot be added without an accessible name,
 * which `ui/` cannot supply itself because i18n lives on the feature side.
 */
type NoticeInteraction =
  | { onActivate: () => void; action?: never; onDismiss?: never; dismissLabel?: never }
  | { onActivate?: never; action?: ReactNode; onDismiss?: never; dismissLabel?: never }
  | { onActivate?: never; action?: ReactNode; onDismiss: () => void; dismissLabel: string };

export type NoticeProps = {
  tone: NoticeTone;
  /**
   * No default, on purpose. Which band a notice lives in is a fact about the caller's position in
   * the tree, not something a primitive can guess — and guessing wrong puts a full-bleed strip in
   * the middle of a content column.
   */
  variant: NoticeVariant;
  /**
   * `"alert"` emits `role="alert"` and nothing else; `"status"` emits `role="status"` and nothing
   * else; `"none"` emits neither. There is deliberately no way to ask for a role AND an
   * `aria-live` — that pair is a contradiction (a role carries its own implicit liveness, so
   * `role="alert"` with `aria-live="polite"` asks for assertive and polite at once) and it is live
   * today at connection-banner.tsx:236-237. Making it inexpressible is half of why this file
   * exists. Default `"none"`: a notice that never changes must not claim a live region.
   */
  announce?: NoticeAnnounce;
  /** Decorative, and treated as such — the copy beside it says the same thing in words. */
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
} & NoticeInteraction;

/**
 * Tone → token, and this table is the ONLY place the tint recipe may appear.
 *
 * `border-status-X/40 bg-status-X/15` + `text-status-X` was copy-pasted into four components before
 * this file existed; one table means a re-measured alpha lands once. The colour is a colour only —
 * the border WIDTH is reserved in the shape strings below, because Tailwind v4's preflight sets
 * `border: 0 solid` on everything (DESIGN.md §7 trap 1), so a border colour with no width paints
 * nothing at all, silently.
 *
 * `caution` points at `--status-working`, which currently doubles as both "in progress" and
 * "warning" app-wide. That is a real smell and it is deliberately not fixed here: minting a
 * `--status-caution` with identical values is a rename, not a fix. This table is the one seam a
 * genuine split (with re-measured values) lands in later — change the two lines here and every
 * cautioning notice in the app follows.
 *
 * `neutral` is the odd one out and is not a status at all: it is the NoEchoNotice ground, the
 * quiet "here is a note about what just happened" register, on `--muted` with the ordinary
 * `--border` edge.
 */
const TONE = {
  info: { surface: "border-status-info/40 bg-status-info/15", accent: "text-status-info" },
  caution: { surface: "border-status-working/40 bg-status-working/15", accent: "text-status-working" },
  danger: { surface: "border-status-blocked/40 bg-status-blocked/15", accent: "text-status-blocked" },
  success: { surface: "border-status-done/40 bg-status-done/15", accent: "text-status-done" },
  neutral: { surface: "border-border bg-muted/40", accent: "text-muted-foreground" },
} satisfies Record<NoticeTone, { surface: string; accent: string }>;

/**
 * The 44px tap floor for a notice's action button, bought as HIT area so the band stays thin.
 *
 * Same technique and same trap as `STRIP_TAP_TARGET` in `ui/labelled-strip.tsx`: a transparent
 * `::before` reaches past the drawn box, so a 24px button answers a 44px touch while the strip
 * still measures 33px. Three numbers hold it together and all three are load-bearing:
 *
 *  1. **`h-6` is 24px drawn**, which is what connection-banner's Retry already is, and it is the
 *     number the strip's and box's floors below are DERIVED from. Change it and re-derive them.
 *  2. **`-inset-y-[11px]`, not `-inset-y-2.5` (10px).** An absolutely positioned child resolves its
 *     insets against the PADDING box, and every `ui/button.tsx` carries the 1px transparent border
 *     that DESIGN.md §2 reserves. So the padding box of an `h-6` button is 22px, not 24, and 10px
 *     each way measures 42 — the floor missed by 2px, invisibly. 11px reaches a true 44. A control
 *     that is NOT a Button (no reserved border) reaches 46 here, which is fine; under is not.
 *  3. **An ancestor with `overflow: hidden` eats the extension**, taps and all, with nothing to
 *     see. That is why `ui/collapse.tsx` drops its clip once it has finished opening: the strip
 *     band is 33px and the reach is 11px, so every pixel of this target is outside the collapsed
 *     box it animates inside of.
 *
 * The tap floor is not negotiable, and the strip's floor is derived FROM this button — the strip
 * accommodates the target, never the other way round.
 */
export const NOTICE_ACTION_TAP =
  "relative before:absolute before:inset-x-0 before:-inset-y-[11px] before:content-['']";

/**
 * The clothes for an action button inside a Notice: 24px tall, small type, and the tap target
 * above. Pass it as `className` to `ui/button.tsx` — `<Button size="sm" className={NOTICE_ACTION}>`.
 * It lives here rather than at the call sites because the 24px is the strip floor's derivation.
 */
export const NOTICE_ACTION = `h-6 gap-1 px-2 text-xs ${NOTICE_ACTION_TAP}`;

/**
 * A strip is a full-bleed one-liner of viewport chrome, and it NEVER wraps — by contract, not by
 * luck. The copy goes in a single `min-w-0 flex-1 truncate` span below, so no string a feature
 * passes can turn a 33px band into a 49px one behind its back.
 *
 * **The floor: `min-h-[33px]`.** It is derived, not picked. 24px (the `h-6` action button, the
 * tallest thing a strip may legitimately contain) + this row's own `py-1` (2×4px) + the 1px tinted
 * `border-b`, which `border-box` counts INSIDE a min-height. 24+8+1 = 33. The next person will want
 * to tidy that into a round 32; the 1px they would be dropping is the rule that separates this band
 * from the header under it, and dropping it puts the jump back.
 *
 * Why state a floor at all: without one a strip is exactly as tall as whatever it happens to
 * contain, so a text-only "Reconnecting…" row renders SHORTER than an outage row carrying Retry,
 * and the band changes height as the session degrades. That is the 60px/56px header jump this
 * codebase already fixed once (DESIGN.md §6), one band higher up.
 *
 * Why `min-height` and NOT `height`, which is the same reason on record at app-header.tsx:100-109:
 * a future child taller than the floor must GROW the strip — visibly, in every place that mounts
 * one, so somebody has to look at the decision — rather than be clipped or overflow it silently.
 * The `py-1` stays so that taller child keeps its 4px of breathing room.
 *
 * No safe-area inset here. The band's top inset belongs to `ui/strip-host.tsx`, which owns the row;
 * three of the current strips carry it and one does not, which is exactly the drift a shared owner
 * ends. The FLOOR, by contrast, does belong here and not on the host: it is derived from the action
 * slot's button, which is this component's contract, and it is tone-tinted through the `border-b`,
 * which the host is deliberately blind to.
 */
const STRIP = "flex min-h-[33px] w-full items-center gap-2 border-b px-4 py-1 text-xs text-foreground";

/**
 * A box is content, not chrome: inset on the page gutter, full border, 2px corner (`rounded-sm` —
 * DESIGN.md §3, and where in doubt go sharper). The caller supplies the gutter, `mx-4 mt-3`, since
 * only the caller knows what it sits between.
 *
 * Unlike a strip a box WRAPS freely, and should: a two-line "this host has not checked in since…"
 * is two lines of true information, and truncating it would be a lie about a standing condition.
 *
 * **The same floor, box-shaped: `min-h-[42px]`.** 24px (the first-line slot, sized by the same
 * `h-6` action button) + `py-2` (2×8px) + the box's 2×1px border under `border-box`. 24+16+2 = 42.
 * Growth ABOVE the floor is legitimate; two ONE-LINE boxes differing because one carries an icon
 * and the other does not is the fault this closes.
 *
 * `items-start`, not `items-center`: a wrapping body wants its icon on the first line, not floating
 * beside the middle of a paragraph. A single line is then centred against the 24px first-line slot
 * by the body's own `min-h-6` (below), so a lone line sits optically centred instead of top-heavy —
 * both alignments, from one rule, without a conditional class that would make the box two heights.
 */
const BOX = "flex min-h-[42px] w-full items-start gap-2 rounded-sm border px-4 py-2 text-xs font-medium";

export function Notice({
  tone,
  variant,
  announce = "none",
  icon,
  children,
  className,
  onActivate,
  action,
  onDismiss,
  dismissLabel,
}: NoticeProps) {
  const { surface, accent } = TONE[tone];
  const strip = variant === "strip";

  // The live-region role rides the BODY, never the root, and it is one attribute or none — never a
  // role plus an aria-live (see NoticeProps.announce). Putting it on the body rather than the root
  // is what lets `onActivate` render the root as a real `<button>` without a role="status" on it
  // stripping its button semantics from the accessibility tree. A live region announces its
  // subtree's changes wherever it is nested, so nothing is lost by moving it one element in — and
  // the announced text is then exactly the text that changed.
  const role = announce === "none" ? undefined : announce;

  const body = strip ? (
    // ONE truncating, flex-1 span. This is the whole "strips never wrap" contract, and it is a
    // single element so there is nowhere for a second line to come from.
    <span role={role} className="min-w-0 flex-1 truncate font-medium">
      {children}
    </span>
  ) : (
    // min-h-6 + centred: the 24px first-line slot the box's floor is derived from. One line centres
    // in it; two or more lines simply outgrow it and the box grows with them.
    <div role={role} className="flex min-h-6 min-w-0 flex-1 flex-col justify-center">
      {children}
    </div>
  );

  const inner = (
    <>
      {icon ? (
        <span
          aria-hidden
          className={cn(
            "flex shrink-0 [&>svg]:size-3.5",
            // A box tints its whole self, so the icon inherits; a strip keeps its copy at full
            // foreground contrast (it is chrome over the page, not a tinted block) and spends the
            // tone on the icon and its edges alone. That split is what the four existing banners
            // already do; it is preserved here rather than re-decided.
            strip ? cn("items-center", accent) : "mt-[5px]",
          )}
        >
          {icon}
        </span>
      ) : null}
      {body}
      {action || onDismiss ? (
        <div className="flex shrink-0 items-center gap-1">
          {action}
          {onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              aria-label={dismissLabel}
              // Square, so it reaches sideways too — safe only because it is LAST in the row and
              // nothing sits to its right (the same condition STRIP_TAP_TARGET_SQUARE states).
              className={cn(
                "flex size-6 items-center justify-center rounded-sm opacity-70 hover:opacity-100",
                NOTICE_ACTION_TAP,
                "before:-inset-x-[11px]",
              )}
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );

  const box = cn(strip ? STRIP : BOX, surface, !strip && accent, className);

  // `onActivate` makes the WHOLE surface the target — the "new version, tap to update" case. A
  // 390×33 row passes the 44px floor on area the way a 28px text row never did, and it is one
  // element, so there is no second thing on the row to mis-hit. `text-left` because a <button>
  // centres its text by default and this one is a sentence, not a label.
  if (onActivate) {
    return (
      <button type="button" onClick={onActivate} className={cn(box, "text-left")}>
        {inner}
      </button>
    );
  }

  return <div className={box}>{inner}</div>;
}
