import type { ReactNode } from "react";
import { Settings } from "lucide-react";
import { useNavigate } from "react-router";

import { isConnecting } from "@/lib/connection";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";
import { useMuxLogoUrl, useMuxName } from "@/lib/mux-capability";
import { useConnectionLost, useConnectionTrouble } from "@/hooks/use-connection-lost";
import { settingsPath } from "@/lib/nav";
import { CollieHome } from "@/components/collie-home";
import { AlphaBar } from "@/components/alpha-bar";
import type { BridgeStatus } from "@/lib/types";
import type { Scope } from "@/lib/scope";

interface AppHeaderProps {
  // Connection state — the inputs that drive the CollieHome dog. The dog gallops on sustained trouble
  // (≥4s not-live) and rests muted once lost (≥15s), both derived here from the SAME shared connection-
  // health clock the ConnectionBanner reads, so the header mark and the top connection bar can never
  // disagree. There is no longer a per-header pill: the single ConnectionBanner (mounted once in
  // RootLayout) owns all connection copy, so a healthy header is just the mark + the caller's own items.
  bridge: BridgeStatus | undefined;
  error: boolean;
  stalled?: boolean;

  /** Tapping the Collie mark returns to the dashboard. A callback, not a `<Link to="/">`: the
   *  dashboard and the drilled-in space view share the "/" route, so a same-route link would no-op. */
  onHome?: () => void;
  /** Show the "Collie" wordmark beside the mark (dashboard + space). Omit inside a pane — the
   *  breadcrumb in `children` carries the context there, and the mark stands alone to save width. */
  wordmark?: boolean;

  /** Route-specific center content — the pane's `space › tab` breadcrumb. Rendered in a `flex-1
   *  min-w-0` region so a long breadcrumb truncates instead of pushing the pill off the row. Empty on
   *  the dashboard/space, where the region is just the spacer that pushes the right cluster over. */
  children?: ReactNode;
  /** Right-cluster lead items (the dashboard's SessionSwitcher; the pane's StatusBadge). */
  rightLead?: ReactNode;
  /** Right-cluster trailing items (the Settings gear). */
  rightTrail?: ReactNode;

  /** Full-width takeover of the header row: the caller supplies the row's whole content instead of
   *  the mark + breadcrumb + right cluster. Two users, and they are deliberately the same mechanism.
   *  The pane's FIND BAR sets it while searching, so the find bar owns the row one-handed. Settings
   *  and Pack set it permanently, because they lead with a back button where the mark stands rather
   *  than with the mark. Either way the row still lives inside this one shell, so the
   *  sticky/safe-area/prerelease-strip/rule/height recipe is never copy-pasted — which is what a
   *  hand-rolled `<header>` on those two routes had been doing, 20px shorter and with no AlphaBar. */
  override?: ReactNode;
}

// The single header shell every screen mounts: the sticky, safe-area-aware bar with the Collie
// mark on the left, an optional route breadcrumb in the middle, and the caller's right cluster. The
// mark's connection animation is baked in here (not a slot), so no caller can forget it: it gallops on
// sustained trouble and rests muted once lost, computed from the SAME shared clock as the top
// ConnectionBanner so the two never diverge. A healthy header is calm — just the mark + the caller's
// own items (switcher/badge + gear).
export function AppHeader({
  bridge,
  error,
  stalled,
  onHome,
  wordmark,
  children,
  rightLead,
  rightTrail,
  override,
}: AppHeaderProps) {
  // The same two shared-clock signals the ConnectionBanner reads, so the dog and the bar agree by
  // construction: gallop while troubled (≥4s not-live), rest muted once lost (≥15s, latched).
  useLocale();
  const connecting = isConnecting({ bridge, error, stalled });
  const trouble = useConnectionTrouble(connecting);
  const lost = useConnectionLost(connecting);
  // What this collie drives, printed beside the wordmark. It ALWAYS describes the LOCAL collie and
  // never changes with the viewed scope: `/api/config`'s mux block is this bridge's own, and a peer's
  // is not fetched (the pack link carries runtime data, not a second config channel). So on `?h=peer`
  // the line still reads "on <the lead's mux>" — the name of the thing the page you are running is
  // built on, which is what a support question needs.
  const mux = useMuxName();
  // The mark that goes with that name, served by the bridge from the ADAPTER's own bytes. Empty
  // whenever no logo was published, and empty renders nothing — see useMuxLogoUrl.
  const muxLogo = useMuxLogoUrl();
  return (
    // A column, not a row: the sticky bar owns the safe-area inset and stacks the (usually absent)
    // prerelease strip above the header row proper, which keeps its original padding. On a stable
    // build AlphaBar renders null and the geometry is byte-for-byte what it always was — the inset +
    // the row's own py-2 reproduce the old `calc(safe-area + 0.5rem)` top padding exactly. The strip
    // sits ABOVE everything including the find-bar override: while you're searching an alpha it is
    // still an alpha.
    // Chrome is the PAGE colour, separated by a rule — not a fill. The old `bg-muted` band was a
    // step below the page, and on the pane screen that stacked 235 (header) → 241 (tab strip wash)
    // → 245 (mirror) in the 120px where --background's 0.97 was picked precisely to close the seam
    // against the inverted mirror. The band only existed because `border-border/60` measures 1.09:1
    // on the page and could not carry the separation alone; `border-rule` is 1.34:1 light / 2.06:1
    // dark and can. COUPLED: CollieHome's `paper` is the knockout colour and must name this same
    // background or every near-side bead grows a halo — app-header.test.tsx asserts the two agree.
    <header className="sticky top-0 z-20 flex flex-col border-b border-rule bg-background [padding-top:env(safe-area-inset-top)]">
      <AlphaBar />
      {/* The row has a FLOOR, not a fixed height: `min-h-15` (60px) = the 44px tap target every
          icon control in here is built to + this row's own `py-2`. Before it, the row simply took
          the height of the tallest thing a caller happened to pass, so the header was 60px on the
          dashboard (the 44px SettingsGear) and 56px inside a pane (no gear, so the 40px mark was
          tallest) — a 4px jump on every dashboard→pane navigation. A row whose height is decided by
          its props cannot be stable, so the floor is stated here, once, and no caller can lower it.
          `min-h` rather than `h`: a future child taller than 44px still GROWS the row instead of
          being clipped or overflowing it — the header would get taller (on every route at once,
          because they all mount this row), which is a visible design decision rather than a silent
          overlap.

          `py-1`, not `py-2` — and the 4px it gives back is not a saving, it is a RELOCATION. The
          pane's identity block is three lines now (caption / name / cwd), and with 8px of outer
          padding it had one leftover pixel to divide between them: measured, 8px above the block
          against a 1px gap between its lines, an 8 : 1 ratio where the two-line block had been 5 : 1.
          The line count rose 50% and the air between the lines halved, which is why fewer items did
          not produce a calmer row — it reads as one grey paragraph rather than three lines. At `py-1`
          the content box is 52px and the block spends it 12 / 4 / 20 / 4 / 12, so outer air and inner
          air are both 4px and the row still measures exactly 60px on every route. Nothing moves and
          nothing is clipped. What it gives up is the 8px of breathing room a future taller-than-44px
          child would have got; it gets 4.

          SINCE THEN the pane's block lost its caption line — the status word moved down to the
          composer's status strip — so it is TWO lines and 36px, not three and 52px. `py-1` is
          therefore no longer load-bearing here: 36px of lines centred inside a 60px floor leaves
          12px of air above and below whether this padding is 4px or 8px, measured both ways. So
          `py-2` would now read identically and would hand a future taller-than-44px child its 8px
          back. That is a PROPOSAL, not a change — the number is left exactly where it was measured,
          one variable at a time. */}
      <div className="flex min-h-15 items-center gap-2 pl-4 pr-2 py-1">
        {override ?? (
          <>
            <CollieHome onHome={onHome} trouble={trouble} lost={lost} wordmark={wordmark} />
            {/* "on <mux>" — a plain sentence completing the wordmark, so the top-left reads
                "Collie on <mux>". It rides WITH the wordmark (dashboard + space, never the pane,
                where the breadcrumb owns the width) and sits OUTSIDE the home button so it isn't
                part of that tap target and stays readable to a screen reader, which the button's
                aria-label would otherwise replace. Text only, one size down and muted, so it reads
                as a caption to the wordmark rather than a second brand. Nothing renders until a
                bridge has actually named one: an old bridge, a cached page or a read still in
                flight all leave the header exactly as it was, never a "on unknown" placeholder. */}
            {wordmark && mux !== "" && (
              <span className="-ml-1 min-w-0 truncate text-xs text-muted-foreground">
                {t("nav.mux.onPrefix")}{" "}
                {/* The multiplexer's own mark, between "on" and its name. `alt=""` and nothing else:
                    the name is right there in the same sentence, so a screen reader announcing the
                    picture too would read the multiplexer twice — this is decoration OF that word.
                    An `<img>` and never inline SVG: these bytes come from an adapter, and the one
                    way to be certain adapter-supplied markup can never become document markup is to
                    never put it in the document (the mirror's XSS boundary, same rule). The bridge
                    serves it sandboxed. Sized in `em` so it tracks this caption's own line rather
                    than a pixel guess, and inline so the line stays ONE text run — the sentence is
                    still "on <name>" to a screen reader and to a text query. Nothing renders when
                    the bridge published no URL. */}
                {muxLogo !== "" && (
                  <img
                    src={muxLogo}
                    alt=""
                    className="mr-1 inline-block size-[1.15em] align-[-0.2em]"
                  />
                )}
                {mux}
              </span>
            )}
            {/* Center region: the breadcrumb (or, on the dashboard/space, an empty flex-1 spacer that
                pushes the right cluster to the edge). min-w-0 so the breadcrumb truncates when tight. */}
            <div className="flex min-w-0 flex-1 items-center">{children}</div>
            {/* gap-1, not gap-3: the icon buttons now carry their own 12px of padding to reach 44px,
                so a 12px gap on top of that reads as a gulf. 4px keeps the apparent spacing between
                icons close to what it was. */}
            <div className="flex items-center gap-1">
              {rightLead}
              {rightTrail}
            </div>
          </>
        )}
      </div>
    </header>
  );
}

// The Settings gear, shared so the dashboard and space headers don't each hand-roll it. Session-scoped
// so the navigation stays on the session you're viewing.
export function SettingsGear({ scope }: { scope?: Scope }) {
  const navigate = useNavigate();
  useLocale();
  return (
    <button
      type="button"
      onClick={() => navigate(settingsPath(scope))}
      aria-label={t("nav.settings.aria")}
      // A real 44px box, NOT padding pulled back by a negative margin. The negative-margin trick
      // keeps icons visually tight but lets adjacent boxes overlap (two -m-3 buttons pull 24px
      // against a 12px gap, so a neighbour steals 12px of this one's hit area) and drags the last
      // one past the header's padding into document overflow. Costs horizontal room, which the
      // breadcrumb absorbs — it already truncates by design.
      className="grid size-11 place-items-center text-muted-foreground transition-colors hover:text-foreground"
    >
      <Settings className="size-5" />
    </button>
  );
}
