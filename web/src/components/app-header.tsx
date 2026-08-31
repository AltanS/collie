import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Settings } from "lucide-react";
import { useNavigate } from "react-router";

import { isConnecting } from "@/lib/connection";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useLocale } from "@/hooks/use-locale";
import { useMuxLogoUrl, useMuxName } from "@/lib/mux-capability";
import { useConnectionLost, useConnectionTrouble } from "@/hooks/use-connection-lost";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import { settingsPath } from "@/lib/nav";
import { CollieHome } from "@/components/collie-home";
import { AlphaBar } from "@/components/alpha-bar";
import { Collapse } from "@/components/ui/collapse";
import { SectionLabel } from "@/components/ui/section-label";
import type { BridgeStatus } from "@/lib/types";
import type { Scope } from "@/lib/scope";

/** What a route claims about the SHAPE of the shared row, as opposed to the content it portals into
 *  it. These are the three things the shell itself has to draw differently, and every one of them is
 *  a primitive — which is what makes the claim safe to hold in state: `setClaim` bails out when the
 *  incoming value is equal, so a route re-rendering ten times a second never re-renders the header. */
interface HeaderClaim {
  /** Show the stacked identity beside the mark: the "Collie" brand line over the "on <mux>" line. */
  wordmark: boolean;
  /** `column` = the header is as wide as the route's own `max-w-screen-sm` content column, which is
   *  what the dashboard, space, Settings and Pack screens have always been; `full` = edge to edge,
   *  which is what the pane and history screens have always been. Invisible on a phone, where the
   *  viewport is narrower than the column; on a desktop it is the difference between a 640px rule
   *  under the header and a 1280px one, so it is a real property of the route and not a default. */
  width: "column" | "full";
  /** The route has taken the whole row (Settings, Pack, and either find bar). The shell then draws
   *  no mark, no caption and no slots — see `RouteHeader`. */
  override: boolean;
  /** The route wants the row GONE, not merely empty — the pane's zen mode, and nothing else today.
   *
   *  It is a claim rather than a prop for the same reason the other three are: the shell owns the
   *  `<header>` element, so only the shell can stop drawing it, and the route that wants it gone is
   *  mounted below it. The element itself STAYS, with its safe-area inset and its reserved rule; the
   *  row inside it leaves through `Collapse` — DESIGN.md §1's only sanctioned way an in-flow surface
   *  arrives or leaves, and §2's reason for not tearing 60px out of the top of the page in one frame.
   *  Keeping the inset is deliberate: the notch is not screen a mirror could use anyway, and a route
   *  that took the inset over would double it against the header's own the moment the row came back. */
  hidden: boolean;
}

// What a route gets when no route has claimed the row: the bare shell. This is the FORGOT case, and
// it is deliberately benign rather than empty — the mark, the strip, the rule and the 60px floor are
// all the shell's own, so a route that renders no <RouteHeader/> at all still gets a real header of
// the right height. The one thing it cannot get wrong is the thing the operator was looking at.
const UNCLAIMED: HeaderClaim = { wordmark: false, width: "full", override: false, hidden: false };

function sameClaim(a: HeaderClaim, b: HeaderClaim): boolean {
  return (
    a.wordmark === b.wordmark &&
    a.width === b.width &&
    a.override === b.override &&
    a.hidden === b.hidden
  );
}

/** The wiring `RouteHeader` needs to reach the one shell: the three portal hosts, the claim setter,
 *  and the ref the mark's tap is dispatched through. */
interface HeaderSlots {
  center: HTMLElement | null;
  right: HTMLElement | null;
  override: HTMLElement | null;
  /** Set by the route that currently owns the row; read (never subscribed to) by the shell's mark.
   *  A ref and not state because `onHome` is a fresh closure on every route render and nothing about
   *  the header RENDERS differently for it — putting it in the claim would churn the shell once per
   *  route render for a value only a click ever reads. */
  home: RefObject<{ owner: string; fn?: () => void } | null>;
  claim: (owner: string, claim: HeaderClaim) => void;
  release: (owner: string) => void;
}

const HeaderSlotContext = createContext<HeaderSlots | null>(null);

interface AppHeaderHostProps {
  // Connection state — the inputs that drive the CollieHome dog. The dog blooms on sustained trouble
  // (≥4s not-live) and rests muted once lost (≥15s), both derived here from the SAME shared connection-
  // health clock the ConnectionBanner reads, so the header mark and the top connection bar can never
  // disagree. Taken from the ROOT snapshot, once, rather than from each route: every route was
  // forwarding the same two fields off the same loader, so there was a way for them to disagree and
  // no way for them to be right differently.
  bridge: BridgeStatus | undefined;
  error: boolean;
  /** The routes below it. Not a sibling: the host RENDERS the outlet, so there is no arrangement of
   *  this app in which a route is mounted without a header above it. */
  children: ReactNode;
}

/**
 * THE ONE HEADER, mounted once above the outlet — the sticky, safe-area-aware bar with the Collie
 * mark on the left, an optional route breadcrumb in the middle, and the route's right cluster.
 *
 * It is here, and not in each route, because a header inside `<Outlet/>` is a header that UNMOUNTS
 * on every navigation. That cost more than a re-render: the mark is 37 CSS animations on seven
 * orbiting beads at durations from 17.8s to 48s, and a remount restarts every one of them at zero,
 * so the orbit jumped back to its start each time the operator opened a pane. It also threw away the
 * mark's `useId()`-derived gradient/filter/mask ids (rebuilt from scratch, real DOM churn) and its
 * `was` rate-change ref, which is what carries the phase across a loading↔idle switch — reinitialised
 * to the current value, so the very next toggle read as "no change" and skipped the carry-over
 * entirely. None of that is reachable by memoising inside the mark: the `useMemo` on its markup is
 * per-instance, and a new instance is exactly what was happening.
 *
 * The pattern is `RootLayout`'s existing one — UpdateAvailableBanner and ConnectionBanner already sit
 * above the outlet and already survive navigation. This is the third thing on that shelf.
 *
 * Routes feed it through `<RouteHeader/>`; see the note there for why that is a portal and not a
 * store of nodes.
 */
export function AppHeaderHost({ bridge, error, children }: AppHeaderHostProps) {
  // The same two shared-clock signals the ConnectionBanner reads, so the dog and the bar agree by
  // construction: bloom while troubled (≥4s not-live), rest muted once lost (≥15s, latched).
  useLocale();
  // Read here rather than forwarded by each route, for the same reason `bridge`/`error` are: it is a
  // pure function of the router's own navigation/revalidation state, so it is the same boolean in
  // every route and there is nothing for a route to decide about it.
  const stalled = useLoadingStalled();
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

  const [center, setCenter] = useState<HTMLElement | null>(null);
  const [right, setRight] = useState<HTMLElement | null>(null);
  const [overrideHost, setOverrideHost] = useState<HTMLElement | null>(null);
  const [claim, setClaim] = useState<HeaderClaim>(UNCLAIMED);
  const home = useRef<{ owner: string; fn?: () => void } | null>(null);
  // Who owns the row right now. THE TRANSITION FRAME: React tears the leaving route's fibers down
  // before it runs the arriving route's layout effects, so the normal order is release-then-claim and
  // the arriving route always wins. This token makes that ordering irrelevant — a release only lands
  // if the releasing route is still the owner, so a late teardown can never blank a row somebody else
  // has already taken. Without it, the failure is a header that goes back to a bare mark mid-navigation.
  const owner = useRef<string | null>(null);

  const claimRow = useCallback((id: string, next: HeaderClaim) => {
    owner.current = id;
    setClaim((prev) => (sameClaim(prev, next) ? prev : next));
  }, []);
  const releaseRow = useCallback((id: string) => {
    if (owner.current !== id) return;
    owner.current = null;
    setClaim((prev) => (sameClaim(prev, UNCLAIMED) ? prev : UNCLAIMED));
  }, []);

  const slots = useMemo<HeaderSlots>(
    () => ({ center, right, override: overrideHost, home, claim: claimRow, release: releaseRow }),
    [center, right, overrideHost, claimRow, releaseRow],
  );

  return (
    <HeaderSlotContext.Provider value={slots}>
      {/* A column, not a row: the sticky bar owns the safe-area inset and stacks the (usually absent)
          prerelease strip above the header row proper, which keeps its original padding. On a stable
          build AlphaBar renders null and the geometry is byte-for-byte what it always was — the inset +
          the row's own py-2 reproduce the old `calc(safe-area + 0.5rem)` top padding exactly. The strip
          sits ABOVE everything including the find-bar override: while you're searching an alpha it is
          still an alpha. It is also mounted exactly ONCE now, for the first time — six routes each
          mounting this shell meant six AlphaBars over the app's lifetime, one at a time.
          Chrome is the PAGE colour, separated by a rule — not a fill. The old `bg-muted` band was a
          step below the page, and on the pane screen that stacked 235 (header) → 241 (tab strip wash)
          → 245 (mirror) in the 120px where --background's 0.97 was picked precisely to close the seam
          against the inverted mirror. The band only existed because `border-border/60` measures 1.09:1
          on the page and could not carry the separation alone; `border-rule` is 1.34:1 light / 2.06:1
          dark and can. COUPLED: CollieHome's `paper` is the knockout colour and must name this same
          background or every near-side bead grows a halo — app-header.test.tsx asserts the two agree.
          `mx-auto w-full max-w-screen-sm` on the claim's say-so: the header used to live INSIDE each
          route's own content column, so it inherited that column's width for free. Hoisted, it has to
          state it — otherwise the dashboard's 640px rule would silently become the viewport's. */}
      <header
        className={cn(
          "sticky top-0 z-20 flex flex-col border-b bg-background [padding-top:env(safe-area-inset-top)]",
          // The rule is RECOLOURED, never removed — DESIGN.md §2's own technique, and the width stays
          // reserved in the base string above. While a route has the row hidden (zen) there are no
          // two regions left to cut apart, so the edge goes transparent; nothing moves by a pixel
          // when it comes back.
          claim.hidden ? "border-transparent" : "border-rule",
          claim.width === "column" && "mx-auto w-full max-w-screen-sm",
        )}
      >
        {/* The row and the prerelease strip leave TOGETHER, and through `Collapse` — DESIGN.md §1's
            only sanctioned way an in-flow surface arrives or leaves, which is what makes "hide the
            chrome" a 240ms slide instead of 60px vanishing between two frames. `Collapse` unmounts at
            the end of its exit, so the mark, the route's ⋮ and its breadcrumb leave the tab order
            with the pixels: the portal HOSTS live in here, so a route portalling into them simply
            finds no target and renders nothing. */}
        <Collapse open={!claim.hidden}>
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
          <div data-slot="header-row" className="flex min-h-15 items-center gap-2 pl-4 pr-2 py-1">
            {!claim.override && (
              <>
                {/* The mark is the shell's, not a slot — which is now literal rather than a promise: it
                    is mounted once for the life of the app, so no route can forget it and no navigation
                    can restart it. `onHome` is dispatched through the owner's ref, so the tap still does
                    the route's own thing (space → dashboard, pane → dashboard, history → the pane)
                    without the callback's identity re-rendering anything. */}
                <CollieHome
                  onHome={() => home.current?.fn?.()}
                  trouble={trouble}
                  lost={lost}
                />
                {/* THE IDENTITY, STACKED: the brand over the multiplexer this collie drives, both
                    beside the mark. It was ONE 18px line — "Collie on <mux>" — and on a phone that
                    line ran out of room inside the multiplexer's NAME, the one word here the reader
                    does not already know; the operator's screenshot had it down to a single letter.
                    Stacking inverts what gives way. The two runs no longer compete for one line's
                    width, so the brand costs the name nothing and the name gets the whole block —
                    the width this block asks the row for is the mux line's alone (the brand is out
                    of flow, see below). Both lines still carry `truncate`, and the brand is the one
                    that clips first, because it is the shorter run inside a box the longer run
                    sized.

                    The brand wears the app's EXISTING 11px uppercase tracked tier — `SectionLabel`,
                    DESIGN.md §1 — and not a new type style. It reads as the eyebrow over the line
                    that carries the information, which is the right emphasis: which multiplexer is
                    under this collie is what a support question needs; that the app is called Collie
                    is not.

                    THE MUX LINE IS THE BLOCK'S ONLY FLOW CHILD; the brand rides above it out of
                    flow. This is what puts "on <mux>" on the same visual line as the row's other
                    centred children (the host/session chips, the gear): the row centres every
                    child, so whatever height this block CONTRIBUTES is what gets centred — and
                    when it contributed both lines (40.5px), the mux line's centre landed 8px below
                    everything else's, which read as the right cluster floating on its own line
                    between the two left ones. With the eyebrow absolute (`bottom-full`), the block
                    contributes exactly the mux line's 24px box, so that line's centre IS the row's
                    centre, shared with every chip. The alignment holds by construction, not by a
                    compensating offset that would drift the next time a size changes.

                    THE ROW'S HEIGHT STILL DOES NOT MOVE (DESIGN.md §2, §6). The row is `min-h-15`
                    (60px) with `py-1`, a 52px content box, and its tallest child is the mark's 44px
                    tap box — this block now contributes 24px, less than before, so nothing grows.
                    The eyebrow is 11px at `leading-none` (the arbitrary size would otherwise take
                    the body's 1.5 and draw 16.5px): from the block's top at 18px it reaches up to
                    7px from the row's top edge, inside the row's own box with the top padding to
                    spare. An out-of-flow child adds no width either — this block is sized by the
                    mux line alone, which the old flex column already guaranteed in practice (the
                    brand is the shorter run) and this makes true by construction; `max-w-full`
                    keeps the eyebrow clipping to that width, so it still truncates first. The mux
                    logo changes none of it: 1.15em on a -0.2em baseline shift stays inside the
                    line box the type already asked for.

                    It rides WITH the wordmark claim (dashboard + space, never the pane, where the
                    breadcrumb owns the width) and sits OUTSIDE the home button, as the mux line
                    always has: that button's aria-label would otherwise replace both lines for a
                    screen reader. The brand word moved out of the button with it, so the tap target
                    is the mark's own 44px box and nothing else — the floor §6 asks for, and the same
                    box the gear at the other end of the row has. */}
                {claim.wordmark && (
                  <div data-slot="header-identity" className="relative min-w-0">
                    <SectionLabel className="absolute bottom-full left-0 max-w-full truncate leading-none">
                      Collie
                    </SectionLabel>
                    {/* The line the freed width is FOR — "on <mux>", the sentence the brand line
                        above starts. `min-h-6` RESERVES it whether or not a name has arrived:
                        nothing renders until a bridge has actually named one (an old bridge, a
                        cached page or a read still in flight all leave it empty, never an "on
                        unknown" placeholder), and a box with no line box inside it is 0px tall — so
                        without the reservation the brand line would jump 24px upward the moment
                        /api/config landed. DESIGN.md §2: a state with nothing to say keeps its slot.

                        The prefix stays a dictionary string and stays on this line. It is the word
                        that makes two stacked runs one sentence rather than two loose labels, and it
                        is the only translated word here — the brand and the multiplexer's own name
                        are names, and names are not translated. */}
                    <span className="block min-h-6 truncate text-base">
                      {mux !== "" && (
                        <>
                          {t("nav.mux.onPrefix")}{" "}
                          {/* The multiplexer's own mark, between "on" and its name. `alt=""` and
                              nothing else: the name is right there in the same sentence, so a screen
                              reader announcing the picture too would read the multiplexer twice —
                              this is decoration OF that word. An `<img>` and never inline SVG: these
                              bytes come from an adapter, and the one way to be certain adapter-
                              supplied markup can never become document markup is to never put it in
                              the document (the mirror's XSS boundary, same rule). The bridge serves
                              it sandboxed. Sized in `em` so it tracks this line's own type rather
                              than a pixel guess, and inline so the line stays ONE text run — the
                              sentence is still "on <name>" to a screen reader and to a text query.
                              Nothing renders when the bridge published no URL. */}
                          {muxLogo !== "" && (
                            <img
                              src={muxLogo}
                              alt=""
                              className="mr-1 inline-block size-[1.15em] align-[-0.2em]"
                            />
                          )}
                          {mux}
                        </>
                      )}
                    </span>
                  </div>
                )}
                {/* Center region: the breadcrumb (or, on the dashboard/space, an empty flex-1 spacer that
                    pushes the right cluster to the edge). min-w-0 so the breadcrumb truncates when tight.
                    Unmounted, not hidden, while a route owns the row: an empty `flex-1` box left standing
                    would still eat the row's free width and push a find bar off the right edge. */}
                <div
                  data-slot="header-center"
                  ref={setCenter}
                  className="flex min-w-0 flex-1 items-center"
                />
                {/* gap-1, not gap-3: the icon buttons now carry their own 12px of padding to reach 44px,
                    so a 12px gap on top of that reads as a gulf. 4px keeps the apparent spacing between
                    icons close to what it was. */}
                <div data-slot="header-right" ref={setRight} className="flex items-center gap-1" />
              </>
            )}
            {/* The takeover host. `display: contents` so the route's own children are direct flex items
                of this row, exactly as they were when `override` was a prop the row spread inline —
                a wrapper box here would give Settings' back button a second, unpadded parent. Always
                mounted (a portal needs a live target in the same commit the route renders into it) and
                contributes no box of its own when empty. */}
            <div data-slot="header-override" ref={setOverrideHost} style={{ display: "contents" }} />
          </div>
        </Collapse>
      </header>
      {children}
    </HeaderSlotContext.Provider>
  );
}

interface RouteHeaderProps {
  /** Tapping the Collie mark returns to the dashboard. A callback, not a `<Link to="/">`: the
   *  dashboard and the drilled-in space view share the "/" route, so a same-route link would no-op. */
  onHome?: () => void;
  /** Show the stacked identity beside the mark — "Collie" over "on <mux>" (dashboard + space). Omit
   *  inside a pane: the breadcrumb in `children` carries the context there, and the mark stands alone
   *  to save width. */
  wordmark?: boolean;
  /** Whether this route's header is as wide as its `max-w-screen-sm` content column or edge to edge.
   *  See `HeaderClaim.width`. Defaults to `full`, which is the plainer of the two. */
  width?: "column" | "full";

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

  /** Take the header row off the screen entirely — the pane's zen mode, and nothing else today. See
   *  `HeaderClaim.hidden` for what survives (the element, its inset, its reserved rule) and why. */
  hidden?: boolean;
}

/**
 * A route's contribution to the one header. Renders NO chrome of its own: it portals its nodes into
 * the shell's hosts and states the four shape facts the shell has to draw (`HeaderClaim`).
 *
 * WHY A PORTAL, and not a context the route writes its nodes into. The nodes are the point: the
 * pane's breadcrumb closes over `openSpace`, the find bar over `setFindQuery` and the match cursor.
 * Pushing live nodes through state means writing them in an effect, which is one render LATE by
 * construction (the header paints the previous route's items for a frame, or none), and re-writing
 * them on every route render, which is a fresh object every time and therefore either a render loop
 * or a hand-rolled external store. A portal has neither problem: the children are rendered by the
 * ROUTE, in the same commit as the route, so the header's contents are exactly as fresh as the
 * screen under it and there is no extra render pass at all.
 *
 * It also keeps the right things resetting. Everything a route puts in the row still LIVES in the
 * route's tree, so the find bar's query, the switchers' open sheets and the pane's identity all
 * still unmount with their route, exactly as before. The hoist deliberately preserves only what the
 * shell owns — the mark, the strip, the rule, the height — and every one of those is global by
 * nature. A stateful hoisted header would have carried one screen's find bar into the next screen.
 *
 * TWO ROUTES DURING A TRANSITION. React commits the leaving route's teardown before the arriving
 * route's layout effects, so the ordinary sequence is release → claim and the arriving route wins.
 * `owner` in the shell makes the reverse order harmless too. And because the claim is four
 * primitives, `setClaim` bails out when nothing actually changed, so a route re-rendering on every
 * poll does not re-render the header — which is the whole point of not remounting it.
 */
export function RouteHeader({
  onHome,
  wordmark = false,
  width = "full",
  children,
  rightLead,
  rightTrail,
  override,
  hidden = false,
}: RouteHeaderProps) {
  const slots = useContext(HeaderSlotContext);
  // Loud, not lenient. A <RouteHeader/> outside the host means a route was mounted with no header
  // above it, which on a phone is a screen with no way home — silently falling back to an inline
  // header would hide exactly the mistake this refactor exists to make impossible.
  if (!slots) throw new Error("<RouteHeader> must be rendered inside <AppHeaderHost>");
  const owner = useId();
  const overridden = override !== undefined;
  const { home, claim, release } = slots;

  // Every dep is a primitive, so this runs on a real change and not once per route render. A LAYOUT
  // effect, not a passive one: it lands in the same commit the portal's children do, before the
  // browser paints, so there is no frame in which the row's shape and its contents disagree.
  useLayoutEffect(() => {
    claim(owner, { wordmark, width, override: overridden, hidden });
    return () => release(owner);
  }, [claim, release, owner, wordmark, width, overridden, hidden]);

  // The mark's tap. No deps: `onHome` is a new closure on every render and the shell reads this
  // through a ref at click time, so keeping it current costs one assignment and re-renders nothing.
  useLayoutEffect(() => {
    home.current = { owner, fn: onHome };
  });
  // Cleared only if this route still owns it, for the same reason the claim is — a leaving route
  // must not disarm the arriving route's mark.
  useLayoutEffect(
    () => () => {
      if (home.current?.owner === owner) home.current = null;
    },
    [home, owner],
  );

  // `override ?? (…)`, moved a level out: while a route owns the row, its center and right items are
  // not rendered at all rather than rendered and hidden — same as when this was one component, and
  // the reason `queryByText` for a yielded breadcrumb still finds nothing.
  if (overridden) {
    return slots.override ? createPortal(override, slots.override) : null;
  }
  return (
    <>
      {slots.center ? createPortal(children, slots.center) : null}
      {slots.right ? createPortal(<>{rightLead}{rightTrail}</>, slots.right) : null}
    </>
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
