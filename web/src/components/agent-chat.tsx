import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useNavigate, useRevalidator } from "react-router";
import {
  ArrowUpToLine,
  ChevronUp,
  EllipsisVertical,
  Loader2,
  Minimize2,
  ScrollText,
  TerminalSquare,
} from "lucide-react";
import { useSwipeUp } from "@/hooks/use-swipe";
import { useKeyboardOpen } from "@/hooks/use-keyboard";
import { useSpaceActions } from "@/hooks/use-spaces";
import { useDashPrefs, openForCount } from "@/hooks/use-dash-prefs";
import { mirrorFont, useDisplayPrefs } from "@/hooks/use-display-prefs";
import { useStableTerminalDraft } from "@/hooks/use-terminal-draft";
import { useLocale } from "@/hooks/use-locale";
import { isConnecting } from "@/lib/connection";
import { t, type MessageKey } from "@/lib/i18n";
import { setStatus } from "@/lib/status";
import { useZenEnabled } from "@/lib/zen";
import { setStripsCollapsed, useStripsCollapsed } from "@/lib/strips-collapsed";
import { ChatMessageList, type ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import { BottomSheet } from "@/components/ui/sheet";
import { Collapse, CollapseSwap } from "@/components/ui/collapse";
import { RouteHeader } from "@/components/app-header";
import { AnsiOutput } from "@/components/ansi-output";
import { MIRROR_SPACE, MIRROR_INVERT, styleFor } from "@/components/mirror-space";
import { cn } from "@/lib/utils";
import { paneTag } from "@/lib/pane-tag";
import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { adapterFor } from "@/lib/harness";
import { FindBar } from "@/components/find-bar";
import { Composer, type ComposerHandle } from "@/components/composer";
import { ThreadSidebar } from "@/components/agent-sidebar";
import { AgentIcon } from "@/components/agent-icon";
import { TabStrip } from "@/components/tab-strip";
import { PaneStrip } from "@/components/pane-strip";
import { StripsSummary } from "@/components/strips-summary";
import { PaneActionsSheet } from "@/components/pane-actions-sheet";
import { CompactStripLabels, STRIP_TAP_TARGET_SQUARE } from "@/components/ui/labelled-strip";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { HostStaleBanner } from "@/components/host-stale-banner";
import { useHostHealth } from "@/components/pack-provider";
import { writeRefusal } from "@/lib/host-health";
import { StatusArea } from "@/components/status-area";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { StatusDot } from "@/components/status-badge";
import { submitPromptFeedback, submitPromptOption } from "@/lib/prompt-action";
import { submitWizardKeys } from "@/lib/wizard-action";
import { submitPreviewKeys, submitPreviewNote, submitPreviewOption } from "@/lib/preview-action";
import { submitMultiSelectIntent, type MultiSelectIntent } from "@/lib/multi-select-action";
import { submitMenuKeys } from "@/lib/menu-action";
import type { PromptBlockAction } from "@/components/prompt-select-block";
import type { PreviewBlockAction } from "@/components/preview-select-block";
import type { MenuBlockAction } from "@/components/menu-block";
import { canGrowRequestedLines, growRequestedLines } from "@/lib/loaders";
import { cwdBeyondName } from "@/lib/pane-name";
import { useMuxCapability } from "@/lib/mux-capability";
import { hasJournalAdapter } from "@/lib/journal-agents";
import { historyPath, spacePath } from "@/lib/nav";
import { isReadOnly, statusLabel } from "@/lib/types";
import { usePairing } from "@/lib/pairing";
import type { AgentView, BridgeStatus, DeviceAuth, TabView } from "@/lib/types";
import type {
  MenuModel,
  MultiSelectModel,
  PreviewSelectModel,
  PromptModel,
  WizardModel,
} from "@/lib/blocks";
import type { Scope } from "@/lib/scope";

interface AgentChatProps {
  paneId: string;
  /** Which machine + which named session this pane lives in — scopes every read/write + the safety chip. */
  scope?: Scope;
  agent: AgentView | undefined;
  agents: AgentView[];
  shellPanes: AgentView[];
  tabs: TabView[];
  /** Label of the pane's tab, shown in the header as "space › tab". */
  tabLabel?: string;
  /** Pane output from the route loader (refreshed by polling/revalidation). */
  text: string;
  /** The scrollback window `text` was fetched with — tells a grown fetch from a stale in-flight poll. */
  requestedLines?: number;
  /** The pane's `revision` for `text` — the race guard checks a tapped menu against this. */
  revision?: number;
  /** Per-device auth from the snapshot; an unauthorised device drops the composer to read-only. */
  device?: DeviceAuth;
  // Global connection state, used HERE to dim the stale status dot while the data on screen is not
  // live. It no longer feeds the header: the Collie mark lives in the one hoisted shell now
  // (app-header.tsx) and reads bridge/error off the root snapshot itself, so this pane and that mark
  // cannot be handed different answers. Defaults describe a healthy link so tests that don't care
  // render "live".
  bridge?: BridgeStatus | undefined;
  error?: boolean;
  stalled?: boolean;
  onBack: () => void;
  onSelect: (paneId: string) => void;
}

/**
 * The fold chevron's accessible name, chosen for what is actually on screen. The glyph names
 * nothing, and "Hide tabs and panes" over a screen with no pane row is a promise about a row that
 * is not there — the summary bar's own name is built the same way, from the same two counts.
 */
function foldLabelKey(tabCount: number, paneCount: number): MessageKey {
  if (tabCount > 0 && paneCount > 1) return "chat.strips.hide.both";
  if (tabCount > 0) return "chat.strips.hide.tabs";
  return "chat.strips.hide.panes";
}

// At most one drawer/sheet is open at a time; null = none. (The composer's own Keys/Quick/Agent
// sheets are separate and live inside <Composer>.)
type Drawer = "switcher" | "paneMenu" | null;

// The detail view mirrors a terminal pane, NOT a chat thread. The pane's output comes from the
// route loader (`text`); polling revalidates it. Replies/keys are confirmed via the header status
// line (`setStatus`), then a revalidation pulls the fresh output.
//
// This shell owns the pane frame: the header (the find bar takes it over while find is open), the
// terminal mirror (freeze, find highlighting, load-older scrollback), and navigation (the nav hub +
// swipe-up switcher). The composer cluster — draft, send, keys, quick actions, slash-commands, image
// upload, display prefs, and the find-in-output trigger — lives in <Composer>; it reaches back here
// only to re-follow the tail after a send, focus on a mirror tap, and open find (which freezes the tail).
export function AgentChat({
  paneId,
  scope,
  agent,
  agents,
  shellPanes,
  tabs,
  tabLabel,
  text,
  requestedLines = 0,
  revision = 0,
  device,
  bridge = "connected",
  error = false,
  stalled = false,
  onBack,
  onSelect,
}: AgentChatProps) {
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  useLocale();
  // Poll-truth "is the data on screen not live". The one header shell derives the same boolean from
  // the same two root-snapshot fields to drive the Collie mark; here we use it to dim the header's
  // status dot AND its status word, so the pane stops presenting the last snapshot's status as
  // current while we're reconnecting/lost, and restores instantly on recovery. Both marks dim
  // together — dimming only one of them would leave a frozen reading looking half live.
  const connecting = isConnecting({ bridge, error, stalled });
  const { newTab } = useSpaceActions();
  // Single display-prefs instance: the View controls (in <Composer>) write it, the mirror reads it.
  const { prefs, setWrap, stepFontSize, setRawTerminal, setTapToFocus } = useDisplayPrefs();
  // The chosen terminal font (Settings → Terminal font), applied by re-pointing `--font-mono` on
  // the two mirror surfaces below and NOWHERE else — see mirrorFont() for how, and why it is not a
  // custom property. Scoped to terminal CONTENT on purpose: app chrome that happens to be monospace
  // (the pane index badge, the cwd line) keeps the app's own face. Same boundary MIRROR_SPACE draws.
  const mirrorFace = mirrorFont(prefs.fontFamily);
  // Raw-terminal escape hatch: when on, every Claude grammar is bypassed and the plain mirror shows,
  // so a mis-detected/mis-rendered dialog can always be driven by hand with the keys pad.
  const grammarsOn = !prefs.rawTerminal;
  const isShell = agent?.kind === "shell";
  // The header's line 1 — the pane's rendered NAME. Hoisted out of the JSX because line 2 is gated
  // against it: the cwd shows only when it names a segment this string does not already show.
  const paneName =
    agent === undefined
      ? ""
      : (agent.paneLabel ??
        agent.sessionName ??
        `${agent.workspaceLabel}${tabLabel !== undefined && tabLabel !== "" ? ` › ${tabLabel}` : ""}`);
  const cwd = agent === undefined ? null : cwdBeyondName(agent.cwd, paneName);
  // The panes that share this tab (agents + shells), in stable order. Computed once, HERE, because
  // two things far apart in this file must agree about it: <PaneStrip> below renders nothing under
  // two panes, and line 1's discriminator (next) appears in exactly the case where it does render.
  // Derived twice, the header can grow a `p3` on a screen with no pill row for `p3` to point at.
  const tabPanes = useMemo(
    () =>
      agent === undefined
        ? []
        : [...agents, ...shellPanes]
            .filter((p) => p.workspaceId === agent.workspaceId && p.tabId === agent.tabId)
            .toSorted((a, b) => a.paneId.localeCompare(b.paneId)),
    [agent, agents, shellPanes],
  );
  // A hand-set name — the operator's `pane.rename` label, or Claude's own `/rename` session name —
  // names THIS PANE and nothing else. `undefined` and not falsiness, to match how `paneName` above
  // picks with `??`: an empty label is a label the operator set, and the two must agree on that.
  const namedByHand = agent?.paneLabel !== undefined || agent?.sessionName !== undefined;
  /**
   * The pane's own short id (`p3`) for line 1 — null in the common case, which is most panes.
   *
   * THE FAULT IT CLOSES. When `paneName` falls all the way through to `space › tab`, line 1 names a
   * TAB while the status dot badged next to it reports ONE PANE. And a tab is precisely the thing
   * that holds several panes — a multi-pane tab is what makes the pane strip appear below — so the
   * header can read as "this tab is done" when only the pane you have open is done.
   *
   * THE FIX IS ON THE NAME, NOT ON THE DOT, and that was a ruling rather than a convenience. This
   * screen is a pane surface end to end: the mirror, the composer and that dot all scope to the one
   * pane. The app's dot ladder widens by one level per step and is right at every step —
   * `pane-strip.tsx` per pane, `tab-strip.tsx` worst-in-tab, `space-strip.tsx` worst-in-space. Making
   * this dot worst-in-tab would leave the pane screen as the only place where the dot and the screen
   * it sits on disagree about what they describe. Naming the pane makes line 1 true instead, which is
   * both the smaller change and the honest one.
   *
   * TWO GATES, EACH LOAD-BEARING. Only on the fallback, because a hand-set name was never ambiguous
   * and decorating it would add an id to a string the operator chose. And only above one pane,
   * because with a single pane the tab's name effectively names the pane, there is no sibling to
   * confuse it with, and there is no pill row below carrying the matching suffix.
   */
  const discriminator =
    agent !== undefined && !namedByHand && tabPanes.length > 1 ? paneTag(agent.paneId) : null;
  // This device may not type into agents: the backend rejects every write, so the composer drops to
  // read-only (and shows a banner). The mirror still polls (reading is fine). Either write gate puts
  // us here — the proxy-asserted allowlist, or a missing/rejected pairing credential — and the
  // ReadOnlyBanner names which.
  const { refused: notPaired } = usePairing();
  const readOnly = isReadOnly(device) || notPaired;
  // TIER 2: is the machine THIS pane lives on still answering the lead? Read off the pane's own host
  // — never the ambient scope — because the pane row is what carries the truth about where it lives;
  // `scope.host` is the fallback for a pane the snapshot has already dropped (an absent `?h=` is the
  // lead, which `useHostHealth` resolves through the roster).
  //
  // Two separate answers, deliberately: `hostHealth` drives PRESENTATION (the mirror below is
  // last-good, and says so), while `hostBlock` — the §10.3 refusal — drives WRITES. They differ by
  // §10.2's tolerance, so a single missed sweep never flashes a banner, but a member the lead
  // currently believes unreachable is refused the instant it says so. Neither one touches the global
  // clock: the lead answered, so this poll was live, and the ConnectionBanner stays silent.
  const hostHealth = useHostHealth(agent?.host ?? scope?.host);
  const hostBlock = writeRefusal(hostHealth);
  /**
   * The ONE reason this pane currently refuses a write, or undefined when it accepts them. Every
   * write handler below starts with it, so there is a single place that decides both which gates
   * exist and in what order they speak — the device gate first (it is about YOU and holds on every
   * machine), then the host gate (it is about ONE machine and clears on the next poll).
   *
   * Deliberately a function of both gates rather than two checks per handler: five handlers × two
   * gates is exactly the shape where the sixth handler gets written with one of them missing, and a
   * missing host gate here means keys typed at a terminal the lead can't reach.
   */
  const refuseWrite = useCallback(
    (): string | undefined => (readOnly ? t("chat.status.readOnly") : hostBlock),
    [readOnly, hostBlock],
  );

  // Drawers/sheets are mutually exclusive — at most one open. A single value makes that invariant
  // unrepresentable to violate.
  const [drawer, setDrawer] = useState<Drawer>(null);
  const closeDrawer = () => setDrawer(null);

  // ── ZEN MODE — chrome-free, mirror-only viewing ───────────────────────────────
  // On a phone the chrome IS most of the viewport: measured at 390x844 this route spends 199px above
  // the mirror on the header and the two strips alone, before the statusline, the handle and the
  // composer underneath. Reading a long build log or a wide TUI, all of it is in the way. Zen takes
  // every Collie surface off the screen and leaves the terminal mirror, without changing one thing
  // about how the mirror renders or polls.
  //
  // TWO HALVES, AND ONLY ONE OF THEM PERSISTS. `zenAvailable` is the per-device Settings toggle
  // (lib/zen.ts) and it gates the ENTRY POINT, nothing else — it decides whether the pane's actions
  // sheet offers the row at all. `zen` itself is transient local state: DetailRoute keys this
  // component by paneId, so switching pane remounts it and a pane always opens with its chrome, and
  // a reload does the same. Deliberately NOT a DisplayPrefs field — if stickiness is ever wanted
  // that is where it goes, but nobody has asked and a chrome-free view leaking into the next pane is
  // the worse default.
  const [zen, setZen] = useState(false);
  const zenAvailable = useZenEnabled();

  // Escape leaves, because every other full-screen surface in this app already binds it (BottomSheet
  // and the sheets it backs) and zen would otherwise be the one that ignores the convention. It
  // costs nothing on a phone, which has no Escape key, and it is the whole keyboard story: there is
  // no focus to hand back on exit, since the row that entered zen belongs to a sheet that closed
  // itself in the same commit.
  useEffect(() => {
    if (!zen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zen]);

  // Entering must first clear the chrome that carries state of its own: the find bar lives IN the
  // header row that is about to leave, and a sheet left open would survive into zen as a covering
  // panel whose trigger is gone. `setDrawer(null)` also discards a sequence staged in the Keys dock
  // WITHOUT that dock's two-tap confirm — the parent cannot reach that choke point — which is
  // accepted for the reason ADR 0005 gives: a queue never outlives its dock, and `switchTo` already
  // destroys one the same way.
  function enterZen() {
    // Blur BEFORE the composer unmounts. On iOS the soft keyboard belongs to the focused node, so
    // unmounting a focused <textarea> can leave the keyboard standing over a screen that no longer
    // has an input. The sheet this is called from has usually taken focus already, so this is
    // insurance rather than the common path — and it is blunt on purpose: everything that could be
    // holding focus here is about to leave, so working out which costs more than it saves.
    // SAFETY: `activeElement` is typed `Element | null`; the optional call is the narrowing — a
    // non-HTMLElement (an <svg>, or null) simply has no `blur` and the call is a no-op.
    (document.activeElement as HTMLElement | null)?.blur();
    setDrawer(null);
    closeFind();
    setZen(true);
  }
  const listRef = useRef<ChatMessageListHandle>(null);
  const composerRef = useRef<ComposerHandle>(null);

  const gone = !agent;

  // Swipe up (or just tap) the handle above the composer to bring up the pane switcher. A lowish
  // threshold + a taller hit area (below) make the gesture easy to land with a thumb; tapping is the
  // reliable fallback. "Up" naturally reveals a bottom sheet without fighting the mirror's scroll.
  const swipe = useSwipeUp(() => setDrawer("switcher"), 24);
  // ── COMPOSING MODE — read ONCE, here, for the whole pane ──────────────────────
  // The soft keyboard takes roughly 45% of a phone. What is left has to hold the header, the tab
  // strip, the agent's statusline, the grab handle, the status band, the controls row and the draft
  // — and the operator measured the result: the mirror shows ZERO rows of what the agent said while
  // three rows of cache percentages hold their ground, and the send button lands under the keyboard.
  //
  // So two rows stand down while the keyboard is up, and both are chosen on the same test: is this
  // read BEFORE typing, or DURING it? The pane switcher is read before — nobody switches panes
  // mid-sentence — and the statusline is reference data. Both come back untouched the instant the
  // keyboard closes, which is a state the operator causes and understands.
  //
  // WHAT DOES NOT STAND DOWN IS THE STATUS BAND, and that is the operator's own suggestion declined
  // with a reason. It is 14px, the cheapest row on the screen, and it is the only place the pane's
  // state is spelled as a WORD rather than a coloured dot — which is why it exists (WCAG 1.4.1,
  // status-badge.tsx holds the measurement). It is also read at exactly this moment: it answers
  // "is this agent even waiting for me?" while the thumb is over Send. The 30px handle and the
  // 21–112px statusline are 4–8x the pixels at none of the cost.
  //
  // Read once and passed down, never called again in a child: two components calling this hook
  // separately is two thresholds, two ideas of when the mode starts, and one boundary animating out
  // of step with itself.
  const composing = useKeyboardOpen();

  // ── THE FOLDED STRIPS, AND THE ONE STATE THAT OVERRIDES THE PREFERENCE ────────
  // The tab row and the pane row fold together into `StripsSummary`, a 32px bar of beads. One
  // toggle, not two: they are one band of "chrome about the pane", they leave in one gesture, and a
  // screen where the operator can hide the tabs but not the panes is a setting, not a fold.
  //
  // TWO TIERS AGAIN, AND THE SPLIT IS NOT ZEN'S. `stripsPref` is the operator's device-level choice
  // (lib/strips-collapsed.ts) and it persists. `keyboardFold` is the transient override that exists
  // only while the soft keyboard is up, and NOTHING about it is written down.
  //
  // Why the keyboard wins by default: the keyboard takes roughly 45% of the phone, and the rows are
  // read BEFORE typing, never during it — the same test `composing` above applies to the pane
  // switcher and the statusline, reached here for the same reason and answered the same way. So
  // while the keyboard is up the rows stand down whatever the preference says.
  //
  // Why the override may not persist: an expand taken with the keyboard up is the operator saying
  // "I need to see the tabs right now", not "show me the tabs from now on". Writing it would let one
  // mid-sentence tap redefine every future pane. It therefore resets the moment the keyboard closes,
  // and a fold taken in that state writes nothing either — it already matches the state the keyboard
  // imposes, so there is nothing to record.
  const stripsPref = useStripsCollapsed();
  const [keyboardFold, setKeyboardFold] = useState<boolean | null>(null);
  useEffect(() => {
    if (!composing) setKeyboardFold(null);
  }, [composing]);
  const stripsFolded = composing ? (keyboardFold ?? true) : stripsPref;
  function toggleStrips() {
    if (composing) {
      setKeyboardFold(!stripsFolded);
      return;
    }
    setStripsCollapsed(!stripsFolded);
  }
  // Is there anything to fold, and is there anywhere to put the control that folds it? TabStrip
  // renders null when this space reports no tabs and PaneStrip renders null below two panes, so with
  // both silent there is no band — no summary bar and no chevron, because a fold over nothing is a
  // control that lies. The chevron itself is pinned to the TAB row's trailing end (see TabStrip's
  // `trailing` slot), so the fold is offered exactly when that row exists: a snapshot that somehow
  // carries panes but no tab for them keeps its pane row and is simply not foldable, which is the
  // honest answer and not a second placement to maintain.
  const stripTabs =
    agent === undefined ? [] : tabs.filter((tab) => tab.workspaceId === agent.workspaceId);
  const canFold = stripTabs.length > 0;
  const stripsExist = canFold || tabPanes.length > 1;
  const folded = canFold && stripsFolded;
  // WHO OWNS THE 4px ABOVE THE MIRROR'S RULE.
  //
  // It reads as the mirror's own margin and it is not: it is the PAGE AN OPEN FOLDER TAB SITS ON,
  // and the mirror's comment below states at length why it may not be 0 while such a tab exists.
  // Parked on the mirror it was unconditional, so folded — no tab, nothing sitting on anything — it
  // was 4px of nothing under a 24px bar, which is what the operator saw.
  //
  // So it moves to the row that needs it: the strips' own `pb-1`, INSIDE their `Collapse`. There it
  // arrives and leaves with them, animated by the same 240ms, instead of popping on a boolean. The
  // mirror then keeps a copy for exactly the states where that Collapse is not there to provide one
  // — no strips at all, and zen, where the band is closed and the 4px is the hidden header's air
  // rather than a tab's floor. Zen's resting geometry is byte-identical either way, which is the
  // point of naming it here rather than folding it into `stripsExist`.
  const mirrorGap = stripsExist && !zen ? "mt-0" : "mt-1";
  // Fold state for the "Switch pane" sheet's two long tails, shared with the dashboard so one
  // "hide the long tail" preference means the same thing in both places.
  const dash = useDashPrefs();

  // Mirror freeze: at the bottom we follow live output; the moment you scroll up to read backscroll
  // we hold the text steady (no reflow / no re-pin) until you jump back to latest — so a long
  // message stays put long enough to read instead of sliding out of the rolling window.
  //
  // The frozen snapshot is a {text, revision} PAIR captured at the same instant: the prompt-select
  // race guard must check a tap against the revision of what the user is LOOKING AT. The live
  // `revision` prop keeps advancing with background polls while the mirror is frozen — comparing
  // against it would blind the guard to drift that happened before the freeze (live-vs-live always
  // matches). While following, the frozen pair IS the live pair by definition.
  const [following, setFollowing] = useState(true);
  const [shown, setShown] = useState({ text, revision });
  useEffect(() => {
    if (!following) return;
    // Functional update that returns the previous object when nothing changed keeps React's
    // Object.is bailout — no re-render per poll while the pane is quiet.
    setShown((prev) =>
      prev.text === text && prev.revision === revision ? prev : { text, revision },
    );
  }, [text, revision, following]);
  const display = shown.text;
  const hasNew = !following && display !== text;

  // The agent's own statusline (model · ctx% · cwd · branch · tokens · permission mode) is stripped
  // off the mirror by stripChrome so it doesn't duplicate the composer — but it carries real context
  // (the branch, most notably), so we re-surface it as app chrome just above the composer, where it
  // sat in the TUI. ALL its rows: a configured statusline is routinely 2–3 rows tall, and we used to
  // surface only the first, silently losing the rest. Routed through the SAME adapter (adapterFor)
  // whose buildBlocks strips the chrome, so the two can't drift; empty when there's no adapter for
  // the agent, a menu is up, or no box at the tail, in which case the strip is hidden. A second parse
  // of `display`, but memoised on it, so it only recomputes when the buffer content changes — off the
  // render hot path.
  const statusLines = useMemo(
    () =>
      grammarsOn ? adapterFor(agent?.agent)?.extractStatusLines(splitLines(parseAnsi(display))) ?? [] : [],
    [display, agent?.agent, grammarsOn],
  );

  // A user draft stranded on the input box's "❯" line — a message queued while the agent was busy
  // then recalled, which persists across turns. stripChrome peels the box off the mirror so it goes
  // invisible, and (worse) pane.send_text appends to it, corrupting the next send. We surface it to
  // the composer as a read-only preview the user can deliberately Take over — the input is otherwise
  // exclusively phone-owned. Same parse source + same adapter as the statusline, so the two can't
  // drift; null when raw-terminal is on, there's no adapter, no box is at the tail, or the line is empty.
  const rawTerminalDraft = useMemo(
    () =>
      grammarsOn
        ? adapterFor(agent?.agent)?.extractInputDraft(splitLines(parseAnsi(display))) ?? null
        : null,
    [display, agent?.agent, grammarsOn],
  );
  // Is a dialog (prompt/wizard/preview/multi-select) on screen right now? Any non-raw block means
  // the TUI's keyboard belongs to it, so the composer must refuse a free-text send: the text would
  // be swallowed and the submit key would answer the dialog (#34). Same parse source and adapter as
  // the two probes above, so the three can't drift. This is the zero-latency fail-fast; the
  // load-bearing protection is reply-action's verify-before-submit, which also covers a dialog that
  // appears after this render.
  const dialogPresent = useMemo(
    () =>
      grammarsOn
        ? (adapterFor(agent?.agent)?.buildBlocks(splitLines(parseAnsi(display))) ?? []).some(
            (b) => b.kind !== "raw",
          )
        : false,
    [display, agent?.agent, grammarsOn],
  );

  // Both are threaded to the composer: the RAW value (live) plus a stabilised one. extractInputDraft
  // is stateless, so it can't distinguish a stranded draft from the ~350ms flash where our OWN
  // just-sent reply sits on the "❯" line waiting for the bridge's pending Enter. The stabilised value
  // (same text must persist ~1.5s) gates the preview's APPEARANCE so that flash never surfaces (the
  // composer adds a second guard: it suppresses a draft matching what it just sent); once shown, the
  // preview's text tracks the RAW line live, so host typing streams in without ever touching the input.
  const terminalDraft = useStableTerminalDraft(rawTerminalDraft);

  // Find-in-output: search the already-fetched buffer. The bar takes over the header while open;
  // AnsiOutput highlights matches and reports the count back here; prev/next scrolls the focused
  // match into view. Opening freezes the tail so matches don't shift under you as polls land.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  useEffect(() => {
    setCurrentMatch(0); // a fresh query starts from the first match
  }, [findQuery]);
  const handleMatchCount = useCallback((n: number) => {
    setMatchCount(n);
    setCurrentMatch((c) => (n === 0 ? 0 : Math.min(c, n - 1)));
  }, []);
  function gotoMatch(delta: number) {
    if (matchCount === 0) return;
    setFollowing(false); // freeze the tail so scroll-into-view doesn't fight the live re-pin
    setCurrentMatch((c) => (c + delta + matchCount) % matchCount);
  }
  function openFind() {
    setFollowing(false); // freeze the buffer so the search target is stable while you type
    setFindOpen(true);
  }
  function closeFind() {
    setFindOpen(false);
    setFindQuery("");
  }

  // What the top of the buffer can offer — see the JSX for why these are mutually exclusive.
  // `historyAvailable`: the pane reported an agent session, so a transcript exists to open.
  // `moreScrollback`: Herdr says this pane can still yield lines beyond the window we've asked for,
  // AND we're under the cap Herdr's own read clamp imposes. `readableLines` is undefined on an older
  // bridge/Herdr; treat that as "no idea" and stay hidden rather than offer a tap that fetches nothing.
  // A THIRD state joins those two on a multiplexer that keeps no agent session log at all
  // (M10/06). It is not the same fact as `hasSession`: that one says "this pane never named a
  // session", which is a per-pane answer an operator can act on by starting an agent; this one says
  // "nothing here will ever name one", which is a property of the multiplexer and needs saying out
  // loud. Hiding it is what leaves someone wondering whether Collie is broken.
  const sessionLog = useMuxCapability("agentSessionRef");
  const historyAvailable = Boolean(agent?.hasSession) && sessionLog.capable;
  // A FOURTH state, and the per-pane sibling of the third (#137). `hasSession` folds two facts into
  // one flag bridge-side — "this pane named a session" AND "this agent has a journal adapter" — so
  // its absence alone cannot say which half failed, and the two want opposite words. On an agent
  // with no journal adapter there is nothing to explain and nothing renders. On one that HAS a
  // journal adapter, an absent session means the agent never reported a session ref to Herdr, which
  // is what the `herdr integration install <agent>` hook does at agent session start — missing or
  // outdated, it hides both history affordances with no explanation anywhere.
  //
  // It EXPLAINS, it never offers: this decides no button and does not touch `historyAvailable` (a
  // pane with no session still has no transcript to open, and a tap that fetched nothing would be
  // the worse answer). `sessionLog.capable` is required as well, because when the MULTIPLEXER keeps
  // no agent session log the note above already says so in the adapter's own words — and telling
  // the operator to reinstall a hook that could never help would contradict it.
  const noSessionReported =
    sessionLog.capable && hasJournalAdapter(agent?.agent) && !agent?.hasSession;
  // Scrollback has its own capability, and it is a genuinely different one: a multiplexer can keep
  // screen history while knowing nothing about agents. Hidden rather than explained when absent —
  // "there is nothing older to load" is not a fact anyone comes looking for.
  const scrollback = useMuxCapability("gridScrollback");
  const moreScrollback =
    scrollback.capable &&
    agent?.readableLines !== undefined &&
    requestedLines < agent.readableLines &&
    canGrowRequestedLines(paneId, scope);

  // Load older scrollback: raise the per-pane requested line count and refetch. The enlarged buffer
  // prepends older lines at the top, so we adopt it into the frozen display and re-anchor the scroll
  // position (measure height before, restore after) to keep the content you were reading in place.
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderAnchor = useRef<{ height: number; top: number } | null>(null);
  const adoptTarget = useRef<number | null>(null); // the requestedLines a pending grow is waiting on
  const pendingRestore = useRef(false); // re-anchor scroll after the enlarged display paints
  function loadOlder() {
    if (loadingOlder || !canGrowRequestedLines(paneId, scope)) return;
    const el = listRef.current?.getScrollElement();
    olderAnchor.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    setLoadingOlder(true);
    setFollowing(false); // stay put in history rather than snapping to the tail
    adoptTarget.current = growRequestedLines(paneId, scope);
    revalidator.revalidate();
  }
  // Adopt the enlarged buffer into the frozen display once the *grown* fetch lands — keyed on the
  // requested line count so a stale in-flight poll (still on the old window) can't adopt early.
  // Adopts the whole {text, revision} pair (props from the same loader result) so the frozen
  // snapshot stays coherent for the race guard.
  useEffect(() => {
    const target = adoptTarget.current;
    if (target === null || requestedLines < target) return;
    adoptTarget.current = null;
    setLoadingOlder(false);
    if (text === display) {
      olderAnchor.current = null; // nothing new arrived (buffer shorter than the window)
      return;
    }
    pendingRestore.current = true;
    setShown({ text, revision });
  }, [requestedLines, text, revision, display]);
  // After the enlarged display paints, keep the previously-visible content anchored (content grew at
  // the top, so push scrollTop down by the height delta).
  useLayoutEffect(() => {
    if (!pendingRestore.current) return;
    pendingRestore.current = false;
    const anchor = olderAnchor.current;
    const el = listRef.current?.getScrollElement();
    if (anchor && el) el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
    olderAnchor.current = null;
  }, [display]);

  // Opening / switching into this pane must land on the live tail. Stickiness usually handles it,
  // but the first flex layout + AnsiOutput paint can race; pin once after mount so a tab/pane open
  // never strands you at the oldest scrollback.
  useLayoutEffect(() => {
    listRef.current?.scrollToBottom();
  }, []);

  // After a successful send, snap the mirror back to the live tail so the reply's result is visible.
  const onSent = () => {
    setFollowing(true);
    revalidator.revalidate();
    listRef.current?.scrollToBottom();
  };

  // Tap a prompt-select option. This can type into a real terminal, so it runs the revision-based
  // race guard first (fresh fetch → revision + re-derived-menu equality); only a clean match sends
  // the option's keys. The guard checks against the FROZEN pair's revision — the menu the user
  // tapped was derived from `shown.text`, so `shown.revision` is the revision of what they saw
  // (the live `revision` prop may have advanced under a frozen mirror). A stale tap is discarded
  // with a "menu changed" notice and a revalidate; a clean send snaps back to the tail so the
  // result is visible. The composer stays live for the free-text rows we don't render as buttons.
  const handlePromptAction = useCallback(
    async (action: PromptBlockAction, prompt: PromptModel) => {
      const refusal = refuseWrite();
      if (refusal) {
        setStatus(refusal, "error");
        return false;
      }
      const base = {
        paneId,
        scope,
        requestedLines,
        detectedRevision: shown.revision,
        agent: agent?.agent,
        prompt,
      };
      // Two recipes behind one block: a single guarded keystroke for an option, and the plan
      // dialog's multi-step feedback sequence (digit → verify focus → type → Enter, which denies the
      // plan and hands the agent the text — see lib/prompt-action.ts).
      const result =
        action.kind === "option"
          ? await submitPromptOption({ ...base, option: action.option })
          : await submitPromptFeedback({ ...base, text: action.text });
      if (result.status === "sent") {
        setStatus(
          action.kind === "feedback" ? t("chat.status.feedbackSent") : t("chat.status.sent"),
          "success",
        );
        setFollowing(true);
        revalidator.revalidate();
        listRef.current?.scrollToBottom();
      } else if (result.status === "changed") {
        setStatus(t("chat.status.menuChanged"), "warn");
        revalidator.revalidate();
      } else {
        setStatus(result.error || t("chat.status.sendFailed"), "error");
      }
      // Reported back so the block can keep a refused feedback draft on screen rather than discard
      // what someone just thumb-typed. Option taps ignore it.
      return result.status === "sent";
    },
    [refuseWrite, paneId, scope, requestedLines, shown.revision, agent?.agent, revalidator],
  );

  // Tap a wizard control (an option digit, step navigation, or the review step's submit/cancel).
  // Same shape as handlePromptAction — the guard re-derives the wizard from a FRESH read and only
  // a clean match sends the single keystroke (incremental round-trip; grammar/WIZARD_NOTES.md).
  // gate: Claude's adapter is the only one that emits `wizard` (buildBlocks routes through the pane's
  // adapter — see harness/registry.ts), so this handler cannot fire for any other agent. omp has an
  // adapter now and still never lifts this kind; it is Tier 1 and emits raw only.
  const handleWizardAction = useCallback(
    async (keys: string[], wizard: WizardModel) => {
      const refusal = refuseWrite();
      if (refusal) {
        setStatus(refusal, "error");
        return;
      }
      const result = await submitWizardKeys({
        paneId,
        scope,
        requestedLines,
        detectedRevision: shown.revision,
        agent: agent?.agent,
        wizard,
        keys,
      });
      if (result.status === "sent") {
        setStatus(t("chat.status.sent"), "success");
        setFollowing(true);
        revalidator.revalidate();
        listRef.current?.scrollToBottom();
      } else if (result.status === "changed") {
        setStatus(t("chat.status.wizardChanged"), "warn");
        revalidator.revalidate();
      } else {
        setStatus(result.error || t("chat.status.sendFailed"), "error");
      }
    },
    [refuseWrite, paneId, scope, requestedLines, shown.revision, agent?.agent, revalidator],
  );

  // Tap a preview-dialog control (an option, the note add/edit/remove, or the wizard step nav).
  // Same guard-first shape as the two handlers above, but the choreography behind an intent is
  // MULTI-step (digit→verify→Enter; n→verify→type→Escape — see lib/preview-action.ts and
  // grammar/NOTES_NOTES.md), so the handler dispatches on the intent kind.
  // gate: Claude's adapter is the only one that emits `preview-select` — no other registered adapter
  // lifts this kind, so this handler cannot fire for another agent.
  const handlePreviewAction = useCallback(
    async (action: PreviewBlockAction, preview: PreviewSelectModel) => {
      const refusal = refuseWrite();
      if (refusal) {
        setStatus(refusal, "error");
        return;
      }
      const base = {
        paneId,
        scope,
        requestedLines,
        detectedRevision: shown.revision,
        agent: agent?.agent,
        preview,
      };
      const result =
        action.kind === "option"
          ? await submitPreviewOption({ ...base, option: action.option })
          : action.kind === "note"
            ? await submitPreviewNote({ ...base, text: action.text })
            : await submitPreviewKeys({ ...base, keys: action.keys });
      if (result.status === "sent") {
        setStatus(
          action.kind === "note"
            ? action.text
              ? t("chat.status.noteSaved")
              : t("chat.status.noteRemoved")
            : t("chat.status.sent"),
          "success",
        );
        setFollowing(true);
        revalidator.revalidate();
        listRef.current?.scrollToBottom();
      } else if (result.status === "changed") {
        setStatus(t("chat.status.dialogChanged"), "warn");
        revalidator.revalidate();
      } else {
        setStatus(result.error || t("chat.status.sendFailed"), "error");
        revalidator.revalidate();
      }
    },
    [refuseWrite, paneId, scope, requestedLines, shown.revision, agent?.agent, revalidator],
  );

  // Tap a multi-select control (toggle a checkbox, Submit, the "Chat about this" escape, or the
  // review screen's confirm/cancel). Same guard-first shape as the wizard handler — the guard
  // re-derives the dialog from a FRESH read; toggle sends one digit, Submit drives the closed-loop
  // Down→Up→verify→Enter macro (see lib/multi-select-action.ts). gate: Claude's adapter is the only
  // one that emits `multi-select`, so this handler cannot fire for another agent.
  const handleMultiSelectAction = useCallback(
    async (action: MultiSelectIntent, multi: MultiSelectModel) => {
      const refusal = refuseWrite();
      if (refusal) {
        setStatus(refusal, "error");
        return;
      }
      const result = await submitMultiSelectIntent({
        paneId,
        scope,
        requestedLines,
        detectedRevision: shown.revision,
        agent: agent?.agent,
        multi,
        intent: action,
      });
      if (result.status === "sent") {
        setStatus(t("chat.status.sent"), "success");
        setFollowing(true);
        revalidator.revalidate();
        listRef.current?.scrollToBottom();
      } else if (result.status === "changed") {
        setStatus(t("chat.status.selectionChanged"), "warn");
        revalidator.revalidate();
      } else {
        setStatus(result.error || t("chat.status.sendFailed"), "error");
      }
    },
    [refuseWrite, paneId, scope, requestedLines, shown.revision, agent?.agent, revalidator],
  );

  // Tap a generic-menu control (a footer-named key like Enter/s/Esc, or an arrow). Same guard-first
  // shape as the handlers above; the arrow taps pass `nav`, which swaps the guard's signature check
  // for an identity-only one (moving the highlight is the tap's own effect — see lib/menu-action.ts).
  // gate: Claude's adapter is the only one that emits `menu` — omp's modals deliberately stay raw
  // (harness/omp/index.ts), so this handler cannot fire for another agent.
  const handleMenuAction = useCallback(
    async (action: MenuBlockAction, menu: MenuModel) => {
      const refusal = refuseWrite();
      if (refusal) {
        setStatus(refusal, "error");
        return;
      }
      const result = await submitMenuKeys({
        paneId,
        scope,
        requestedLines,
        detectedRevision: shown.revision,
        agent: agent?.agent,
        menu,
        keys: action.keys,
        nav: action.nav,
      });
      if (result.status === "sent") {
        setStatus(t("chat.status.sent"), "success");
        setFollowing(true);
        revalidator.revalidate();
        listRef.current?.scrollToBottom();
      } else if (result.status === "changed") {
        setStatus(t("chat.status.screenChanged"), "warn");
        revalidator.revalidate();
      } else {
        setStatus(result.error || t("chat.status.sendFailed"), "error");
      }
    },
    [refuseWrite, paneId, scope, requestedLines, shown.revision, agent?.agent, revalidator],
  );

  // NOTE: the composer is deliberately NOT auto-focused on open/switch — that would pop the Android
  // keyboard and cover the output. You read the pane first, then tap the input to type. (Explicit
  // actions inside the composer still focus it; the mirror tap focuses it via composerRef.)

  // Switch to another thread from the sidebar or the swipe-up switcher (DetailRoute keys AgentChat
  // by pane, so this remounts fresh — composer resets — same as opening from home).
  function switchTo(id: string) {
    closeDrawer();
    if (id !== paneId) onSelect(id);
  }

  // Jump to another tab in this space by opening one of its panes (the in-pane tab bar).
  function goToTab(tabId: string) {
    if (!agent || tabId === agent.tabId) return;
    const target = [...agents, ...shellPanes].find((p) => p.tabId === tabId);
    if (target) switchTo(target.paneId);
  }

  // Closing the tab you are IN must not read as "leave the pane view" — it should read as closing a
  // browser tab: you stay put and land on another tab of the same space. "Neighbouring" means what
  // the strip on screen shows: TabStrip's own order, `tabs` filtered to this workspaceId (see
  // tab-strip.tsx's `wsTabs`) — not `tabs` unfiltered, which would jump you across spaces.
  //
  // Preference order is next-in-strip first, previous only when the closed tab was last (so closing
  // the middle of three lands right, closing the last lands left, matching how a browser tab bar
  // behaves). Beyond that immediate neighbour, keep walking the same directions — forward through the
  // rest, then backward through what's left before it — because a neighbouring tab can be a bare
  // empty tab with no pane to land on (goToTab silently no-ops for one), and the empty tab must not
  // strand the close. onBack() (Home) is the last resort, only when no tab in the space resolves to
  // an open pane at all.
  function closeCurrentTab(tabId: string) {
    // ── IT SAYS SO, AND THE ORBIT TURNS WITH IT ─────────────────────────────────
    // `closeTab` is classified `"echo"` in lib/ack-manifest.ts — the tab leaving the strip IS the
    // outcome, so the ✓ on the tapped control carries only the acceptance. That reasoning is right
    // for closing ANOTHER tab and wrong for this path, and the manifest's own neighbouring entry is
    // the proof: `createTab` takes `"status"` because "the app navigates to the new pane, so the
    // operator's eye has already left the control that was tapped". This function navigates too.
    // The echo is on a button inside a strip that is about to unmount, on a screen the operator is
    // about to leave — so the acknowledgement is drawn where nobody can be looking, which is the
    // same as not drawing one. The operator reported it as the orbit not turning; the orbit not
    // turning is the visible half of that.
    //
    // `setStatus` is the app's ONE definition of "worth telling the operator about" (lib/status.ts),
    // and every publish turns the mark's orbit one round. Published BEFORE the navigation, on both
    // exits, because it is the same fact either way — the tab you were in is gone and you are
    // somewhere else now. The status layer is module-scoped and outlives the route change, which is
    // the same thing routes/detail.tsx relies on when a pane closes under you.
    setStatus(t("space.tab.closed"), "info");
    if (!agent) return onBack();
    const wsTabs = tabs.filter((tab) => tab.workspaceId === agent.workspaceId);
    const closedIndex = wsTabs.findIndex((tab) => tab.tabId === tabId);
    const candidates = [...wsTabs.slice(closedIndex + 1), ...wsTabs.slice(0, closedIndex).toReversed()];
    for (const candidate of candidates) {
      const target = [...agents, ...shellPanes].find((p) => p.tabId === candidate.tabId);
      if (target) return switchTo(target.paneId);
    }
    onBack();
  }

  // Open a space from the nav hub — go to its detail route (its tabs + panes, incl. shells). A step
  // back up out of the pane, so it slides backward.
  function openSpace(workspaceId: string) {
    closeDrawer();
    navigate(spacePath(workspaceId, scope));
  }

  // Tapping the terminal mirror focuses the composer so you can start typing right away. Three bails:
  //  - the operator turned "Tap to type" off (View). It is on by default and always has been — the
  //    mirror as one big "start typing" target is the fastest path from reading to replying on a
  //    phone. But the same handler makes the mirror unable to behave like a document, which is what
  //    someone expects who is trying to interact with a LINE rather than reply to it, and they read
  //    it as the tap being absorbed. Off, the mirror keeps its buttons and its links; it just stops
  //    volunteering the keyboard. (What it still cannot offer is a tappable agent-printed hyperlink:
  //    herdr's `pane.read` strips OSC 8, so the link target never reaches Collie at all.)
  //  - the tap landed on an interactive control INSIDE the mirror — a native prompt/wizard/preview
  //    button, the Load-older button, or the note editor's own textarea. Their click bubbles up to
  //    this handler, and focusing the composer here would pop the soft keyboard on every option tap
  //    (and steal focus from the note editor). Only a tap on the raw terminal text should focus.
  //  - the user is selecting text (a long-press selection), so copy works instead of the tap
  //    collapsing the selection and popping the keyboard.
  function focusFromMirror(e: ReactMouseEvent<HTMLDivElement>) {
    if (!prefs.tapToFocus) return;
    // SAFETY: a React mouse event's `target` is the DOM node the tap landed on — an Element by
    // construction for a click inside this div. React types it as the generic `EventTarget`, which
    // has no `closest`; the optional call below still covers a target that somehow isn't one.
    const target = e.target as Element | null;
    // The `a` is what keeps a tap on an autolinked URL (components/ansi-output) from popping the
    // keyboard on top of the page it just opened. Don't trim it out of this selector.
    if (target?.closest?.("button, a, input, textarea, select, [role='textbox']")) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    composerRef.current?.focusInput();
  }

  return (
    // The pane route draws its strips WITHOUT their names. The breadcrumb two rows up already says
    // which space and tab you are in, so TABS and PANES restate it — and here, unlike anywhere else,
    // two strips stack. Measured at 390x844: 231px of chrome above the mirror, 27% of the viewport,
    // 126px of it these two rows. Unpainting both labels takes them to 47px each, the tap floor,
    // and the chrome to 199px.
    //
    // It wraps the WHOLE route, not the two strips, on purpose: a strip added to this screen later
    // cannot land outside it and end up 16px taller than its neighbours. That is the fault the old
    // per-strip `hideLabel` prop could not prevent, which is why this is a context and not a prop.
    <CompactStripLabels>
      <div className="flex min-h-0 w-full min-w-0 max-w-[100dvw] flex-1 flex-col overflow-x-hidden">
        {/* Header — this route's contribution to the ONE header shell, which is mounted above the
            outlet in RootLayout and is the same element on every screen (so the Collie mark is not
            only identical, it is literally the same drawing, still turning). The pane's own bits are
            portalled into it: the `space › tab` breadcrumb as the center, the ⋮ as the right-cluster
            lead, and the find bar as the full-row takeover while searching. No `width`: the pane is
            the edge-to-edge one, which is this component's default. */}
        <RouteHeader
          onHome={onBack}
          // Zen takes the whole row off the screen — the one shell owns the <header> element, so
          // only the shell can stop drawing it, and this is how a route asks. See HeaderClaim.hidden
          // for what survives (the element, its safe-area inset, its reserved rule) and why.
          hidden={zen}
          override={
            findOpen ? (
              <FindBar
                query={findQuery}
                onQueryChange={setFindQuery}
                count={matchCount}
                current={currentMatch}
                onPrev={() => gotoMatch(-1)}
                onNext={() => gotoMatch(1)}
                onClose={closeFind}
              />
            ) : undefined
          }
          // Right cluster: ONE control. Find and History used to sit here as two 32px icons; they
          // are now the first two rows of the pane's own actions sheet, which a ⋮ opens. The
          // operator's ask was to unclutter the row, and the sheet already existed — the pane pill
          // has opened it (rename / show in terminal / close) since it was written, so this is a
          // second door onto the same menu rather than a new one. It is also the only door when the
          // tab holds a single pane: PaneStrip renders nothing below two, so on most panes rename
          // and close had no reachable entry point at all.
          //
          // A ⋮ and not a labelled button: at this width a word costs more than the two icons it
          // replaced, and ⋮ is the one glyph a phone user reads as "the rest of this thing's
          // actions" without being taught. Its accessible name says what it opens, because the glyph
          // itself names nothing.
          //
          // WHAT THIS COSTS, stated rather than buried: two visible actions become zero. Find in
          // particular is a repeat action — you search, read, search again — and every one of those
          // now costs a tap, a sheet animation and a second tap. That is the trade the ask makes;
          // the sheet's read rows lead the list so the second tap is the shortest one available.
          //
          // The status pill is deliberately not in here either: it was the widest fixed item in the
          // row (the Spanish "desconocido" chip measures 111px and left the pane name 24px at 390px), and it was
          // sitting in the row's action neighbourhood while being the one thing here that is not an
          // action. It moved into the identity block, where the state belongs to the pane it
          // describes — the dot badged onto the agent's own tile. The WORD that rides with it has
          // since moved on again, down to the composer's status strip beside the host, and the dot
          // stayed: DESIGN.md's reason for having both is unchanged, only where the word stands.
          // The budget rule this holds to: one Leave (the Collie mark) + one flexible Identity, which
          // carries the state + at most two Actions. The Identity is the only flexible element; when
          // the row would squeeze it below a recognisable handle, the newest FIXED element leaves —
          // never the Identity. The cluster now spends one Action slot, not two.
          //
          // Find stays anchored to THIS screen — the bar it opens takes over this very header row
          // (see `override` above), so the trigger and its surface are still in the same place even
          // with a sheet between them. Offered only when there's buffered output to search; opening
          // it freezes the tail. History opens the agent's own transcript, the only real conversation
          // history a Claude pane has: its terminal runs on the alternate screen, so the mirror below
          // can never show more than the visible viewport. Offered only when the pane reported an
          // agent session id, so the row never leads to an empty screen. Both gates are now `undefined`
          // callbacks rather than unrendered buttons; the sheet hides a row it was given no callback for.
          rightLead={
            agent ? (
              <button
                type="button"
                onClick={() => setDrawer("paneMenu")}
                aria-label={t("chat.paneMenu.aria")}
                // A real 44px box, stated, for the same reason SettingsGear states one and with no
                // negative margin for the same reason: the two icons this replaces were size-8 with
                // `-mr-1`, i.e. 32px drawn and 28px of unshared hit area at the very edge of the row.
                // One control can afford the floor.
                className="grid size-11 place-items-center rounded-lg text-muted-foreground transition-colors active:bg-muted/60"
              >
                <EllipsisVertical className="size-5" />
              </button>
            ) : undefined
          }
        >
          {/* Title block: the agent's brand logo and the space › tab share line 1 (the agent name
              would just repeat the icon, so it's dropped), and the working directory has line 2 to
              itself. Tapping it leaves the pane for the space overview (all its tabs + panes). */}
          {agent ? (
            <button
              type="button"
              onClick={() => openSpace(agent.workspaceId)}
              // The block's TEXT does not reach a screen reader — an aria-label on a button replaces
              // everything inside it — so the state has to be spelled into the label itself, or moving
              // the status word in here would have taken the pane's status out of the accessibility
              // tree entirely. The suffix is a locale string, not a "," glued on in code, because
              // where the punctuation goes is a translator's decision (host-chip.tsx does the same
              // with its unreachable suffix).
              aria-label={t("chat.header.openOverviewAria", {
                workspace: agent.workspaceLabel,
                status: t("chat.header.statusAria", {
                  label: isShell ? t("status.shellBadge") : statusLabel(agent.status),
                }),
              })}
              // The three-line block's geometry is a rule that spans two files — this one states the
              // line boxes, app-header.tsx states the row floor and the padding that has to hold them —
              // so it is asserted mechanically in agent-chat.test.tsx. These slots are what that test
              // reads; renaming one without updating it fails there rather than on a phone.
              data-slot="pane-identity"
              // A REAL 44px hit box, stated. This button is the only way off the pane to the space
              // overview and it measured 39px — under the floor, in the row that states the floor for
              // everything else. `min-h-11` is 44px and it is now what DRAWS this button: with the
              // caption line gone the block is 36px of lines (name 20 + gap 4 + cwd 12), or 20px with
              // no cwd, so the floor catches every case rather than only the short one. No vertical
              // padding on top of it, for the reason it never had any: lines plus padding must stay
              // inside the row's 52px content box or the header grows on the pane route alone — the
              // route-local growth `min-h-15` exists to prevent.
              className="-mx-1 flex min-h-11 min-w-0 flex-1 items-center rounded-lg px-1 text-left transition-colors active:bg-muted/60"
            >
              {/* TWO lines with 4px between them — see the row's own note in app-header.tsx for why
                  the air moved from outside the block to inside it. Each line states its own height
                  (20 / 12) so the block is a sum of boxes: as bare inline spans they inherit the
                  body's 1.45 strut and the block silently becomes taller than the row was measured
                  for.

                  THE CAPTION LINE IS GONE, and the word it held is not. Line 1 carried the status
                  word alone once the host left for the composer, so the top of the pane spent a
                  whole line of a 60px row on one word — the operator asked for that top back. The
                  word DID NOT get deleted with the line: simulated on the app's own `--status-*`
                  tokens, a deuteranope reads blocked / working / done as ONE colour in light theme
                  and "needs you" against "done" collapses in BOTH, so a dot alone cannot carry this
                  range and deleting the word would have re-opened that failure (status-badge.tsx
                  states the measurement). It moved DOWN, onto the composer's status strip beside the
                  host, where "which machine, and what is it doing" reads as one sentence at the
                  surface you are typing into. The dot badged onto the agent's tile above STAYS — it
                  is the anchor that welds the state to its subject, and its ring is what separates
                  it from the Claude tile's own orange.

                  The row does not shrink for the missing line: `min-h-15` is a FLOOR (app-header.tsx),
                  36px of lines centred in it still measures 60px, and that floor is shared by every
                  route and must not be lowered to fit this one. */}
              <div data-slot="pane-lines" className="flex min-w-0 flex-1 flex-col gap-1">
                {/* Line 1: the agent's own mark, then the name. The mark used to stand OUTSIDE this
                    column, centred against both lines, which spent the block's entire left edge on it
                    and pushed the path in under the name with nothing above it. On line 1 it reads as
                    what it is — a mark ON the name, the way a favicon sits on a title — and line 2
                    reclaims the full width of the block for the path.

                    16px, not the 24px it was. Beside 16px semibold text, inside a 20px line box, and
                    in a row that also holds the 32px Collie mark: the pane's subject may be the thing
                    the eye lands on and may not be the heaviest mark in the header.

                    The subject carries the state BADGED onto its corner — `agent-card.tsx`'s pattern,
                    not a new one. In dark theme the Claude tile's orange (oklch 0.672 0.131 39) and
                    --status-blocked (0.700 0.200 24) are 0.028 apart in lightness and 15° in hue: as
                    two loose marks on one line they are one colour, and "blocked" — the state that
                    most needs to be seen — would disappear into the subject glyph. The ring separates
                    them physically instead of by tuning colours. The dot drops to 8px with the tile,
                    so the badge stays a badge instead of swallowing the mark it sits on.

                    The line states its own 20px height either way (`items-center` over a 16px mark in
                    a 20px line box), so the block is still 20 + 4 + 12 and the header row's floor is
                    untouched — DESIGN.md §2. A user-set pane label leads when present (the identifier
                    they chose), then Claude's own /rename session name, otherwise the default
                    space › tab. */}
                <div className="flex min-w-0 items-center gap-2 leading-5">
                  <div className="relative shrink-0">
                    {isShell ? (
                      <div className="flex size-4 items-center justify-center rounded-sm border bg-muted">
                        <TerminalSquare className="size-2.5 text-muted-foreground" />
                      </div>
                    ) : (
                      <AgentIcon agent={agent.agent} className="size-4" />
                    )}
                    {/* A shell pane has no agent status, so it gets no badge — the tile alone says
                        what it is, and the composer strip's "shell" says it in words. The dot IS
                        named here, unlike every other StatusDot in the app: it is the only one that
                        stands alone rather than leading a word, so unnamed it would be an empty span
                        that names nothing and matches no text query. In focus mode the button's own
                        aria-label is what a screen reader reads (a label replaces the content beneath
                        it) and that label already carries the status; this name is what answers a
                        browse-mode read of the glyph itself, and the fallback if that label ever
                        loses its suffix. */}
                    {!isShell && (
                      <StatusDot
                        status={agent.status}
                        label={statusLabel(agent.status)}
                        stale={connecting}
                        surface="bg-background"
                        className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-background"
                      />
                    )}
                  </div>
                  <span data-slot="pane-name" className="block truncate font-semibold leading-5">
                    {paneName}
                  </span>
                  {/* The pane's own short id, when line 1 fell back to naming the TAB and the tab
                      holds more than one pane — see `discriminator` above for why the name moves and
                      the dot does not.

                      A SEPARATE SPAN, never joined into `paneName`, for `lib/pane-name.ts`'s reason
                      one level down: a tail-truncated join eats its own tail first, so at 390px the
                      one part that discriminates would be the first part to go and the header would
                      truncate to the run every sibling shares. `shrink-0` states it — the name gives
                      up width, the suffix survives, which is the whole point of showing it.

                      The pill row below prints this same suffix in this same face (`font-mono
                      text-[10px]`, lib/pane-tag.ts), so the eye matches header to pill without being
                      told. Not the pill's `/60` alpha though: that is calibrated against the pill's
                      own `bg-muted` fill, and here the suffix sits 4px above a `text-muted-foreground`
                      cwd line on the page ground, where two alphas of one grey read as a rendering
                      fault rather than as a hierarchy.

                      `leading-5` is stated, not inherited, for the reason every other line box here
                      states its own: the block is a SUM of boxes (20 + 4 + 12) that app-header.tsx's
                      row floor is sized against, and a span that falls back to the body's 1.45 strut
                      grows line 1 past 20px and the header row with it — on the pane route alone.

                      It is not in the button's aria-label, and that is not an omission: the label
                      names what the button DOES ("Open webapp overview — needs you"), not what the
                      pane is called, and a suffix that exists to be matched against pills two rows
                      down has nothing to say to a reader who is hearing the row rather than seeing
                      it. */}
                  {discriminator !== null && (
                    <span
                      data-slot="pane-tag"
                      className="shrink-0 font-mono text-[10px] leading-5 text-muted-foreground"
                    >
                      {discriminator}
                    </span>
                  )}
                </div>
                {/* Line 2, conditional: the path, but only when it names a segment line 1 does not
                    already show — see cwdBeyondName. Gated against the RENDERED NAME rather than
                    against the project, because a hand-set label ("logs") puts no directory on line 1
                    at all and the path is then the only thing locating the work. */}
                {cwd !== null && (
                  <span
                    data-slot="pane-cwd"
                    className="block truncate font-mono text-[11px] leading-3 text-muted-foreground"
                  >
                    {cwd}
                  </span>
                )}
              </div>
            </button>
          ) : (
            <div className="min-w-0 flex-1">
              <span className="truncate font-semibold">{t("chat.header.agentGone")}</span>
            </div>
          )}
        </RouteHeader>

        {/* Content region below the header — the mirror inside is the scroller. `relative` is load-
            bearing and stays: <ToastViewport dock="top"> below is `absolute`, so THIS element is the
            positioned ancestor it resolves against. That is also how the toast lands below the sticky
            header — by geometry, because it sits in the region the header ends at, rather than by
            anyone measuring the header's height and keeping the number in sync. */}
        <div
          className={cn(
            "relative flex min-h-0 min-w-0 flex-1 flex-col",
            // The composer carried the bottom inset, and in zen the composer is gone — so this
            // region takes it over, or the mirror's last row runs under the home indicator. The TOP
            // inset is deliberately NOT taken: the header element stays mounted with its own
            // `env(safe-area-inset-top)` even while its row is collapsed away, so claiming it here
            // would pay for the notch twice.
            zen && "[padding-bottom:env(safe-area-inset-bottom)]",
          )}
        >
          {/* THE ONE WAY OUT OF ZEN. A single floating affordance over the mirror rather than a
              strip, so "everything hides" stays literally true, and TOP-right so entering (the ⋮ that
              opened the sheet) and leaving happen in the same corner — opposite corners would make
              you re-aim on every toggle.

              A plain conditional and NOT `Collapse`, which is not a contradiction of DESIGN.md §1:
              that rule governs a surface IN FLOW, whose arrival pushes its neighbours around. This
              one is `absolute`, holds no space, and moves nothing — §2 has nothing to say about it
              either. It is the first child of this region so it leads the tab order, which matters
              because it is the only structural control left in zen, and it is anchored to the region
              rather than to the mirror because the mirror's top neighbour renders nothing when idle:
              anchored there, the one way out would slide down by the height of a toast and back up
              again 2.5s later.

              `size-11` is 44px, drawn — the tap floor as a real box (DESIGN.md §6), because this is
              the last control in the app that should be under-sized. `bg-chrome` and not a
              translucent page colour: in dark `--background` IS the mirror's own fill
              (mirror-space.ts), so a control painted in it would have no ground at all (DESIGN.md
              §4). Full-round is allowed here because the box is square, which is what §3 reserves it
              for. */}
          {zen && (
            <button
              type="button"
              onClick={() => setZen(false)}
              aria-label={t("chat.zen.exitAria")}
              className="absolute right-3 top-3 z-20 grid size-11 place-items-center rounded-full border border-rule bg-chrome text-muted-foreground transition-colors active:bg-muted/60"
            >
              <Minimize2 className="size-5" />
            </button>
          )}

          {/* The status line — "Sent", "wrap changed", a send error. An EVENT in DESIGN.md §11's
              sense: it passes on its own, so it FLOATS and never holds space. It was an ordinary row
              in this column once, and that is the whole argument — every "Sent" pushed the tab strip,
              the pane strip and the mirror down ~30px and pulled them back up 2.5s later, so the page
              jumped twice to say one word.

              `dock="top"`, and this is the screen that makes the choice. The other two routes float
              their toasts at the bottom; here the bottom is the composer, and covering the control
              you just pressed to make the toast appear is the worst square on the page. The top of
              this region is the tab strip and the pane strip — chrome nobody reads while waiting on a
              send, and the cheapest real estate here. Floating it over the TERMINAL TAIL instead (the
              newest output, the reason the screen is open) was tried on this very screen and
              reverted; that is the experiment ToastViewport's own doc cites, and everything else —
              the z-40 rung, the pointer-events split StatusArea completes, why absolute and not fixed
              — is stated there once and deliberately not repeated here.

              No wrapper of ours and no className: ToastViewport states the gutter and the top inset
              itself, and a second set here would add to them rather than replace them. */}
          {/* `dock={zen ? "bottom" : "top"}`, and the switch is this route's own argument read back.
              Top is chosen HERE because the bottom of this screen is the composer and covering the
              control you just pressed is the worst square on the page. In zen there is no composer,
              and the top-right corner is where the one way out stands — so the reason for top is
              gone and the reason against it has arrived. StatusArea stays MOUNTED either way: it
              renders nothing when idle, and it is the only surface a prompt-tap failure ("menu
              changed", a read-only refusal) has. Hiding it would silently eat errors. */}
          <ToastViewport dock={zen ? "bottom" : "top"}>
            <StatusArea />
          </ToastViewport>

          {/* THE CHROME ABOVE THE MIRROR, AS ONE ROW THAT LEAVES. In zen these four surfaces go
              together — they are Collie talking about the pane, not the pane's own output — and they
              go through `Collapse`, DESIGN.md §1's only sanctioned way an in-flow surface arrives or
              leaves. One wrapper and not four: they leave in the same gesture, so four independent
              240ms slides would be four separate movements where the operator asked for one. The
              banners keep their OWN presence animations inside it; nesting is what `Collapse` is
              for, and a banner that appears while zen is on simply appears inside a closed box.
              `Collapse` unmounts at the end of the exit, so every pill in both strips leaves the tab
              order with the pixels. */}
          <Collapse open={!zen}>
            {/* Read-only notice when this device isn't allowlisted (the composer below is disabled too). */}
            <ReadOnlyBanner device={device} />

            {/* The pane's MACHINE is not answering the lead — the mirror below is last-good and the
                composer is locked. Its tier-1 twin (the app-wide ConnectionBanner) lives up in
                RootLayout; this one is scoped to the pane because the phone's link is fine. Renders
                nothing on a solo install, or while the host is live. */}
            <HostStaleBanner health={hostHealth} className="mx-3 mt-1.5" />

            {/* THE TWO STRIPS, AND THE THIN BAR THAT STANDS IN FOR THEM — one band that morphs, not
                two rows taking turns. `CollapseSwap` is nested inside zen's `Collapse`, so zen still
                takes the whole band folded or not: the bar is chrome about the pane exactly as the
                rows are. Whichever surface is not on screen is unmounted, so a folded screen has no
                tab in the tab order and an unfolded one has no bar in it.

                It was two sibling `Collapse`s on opposite gates, which is the obvious spelling and
                the wrong one — the leaving bar was pushed the height of the band downward by the
                arriving rows. CollapseSwap's own header carries that measurement; do not unpick it
                back into siblings.

                Rendered at all only when a row would have drawn: `stripsExist`. Nothing to fold is
                not a folded thing. */}
            {stripsExist && (
              <CollapseSwap
                open={!folded}
                // The BAND, not two rows that happen to take turns in it — see CollapseSwap for what
                // the two-sibling spelling did to the expand gesture. The bar is the stand-in: it is
                // the shorter surface, so it holds the band's floor while the rows grow out of it.
                standIn={
                  agent && (
                    <StripsSummary
                      workspaceId={agent.workspaceId}
                      tabs={tabs}
                      agents={agents}
                      host={agent.host}
                      selectedTabId={agent.tabId}
                      // The SAME list PaneStrip draws, so the bead group and the pill row can never
                      // disagree about how many panes there are or which one is open.
                      panes={tabPanes}
                      currentPaneId={paneId}
                      onExpand={toggleStrips}
                    />
                  )
                }
              >
                {/* `pb-1` — the 4px of page the open folder tab sits on, which lives HERE rather than
                    on the mirror so that it leaves with the tabs. See `mirrorGap` above. */}
                <div className="pb-1">
                {/* In-pane tab bar: the current space's tabs above the mirror — switch tab without
                    leaving the pane, or create one with +. No "All" here (you're always in a
                    specific tab). */}
                {agent && (
                  <TabStrip
                    workspaceId={agent.workspaceId}
                    host={agent.host}
                    tabs={tabs}
                    agents={agents}
                    selected={agent.tabId}
                    onSelect={(id) => id && goToTab(id)}
                    onNewTab={newTab}
                    allowAll={false}
                    scope={scope}
                    readOnly={readOnly}
                    onRenamed={() => revalidator.revalidate()}
                    // Closing the tab this pane lives in must not eject you to Home — see closeCurrentTab:
                    // it lands you on a neighbouring tab of this space, and only falls back to onBack() when
                    // the space has nothing left to land on. Closing any other tab just revalidates so it
                    // drops out of the strip.
                    onClosed={(tabId) => (agent?.tabId === tabId ? closeCurrentTab(tabId) : revalidator.revalidate())}
                    // The fold's own control, pinned to the row's trailing end where it costs no height
                    // — the tab row is already 44px, so this centres in pixels the row was spending
                    // anyway. Same 32px square recipe as the "+" beside it: they are two controls of the
                    // same rank in the same row, and drawing them differently would rank them.
                    trailing={
                      <button
                        type="button"
                        onClick={toggleStrips}
                        aria-expanded={true}
                        aria-label={t(foldLabelKey(stripTabs.length, tabPanes.length))}
                        className={cn(
                          STRIP_TAP_TARGET_SQUARE,
                          "flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent active:scale-95",
                        )}
                      >
                        <ChevronUp className="size-4" />
                      </button>
                    }
                  />
                )}

                {/* Pane switcher: the panes that share this tab (space › tab › pane). Mobile shows them as a
                    tabbed row rather than tiling the panes; only appears when the tab holds more than one. */}
                {agent && (
                  <PaneStrip
                    // The SAME list the header's discriminator is gated on, and hoisted for that reason —
                    // this row appearing and line 1 gaining a `pN` are one decision, taken once.
                    panes={tabPanes}
                    currentPaneId={paneId}
                    onSelect={switchTo}
                    scope={scope}
                    readOnly={readOnly}
                    onRenamed={() => revalidator.revalidate()}
                    // Mirror closePane's success branch: closing the open pane returns Home, else revalidate.
                    onClosed={(id) => (id === paneId ? onBack() : revalidator.revalidate())}
                  />
                )}
                </div>
              </CollapseSwap>
            )}
          </Collapse>

          {/* Terminal mirror — tapping it focuses the composer so you can start typing right away
              (unless you're selecting text to copy, which the tap must not collapse). */}
          {/* min-w-0 only — do NOT set overflow-x-hidden here: that forces overflow-y to `auto` (CSS
              quirk) and makes this wrapper a second vertical scroller competing with ChatMessageList. */}
          {/* THE MIRROR'S OWN TOP EDGE, and the PAGE the folder tab opens onto — `mt-1
              border-t border-rule`, one set, do not separate them.

              ── WHY THIS IS 4px AND NOT 0, WHICH IS WHAT WAS ASKED FOR ──────────────────
              The operator wanted the tab row denser and chose this gap over shrinking the tab, which
              was the right call: the tab is `h-11` and that 44px IS the tap target, so every pixel
              off the tab is a pixel off the thumb. This gap costs no target at all. But it cannot go
              to ZERO, and the reason is measured and sits three paragraphs below: the active tab's
              fill and the terminal's ground are byte-identical under BOTH themes, on purpose, so
              with no page between them the open tab has no floor and bleeds into the mirror. Closed
              flush, the baseline rule and the mirror's top rule also land adjacent and read as one
              doubled 2px hairline, which DESIGN.md §4 forbids by name.
              4px keeps both properties — the tab still opens onto page, and the two rules still read
              as two boundaries — and returns half the gap. It is the whole saving available above
              the tap floor on this row; the row itself is 45px and 44 of that is the target.

              The tab above is deliberately open at its bottom edge: that is what makes it a tab and
              not a pill, and a tab opening downward promises continuity with the surface beneath it.
              Beneath it here is the terminal mirror, which is a FOREIGN surface — a fixed ANSI
              palette the light theme inverts wholesale (components/mirror-space.ts). Worse, the two
              grounds are byte-identical on purpose: `--background` is oklch(0.145) = #0a0a0a in dark,
              which is MIRROR_SPACE's own fill, and oklch(0.97) = rgb(245) in light, which is exactly
              what that fill inverts to (index.css:44-48 says so, and closing the mirror's seam
              against the page is why the value was chosen). So the active tab's `bg-background` fill
              and the terminal ground were literally the same colour, under both themes: the tab had
              no floor and read as bleeding into the terminal.

              The fix is not a second rule at the tab's baseline. That was tried and is wrong twice
              over: the baseline already carries one, and the active tab covers it for its own width
              with a 1px cover strip, so a rule drawn flush from below is a pixel the tab cannot
              reach and shows through under the open tab. The fix is to give the tab something of its
              own to sit on. `mt-1` is 4px of PAGE below the baseline — the tab now opens onto the
              page, which is what a folder tab's open edge promises — and `border-t` is then the
              mirror's own top edge, clear of the baseline, so the two lines read as two
              boundaries and never as one doubled hairline. (It was 8px; see the header for why it
              is now 4 and why it may not be 0.)

              It costs nothing. `ChatMessageList` below dropped the matching 12px of scroller
              `pt` in the same edit: the padding was invisible (page colour on page colour when at
              the top of the buffer, and gone entirely the moment the mirror follows the tail, which
              is nearly always), so 12px of nothing became 9px of an actual boundary — the stack
              above the first terminal glyph got 3px SHORTER. A terminal draws to its own edges;
              flush against its top rule is the honest rendering, and the bottom keeps its `pb-3`
              because the tail wants clearance from the composer.

              THE RULE IS UNCONDITIONAL. THE GAP IS NOT, AND THE SPLIT IS THE WHOLE POINT.
              `border-t border-rule` is drawn in every state, always, at the same weight: it is the
              mirror's own top edge and the one seam between chrome and output, so there is no state
              in which that boundary is drawn differently (DESIGN.md §2). Whether PaneStrip renders,
              whether the strips are folded, whether zen took the band entirely — the line is there.
              What moves is the 4px above it (`mirrorGap`, stated where `folded` is), because that
              4px was never the mirror's: it is the page an open FOLDER TAB sits on, and it exists
              only while a folder tab does. Folded, the tab row is gone and the bead bar that stands
              in for it is not attached to anything, so the page it would sit on is dead space — the
              operator read it as such. Nothing about the seam changes; only who is standing on it. */}
          {/* `role="presentation"` because that is what this element is: a layout wrapper with no
              semantics of its own. Its click handler adds nothing a keyboard user needs — focusing the
              composer is what a keyboard user already has (the textarea is the next tabbable thing),
              and `focusFromMirror` deliberately declines a tap that landed on a control or a text
              selection. It is a touch convenience layered over an already-reachable action. */}
          <div
            role="presentation"
            className={cn(
              mirrorGap,
              "min-h-0 min-w-0 flex-1 border-t border-rule",
              mirrorFace.className,
            )}
            style={mirrorFace.style}
            onClick={focusFromMirror}
          >
            <ChatMessageList
              ref={listRef}
              dep={display}
              onAtBottomChange={setFollowing}
              hasNew={hasNew}
              // `pt-0`, stated and not merely omitted — ChatMessageList's own base is `px-3 py-4`,
              // so dropping the `pt` from this override would let 16px BACK in, not 0. The 12px this
              // row used to carry paid for the mirror's new top rule above; it was never visible
              // anyway (page colour on page colour at the top of the buffer, and scrolled away the
              // moment the mirror follows the tail). `pb-3` stays: the tail wants clearance from the
              // composer.
              className="px-2 pt-0 pb-3"
            >
              {display ? (
                <>
                  {/* Top-of-buffer affordance, reached by scrolling up. WHICH button appears is decided
                      by what the pane can actually offer, because the two are never both possible:

                        • an agent pane with a transcript → "Show entire history". Its terminal runs on
                          the alternate screen, which keeps no scrollback ring, so the mirror can never
                          show more than the viewport — the agent's own session log is the only history
                          that exists (see bridge/transcript.ts).
                        • a pane with real scrollback (a shell, on the primary screen) → "Load older",
                          which grows the requested window.
                        • neither → nothing.

                      This used to be gated on `truncated`, which Herdr never sets true — so the button
                      rendered on no pane at all. `readableLines` (scrollback depth + viewport) is the
                      signal that actually works. */}
                  {historyAvailable ? (
                    <button
                      type="button"
                      onClick={() => navigate(historyPath(paneId, scope))}
                      className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-xs font-medium text-muted-foreground transition-colors active:bg-muted/50"
                    >
                      <ScrollText className="size-3.5" />
                      {t("chat.scrollback.showHistory")}
                    </button>
                  ) : moreScrollback ? (
                    <button
                      type="button"
                      onClick={loadOlder}
                      disabled={loadingOlder}
                      className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-xs font-medium text-muted-foreground transition-colors active:bg-muted/50 disabled:opacity-60"
                    >
                      {loadingOlder ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <ArrowUpToLine className="size-3.5" />
                      )}
                      {loadingOlder ? t("chat.scrollback.loading") : t("chat.scrollback.loadOlder")}
                    </button>
                  ) : null}
                  {/* EXPLAIN, don't hide (M10/06): on a multiplexer that keeps no agent session log,
                      "Show entire history" is not merely unavailable — it can never appear, and a
                      button that is simply absent reads as a bug. One muted line, in the ADAPTER's
                      own words (it names the multiplexer; Collie is not at fault and does not say it
                      is), at the exact place the missing button would have been.

                      It renders under "Load older" rather than instead of it: screen scrollback and
                      an agent's transcript are different capabilities, and a multiplexer can perfectly
                      well have the first while lacking the second. Nothing renders on Herdr, which
                      declares the capability — this whole branch is dead code there. */}
                  {!sessionLog.capable && sessionLog.note !== "" && (
                    <p className="mb-2 px-2 py-1 text-center text-xs leading-snug text-muted-foreground">
                      {sessionLog.note}
                    </p>
                  )}
                  {/* The same rule one level down, per PANE rather than per multiplexer (#137): this
                      agent CAN keep a session log, and this pane reported none. A muted line and not
                      a control — there is nothing here to open, and a button that fetched nothing
                      would be the worse answer. The remedy is the operator's own, on the machine the
                      agent runs on, so the sentence names it and stops. */}
                  {noSessionReported && (
                    <p className="mb-2 px-2 py-1 text-center text-xs leading-snug text-muted-foreground">
                      {t("chat.scrollback.noSessionReported", { agent: agent?.agent ?? "" })}
                    </p>
                  )}
                  <AnsiOutput
                    text={display}
                    wrap={prefs.wrap}
                    fontSize={prefs.fontSize}
                    query={findOpen ? findQuery : ""}
                    currentMatch={findOpen ? currentMatch : -1}
                    onMatchCount={findOpen ? handleMatchCount : undefined}
                    agent={grammarsOn ? agent?.agent : undefined}
                    onPromptAction={handlePromptAction}
                    onWizardAction={handleWizardAction}
                    onPreviewAction={handlePreviewAction}
                    onMultiSelectAction={handleMultiSelectAction}
                    onMenuAction={handleMenuAction}
                    promptDisabled={readOnly || gone}
                  />
                </>
              ) : (
                <div className="py-16 text-center text-sm text-muted-foreground">
                  {t("chat.output.empty")}
                </div>
              )}
            </ChatMessageList>
          </div>

          {/* Bottom region, in the order it paints: the agent's own statusline (the mirror's last row),
              the pane-switch handle, the composer. The connection status line USED to float here as an
              overlay just above the composer, but it covered the terminal tail (the prompt/cursor and
              up-levelled prompt buttons) — it now lives as a slim row just below the header.

              ── `shrink-0`, STATED, AND WHY IT IS NOT `min-h-0` ──────────────────────────
              This is the flex sibling of the mirror inside a `h-[100dvh]` column. The mirror above
              carries `min-h-0 flex-1`, so IT is the row that gives — and it gives all the way to
              zero. What happens after that is what the operator reported as "the bottom is cut off":
              nothing else in this column can shrink, so the surplus paints past the bottom edge of
              the viewport, under the soft keyboard, and the send button becomes unreachable.

              `min-h-0` here would be the wrong repair. It would let this region shrink too — and
              since nothing inside it scrolls, it would clip the composer from the bottom instead of
              overflowing it, which is the same loss with a tidier edge. The region must keep its
              size; the fix is that its size must be BOUNDED. So every part of it that can grow is
              capped as a fraction of the viewport rather than at a constant: the agent statusline
              just below, and the draft field (`ui/chat/chat-input.tsx`, `min(10rem,30dvh)`). `dvh`
              already tracks the keyboard — the viewport meta is `interactive-widget=resizes-content`
              (hooks/use-keyboard.ts) — so the bound follows the real device instead of encoding one
              phone's pixels. `shrink-0` is what makes that bound the whole story. */}
          {/* …AND THE CHROME BELOW IT, the same way. The whole bottom region is ONE row of this
              column — the statusline, the grab handle, the status band and the composer are its
              parts, not its siblings — so zen takes it out as one row, through `Collapse`. Wrapping
              the region rather than each part is what keeps the parts' own relationships intact: the
              statusline is still the row immediately before the chrome block, and the handle is
              still the last thing before the composer, in zen and out of it. Tests read the ROW
              rather than the element for exactly this reason (agent-chat.test.tsx says so at the
              docking test). */}
          <Collapse open={!zen}>
            <div className="relative shrink-0">

              {/* The agent's statusline, re-surfaced as app chrome (its branch/model/ctx/permission mode
                  would otherwise vanish with the stripped input box). It is the LAST ROW OF THE MIRROR,
                  so it is welded to the mirror's bottom edge and nothing may come between the two — it
                  was cut from the pane tail and it reads as the bottom of the screen it was cut from,
                  exactly as it did in the TUI. Verbatim text — React text nodes, so no XSS surface.

                  STACKED, one row per line, each truncated — deliberately, over the two alternatives:
                  joining the rows with a separator would put ~150 chars on a strip that fits ~55 at this
                  size on a phone, truncating away exactly the fields (branch, permission mode) this
                  exists to surface; wrapping makes the strip's height depend on the pane width and turns
                  a column-aligned statusline into ragged prose. Stacking also preserves the shape the
                  user themselves configured in the TUI, so it reads as the same thing they know.
                  THE UPSTREAM CAP IS A ROW COUNT, AND A ROW COUNT IS NOT A HEIGHT. `MAX_STATUS_LINES`
                  bounds what stripChrome will claim (8), which was read here as "bounded, nothing more
                  to do" — and that held only while the viewport was tall. With the soft keyboard up the
                  page is ~440px on a phone, so eight rows of `CTX:44% CACHE:100% LIMITS…` is a quarter
                  of everything on screen, held against a mirror that is already showing zero rows of
                  what the agent actually SAID. So there is a second cap now, and it is a fraction of
                  the viewport rather than a number of pixels: `max-h-[18dvh]`, which `dvh` keeps
                  honest on every device and through the keyboard. `overflow-y-auto` rather than
                  `overflow-hidden` so a row past the cap is scrolled to, never destroyed — this strip
                  carries the permission mode, and silently eating that row is worse than any height. */}
              {/* Stands down while the keyboard is up (see `composing` above): this is the largest block
                  below the mirror and the one whose absence costs the least mid-sentence. Through
                  `Collapse`, which DESIGN.md §1 names as the only sanctioned way an in-flow surface
                  arrives or leaves — a bare conditional here is the §2 fault at its full height, the
                  mirror teleporting 50px twice per message. `Collapse` also UNMOUNTS at the end of the
                  exit, so nothing is left focusable behind a row that is not on screen. */}
              <Collapse open={!composing && statusLines.length > 0}>
                {statusLines.length > 0 && (
                <div
                  className={cn(
                    "max-h-[18dvh] overflow-y-auto border-t border-border/40 px-3 py-1 font-mono text-[11px] leading-tight",
                    // The strip carries the agent's OWN terminal colour, so it renders in the mirror's
                    // dark space and inverts in light with it (ADR 0002) — a bright statusline colour is
                    // chosen against a near-black background and is illegible re-themed onto app chrome.
                    // It also makes the strip read as the bottom of the pane it was cut from, which is
                    // where the TUI drew it.
                    MIRROR_SPACE,
                    MIRROR_INVERT,
                    mirrorFace.className,
                  )}
                  style={mirrorFace.style}
                >
                  {statusLines.map((row, i) => (
                    // Index key: these rows are a positional snapshot of the pane tail, re-derived on
                    // every poll — there is no identity to preserve across renders.
                    <div key={i} className="truncate">
                      {row.segments.map((s, si) => (
                        // Text nodes only — colour and weight come from the ANSI parse, never markup.
                        // Same XSS boundary as the mirror.
                        <span key={si} style={styleFor(s)}>
                          {s.text}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
                )}
              </Collapse>

              {/* Swipe-up / tap handle for the quick pane switcher — the sheet that switches AND closes
                  panes (each row has a ✕). A tall, full-width hit area so the swipe is easy to land (and a
                  tap always works). Shown whenever a pane is open — even the last one, so it stays
                  closable now that the nav drawer is gone. `touch-none` so the gesture is ours, not a
                  browser scroll.

                  IT SITS DIRECTLY ABOVE THE COMPOSER, BELOW THE AGENT'S STATUSLINE, AND THAT ORDER IS
                  THE FIX RATHER THAN A PREFERENCE. It used to render ABOVE the statusline, which made
                  its position a function of pane state: on a pane whose agent prints a statusline the
                  handle stood 50px further up than on one that does not, and the same handle moved
                  again the moment the agent added or dropped a row (the strip is 1–3 rows, re-derived
                  every poll). A control the thumb reaches for by muscle memory may not move because the
                  terminal printed something — DESIGN.md §2. Rendered here it is always the last thing
                  above the composer's status band, on every pane and in every state.

                  It also puts the statusline back where it belongs: that strip is the mirror's own last
                  row, cut from the pane tail, and a 34px gap with a grab handle in it read as a seam
                  between the terminal and a piece of chrome that IS the terminal. */}
              {/* THE CHROME BLOCK, DRAWN ONCE. Everything the thumb operates — the grab handle, the
                  status band, the controls, the input — stands on ONE surface, closed against the
                  terminal above by ONE rule. The handle used to stand OUTSIDE it, on the mirror's own
                  black: the dock read as chrome and the handle floating above it read as part of the
                  terminal, a control with no ground. That is what "hard to distinguish" meant in dark,
                  where `--background` IS the mirror's fill (mirror-space.ts) and a 6px grip at
                  `bg-muted-foreground/50` was the only thing on screen saying a control was there.
                  Given the dock's own ground it is a handle ON the chrome, which is what it does.

                  The rule and the fill live HERE rather than on the composer's dock so that boundary
                  is UNCONDITIONAL: the handle inside is gated on there being a pane to switch to, this
                  block is not, so the mirror is closed by one hairline in every state (DESIGN.md §2,
                  §4). The composer keeps its own `bg-chrome` — the same value, so nothing changes
                  visually — which leaves it self-sufficient wherever it is mounted alone.

                  THE FILL IS `--chrome`, NOT `--muted`. Chrome is normally the page colour separated
                  by a rule, and this is the one place that rule cannot hold: the block sits on the
                  terminal mirror, and in dark `--background` IS the mirror's fill (mirror-space.ts).
                  It needs a fill. --muted was the wrong one — rgb(38) under a rgb(10) terminal, a
                  bright slab across the bottom of a dark screen, and the operator asked for it
                  darker. --chrome is rgb(23) in dark, the same raised surface the sheets stand on,
                  and unchanged at rgb(235) in light, where --card would be pure white and land
                  1.04:1 against the inverted mirror. index.css states the whole argument. */}
              <div data-slot="chrome-block" className="border-t border-rule bg-chrome">
                {/* …and stands down while the keyboard is up, for 30px (`py-3` around the 6px
                    grip — it was py-3.5/34px until the 2026-08-31 shave; the swipe threshold is
                    24px and the strip is full-width, so the gesture still lands). Switching panes
                    is a
                    BEFORE-typing act, so the row costs its height at the one moment it cannot be
                    wanted. Nothing is stranded: the tab strip above still switches, the sheet is still
                    reachable the instant the keyboard closes, and `Collapse` unmounts the button at
                    the end of the exit so it leaves the tab order with the pixels. */}
                <Collapse open={!composing && agents.length + shellPanes.length > 0}>
                  <button
                    type="button"
                    aria-label={t("chat.switcher.aria")}
                    {...swipe}
                    onClick={() => setDrawer("switcher")}
                    className="flex w-full touch-none items-center justify-center py-3 transition-colors active:bg-muted/50"
                  >
                    <span className="h-1.5 w-12 rounded-md bg-muted-foreground/50" />
                  </button>
                </Collapse>

                <Composer
                  ref={composerRef}
                  paneId={paneId}
                  scope={scope}
                  agent={agent?.agent}
                  isShell={isShell}
                  // The state, as the WORD on the composer's status strip. It used to be the pane
                  // header's caption line; the dot badged onto the agent's tile up there stays, because
                  // the two carry the range together (status-badge.tsx). `stale` is the same
                  // `connecting` the dot reads, so the pair still dims as one.
                  status={agent?.status}
                  stale={connecting}
                  // The one read of the keyboard, handed down. See `composing` above.
                  composing={composing}
                  gone={gone}
                  readOnly={readOnly}
                  // §10.3's pre-flight refusal, as a disabled state AND as the placeholder copy: the
                  // composer must not invite a reply it already knows the lead will refuse, and "which
                  // machine am I typing into" has to be answerable without tapping Send to find out.
                  hostBlock={hostBlock}
                  dialogPresent={dialogPresent}
                  text={text}
                  terminalDraft={terminalDraft}
                  rawTerminalDraft={rawTerminalDraft}
                  prefs={prefs}
                  setWrap={setWrap}
                  stepFontSize={stepFontSize}
                  setRawTerminal={setRawTerminal}
                  setTapToFocus={setTapToFocus}
                  onSent={onSent}
                />
              </div>
            </div>
          </Collapse>
        </div>

        {/* Swipe-up quick switcher — just the panes (agents + shells), reached by the thumb gesture.
            Switch-only: pane closing lives in the pane pill's long-press sheet, not here. */}
        <BottomSheet
          open={drawer === "switcher"}
          onClose={closeDrawer}
          title={t("chat.switcher.title")}
        >
          <ThreadSidebar
            agents={agents}
            shellPanes={shellPanes}
            currentPaneId={paneId}
            onSelect={switchTo}
            recentOpen={dash.prefs.recentOpen}
            onRecentOpenChange={dash.setRecentOpen}
            // Shells fold on the same count rule Spaces uses: on a herd with dozens of bare shells
            // they'd otherwise bury the agents you opened this sheet to reach.
            shellsOpen={openForCount(dash.prefs.shellsOpen, shellPanes.length)}
            onShellsOpenChange={dash.setShellsOpen}
            className="px-0 py-1"
          />
        </BottomSheet>

        {/* The pane menu the header's ⋮ opens — the SAME sheet the pane pill opens, given the two
            read rows the strip can't offer (see its props). Mounted HERE, a sibling of the switcher
            sheet, and deliberately NOT inside the header slot that triggers it: the sheet is a
            plain `fixed inset-0` element with no portal (ui/sheet.tsx — "no Radix, no portals"), so
            it is positioned by the nearest transformed/filtered ancestor and stacks within the
            nearest stacking context. The header is `sticky z-20` and animates; a sheet mounted inside
            it would be laid out and z-ordered against the header rather than the viewport.

            FOCUS, for the find row specifically: the row calls `onClose()` and then `openFind()` in
            one React event, so a single commit unmounts the sheet and renders the FindBar into the
            header's `override`. React runs the unmounting tree's effect cleanups before the mounting
            tree's effects, so BottomSheet's focus-restore fires first — and it aims at the ⋮ button,
            which the override has just removed from the document, so it is a no-op on a detached
            node. FindBar's own mount effect then focuses the input and pops the keyboard. Verified in
            agent-chat.test.tsx rather than reasoned about, because the ordering is the whole
            argument. */}
        <PaneActionsSheet
          open={drawer === "paneMenu"}
          onClose={closeDrawer}
          pane={agent ?? null}
          scope={scope}
          readOnly={readOnly}
          onRenamed={() => revalidator.revalidate()}
          onClosed={(id) => (id === paneId ? onBack() : revalidator.revalidate())}
          onFind={display ? openFind : undefined}
          onHistory={historyAvailable ? () => navigate(historyPath(paneId, scope)) : undefined}
          // ZEN'S ONE ENTRY POINT, and the absence of this callback IS the gate — the sheet hides a
          // row it was given nothing for, exactly as it does for find and history. Gated twice: the
          // Settings toggle decides whether this phone offers zen at all, and `display` keeps it off
          // a pane with nothing to look at, the way find is gated.
          //
          // It lives in the sheet rather than as a second header button because this header states
          // its own budget: one Leave (the Collie mark) + one flexible Identity + at most two
          // Actions, and the row already spent its Action slot on the ⋮ when find and history moved
          // in here. A third icon would take that width back off the pane name, which is the one
          // flexible element the budget protects. Zen is also the same FAMILY as the two rows it
          // joins — "look at the output differently" — so the menu it belongs in already existed.
          onZen={zenAvailable && display ? enterZen : undefined}
        />
      </div>
    </CompactStripLabels>
  );
}
