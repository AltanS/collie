import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useNavigate, useRevalidator } from "react-router";
import { ArrowUpToLine, Loader2, RefreshCw, ScrollText, TerminalSquare } from "lucide-react";
import { useSwipeUp } from "@/hooks/use-swipe";
import { useSpaceActions } from "@/hooks/use-spaces";
import { useDashPrefs, openForCount } from "@/hooks/use-dash-prefs";
import { useDisplayPrefs } from "@/hooks/use-display-prefs";
import { useStableTerminalDraft } from "@/hooks/use-terminal-draft";
import { isConnecting } from "@/lib/connection";
import { setStatus } from "@/lib/status";
import { ChatMessageList, type ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import { BottomSheet } from "@/components/ui/sheet";
import { AppHeader } from "@/components/app-header";
import { ThemeToggle } from "@/components/theme-control";
import { AnsiOutput } from "@/components/ansi-output";
import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { adapterFor } from "@/lib/harness";
import { FindBar } from "@/components/find-bar";
import { Composer, type ComposerHandle } from "@/components/composer";
import {
  matchPanes,
  PaneFilterField,
  shouldFilter,
  ThreadSidebar,
} from "@/components/agent-sidebar";
import { AgentIcon } from "@/components/agent-icon";
import { TabStrip } from "@/components/tab-strip";
import { PaneStrip } from "@/components/pane-strip";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { StatusArea } from "@/components/status-area";
import { ShellBadge, StatusBadge } from "@/components/status-badge";
import { submitPromptOption } from "@/lib/prompt-action";
import { submitWizardKeys } from "@/lib/wizard-action";
import { submitPreviewKeys, submitPreviewNote, submitPreviewOption } from "@/lib/preview-action";
import { submitMultiSelectIntent, type MultiSelectIntent } from "@/lib/multi-select-action";
import type { PreviewBlockAction } from "@/components/preview-select-block";
import { canGrowRequestedLines, growRequestedLines } from "@/lib/loaders";
import { shortCwd } from "@/lib/format";
import { paneTitle } from "@/lib/pane-name";
import { historyPath, spacePath } from "@/lib/nav";
import { bucketOf } from "@/lib/triage";
import { isReadOnly } from "@/lib/types";
import type { AgentView, BridgeStatus, DeviceAuth, TabView } from "@/lib/types";
import type {
  MultiSelectModel,
  PreviewSelectModel,
  PromptModel,
  PromptOption,
  WizardModel,
} from "@/lib/blocks";

interface AgentChatProps {
  paneId: string;
  /** The session this pane lives in (undefined = primary) — scopes every read/write + the safety chip. */
  session?: string;
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
  // Global connection state — fed straight to the shared AppHeader, which drives the header Collie
  // mark (gallop/rest, identically to the dashboard), and lets us dim the stale StatusBadge while not
  // live. Defaults describe a healthy link so tests that don't care render "live".
  bridge?: BridgeStatus | undefined;
  error?: boolean;
  stalled?: boolean;
  onBack: () => void;
  onSelect: (paneId: string) => void;
}

// At most one drawer/sheet is open at a time; null = none. (The composer's own Keys/Quick/Agent
// sheets are separate and live inside <Composer>.)
type Drawer = "switcher" | null;

/**
 * The pane a switch is currently heading for, handed from the OUTGOING instance to the incoming one.
 *
 * Module scope on purpose: DetailRoute keys AgentChat by paneId, so a switch unmounts this whole
 * component and no ref or state survives the trip. Without the handoff the arrival is silent and
 * focus lands on `document.body` — the sheet's focus-restore correctly targets the "Switch pane"
 * handle, but that button unmounts in the same commit. A keyboard user then has to tab back in from
 * the top of the document, and a screen-reader user gets no signal they arrived anywhere at all.
 */
let arrivingAt: string | null = null;

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
  session,
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
  // Poll-truth "is the data on screen not live". The header (AppHeader) reads the same inputs to drive
  // the Collie mark + pill; here we use it to dim the StatusBadge, so the badge stops presenting the
  // last snapshot's status as current while we're reconnecting/lost, and restores instantly on recovery.
  const connecting = isConnecting({ bridge, error, stalled });
  const { newTab } = useSpaceActions();
  // Single display-prefs instance: the View controls (in <Composer>) write it, the mirror reads it.
  const { prefs, setWrap, stepFontSize, setRawTerminal } = useDisplayPrefs();
  // Raw-terminal escape hatch: when on, every Claude grammar is bypassed and the plain mirror shows,
  // so a mis-detected/mis-rendered dialog can always be driven by hand with the keys pad.
  const grammarsOn = !prefs.rawTerminal;
  const isShell = agent?.kind === "shell";
  // This device isn't allowlisted to type into agents: the backend rejects every write, so the
  // composer drops to read-only (and shows a banner). The mirror still polls (reading is fine).
  const readOnly = isReadOnly(device);

  // Drawers/sheets are mutually exclusive — at most one open. A single value makes that invariant
  // unrepresentable to violate.
  const [drawer, setDrawer] = useState<Drawer>(null);
  const closeDrawer = () => setDrawer(null);
  // The switcher's filter query. It lives HERE rather than inside ThreadSidebar because the field is
  // rendered into the sheet's sticky header (see PaneFilterField) — the list below it scrolls, the
  // field must not. Opening the switcher always starts from a clean query.
  const [paneQuery, setPaneQuery] = useState("");
  /**
   * The herd AS IT WAS when you opened the switcher.
   *
   * The list is live and the poll runs every 1.5s, so a pane changing triage bucket mid-sheet
   * doesn't just shift the list — it REMOVES a row from one section and the row below slides into
   * its exact coordinates. Measured: a row at y=506 was replaced, at the same pixel, by a different
   * pane; every row below it moved up 44px while everything above held still. You tap where you were
   * aiming and land somewhere else — and specifically NOT on the pane that just started needing you.
   * At ~1.3 bucket transitions/minute on a quiet herd, a 5–10s browse has a real chance of eating one.
   *
   * (Scroll anchoring is NOT the answer and is already working: the browser compensates correctly
   * for inserts above the viewport — measured scrollTop 700 → 1037 with the reference row moving 0px.
   * Adjusting scrollTop by hand on list growth would double-correct that case.)
   *
   * So the sheet renders a frozen copy and offers a refresh, the same shape as the mirror's
   * follow/hasNew pause. Nothing is hidden: `switcherChanged` counts what moved.
   */
  const [frozenHerd, setFrozenHerd] = useState<{ agents: AgentView[]; shellPanes: AgentView[] } | null>(
    null,
  );
  const openSwitcher = () => {
    setPaneQuery("");
    setFrozenHerd({ agents, shellPanes });
    setDrawer("switcher");
  };
  const closeSwitcher = () => {
    setFrozenHerd(null);
    closeDrawer();
  };
  const listRef = useRef<ChatMessageListHandle>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const switchHandleRef = useRef<HTMLButtonElement>(null);

  const gone = !agent;

  // Land the arrival: put focus on a real control in the pane we just switched to, and say where we
  // are. Announced from an effect rather than at render because StatusArea is the live region and it
  // mounts with this component — content present when a live region is created is not reliably
  // announced. Focus goes to the switcher handle: it exists in every pane, it names itself, and it
  // leaves the keyboard user one keypress from switching again rather than 30-odd from the top.
  useEffect(() => {
    if (arrivingAt !== paneId) return;
    arrivingAt = null;
    switchHandleRef.current?.focus();
    setStatus(agent ? `Switched to ${paneTitle(agent).primary}` : "Switched pane", "success");
    // paneId only: this fires once per arrival, not whenever the pane's title happens to change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]);

  // Swipe up (or just tap) the handle above the composer to bring up the pane switcher. A lowish
  // threshold + a taller hit area (below) make the gesture easy to land with a thumb; tapping is the
  // reliable fallback. "Up" naturally reveals a bottom sheet without fighting the mirror's scroll.
  const swipe = useSwipeUp(openSwitcher, 24);
  // What the switcher shows: the frozen copy while it's open, the live herd otherwise.
  const switcherAgents = frozenHerd?.agents ?? agents;
  const switcherShells = frozenHerd?.shellPanes ?? shellPanes;
  // How far the frozen copy has drifted from the live herd — panes that appeared, vanished, or moved
  // to a different triage section. Order changes WITHIN a section don't count: they don't move a row
  // between sections, which is the thing that swaps what's under your thumb.
  const switcherChanged = useMemo(() => {
    if (!frozenHerd) return 0;
    // A shell has no triage bucket; "shells" stands in for the section it renders under.
    const was = new Map<string, string>(frozenHerd.agents.map((a) => [a.paneId, bucketOf(a)]));
    for (const p of frozenHerd.shellPanes) was.set(p.paneId, "shells");
    const now = new Map<string, string>(agents.map((a) => [a.paneId, bucketOf(a)]));
    for (const p of shellPanes) now.set(p.paneId, "shells");
    let n = 0;
    for (const [id, bucket] of now) if (was.get(id) !== bucket) n++;
    for (const id of was.keys()) if (!now.has(id)) n++;
    return n;
  }, [frozenHerd, agents, shellPanes]);

  // What the switcher's filter is filtering. Derived here because the field lives in the sheet's
  // header while the list lives in its body — both need the same herd and the same match rule.
  const switcherTotal = switcherAgents.length + switcherShells.length;
  const switcherFilterable = shouldFilter(switcherTotal);
  const switcherMatches = useMemo(
    () => matchPanes([...switcherAgents, ...switcherShells], paneQuery),
    [switcherAgents, switcherShells, paneQuery],
  );
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

  // The agent's own statusline (model · ctx% · cwd · branch · tokens) is stripped off the mirror by
  // stripChrome so it doesn't duplicate the composer — but it carries real context (the branch, most
  // notably), so we re-surface that one line as app chrome just above the composer, where it sat in
  // the TUI. Routed through the SAME adapter (adapterFor) whose buildBlocks strips the chrome, so the
  // two can't drift; null when there's no adapter for the agent, a menu is up, or no box at the tail,
  // in which case the strip is hidden. A second parse of `display`, but memoised on it, so it only
  // recomputes when the buffer content changes — off the render hot path.
  const statusLine = useMemo(
    () =>
      grammarsOn
        ? adapterFor(agent?.agent)?.extractStatusLine(splitLines(parseAnsi(display))) ?? null
        : null,
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
  const historyAvailable = Boolean(agent?.agentSessionId);
  const moreScrollback =
    agent?.readableLines !== undefined &&
    requestedLines < agent.readableLines &&
    canGrowRequestedLines(paneId, session);

  // Load older scrollback: raise the per-pane requested line count and refetch. The enlarged buffer
  // prepends older lines at the top, so we adopt it into the frozen display and re-anchor the scroll
  // position (measure height before, restore after) to keep the content you were reading in place.
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderAnchor = useRef<{ height: number; top: number } | null>(null);
  const adoptTarget = useRef<number | null>(null); // the requestedLines a pending grow is waiting on
  const pendingRestore = useRef(false); // re-anchor scroll after the enlarged display paints
  function loadOlder() {
    if (loadingOlder || !canGrowRequestedLines(paneId, session)) return;
    const el = listRef.current?.getScrollElement();
    olderAnchor.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    setLoadingOlder(true);
    setFollowing(false); // stay put in history rather than snapping to the tail
    adoptTarget.current = growRequestedLines(paneId, session);
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
    async (option: PromptOption, prompt: PromptModel) => {
      if (readOnly) {
        setStatus("Read-only — device not authorised", "error");
        return;
      }
      const result = await submitPromptOption({
        paneId,
        session,
        requestedLines,
        detectedRevision: shown.revision,
        prompt,
        option,
      });
      if (result.status === "sent") {
        setStatus("Sent", "success");
        setFollowing(true);
        revalidator.revalidate();
        listRef.current?.scrollToBottom();
      } else if (result.status === "changed") {
        setStatus("Menu changed — refreshing", "warn");
        revalidator.revalidate();
      } else {
        setStatus(result.error || "Send failed", "error");
      }
    },
    [readOnly, paneId, session, requestedLines, shown.revision, revalidator],
  );

  // Tap a wizard control (an option digit, step navigation, or the review step's submit/cancel).
  // Same shape as handlePromptAction — the guard re-derives the wizard from a FRESH read and only
  // a clean match sends the single keystroke (incremental round-trip; grammar/WIZARD_NOTES.md).
  // gate: claude-only (see hasBlockGrammar) — wizard blocks only ever exist for a Claude pane
  // (buildBlocks gates on ctx.agent), so this handler can't fire for other agents.
  const handleWizardAction = useCallback(
    async (keys: string[], wizard: WizardModel) => {
      if (readOnly) {
        setStatus("Read-only — device not authorised", "error");
        return;
      }
      const result = await submitWizardKeys({
        paneId,
        session,
        requestedLines,
        detectedRevision: shown.revision,
        wizard,
        keys,
      });
      if (result.status === "sent") {
        setStatus("Sent", "success");
        setFollowing(true);
        revalidator.revalidate();
        listRef.current?.scrollToBottom();
      } else if (result.status === "changed") {
        setStatus("Wizard changed — refreshing", "warn");
        revalidator.revalidate();
      } else {
        setStatus(result.error || "Send failed", "error");
      }
    },
    [readOnly, paneId, session, requestedLines, shown.revision, revalidator],
  );

  // Tap a preview-dialog control (an option, the note add/edit/remove, or the wizard step nav).
  // Same guard-first shape as the two handlers above, but the choreography behind an intent is
  // MULTI-step (digit→verify→Enter; n→verify→type→Escape — see lib/preview-action.ts and
  // grammar/NOTES_NOTES.md), so the handler dispatches on the intent kind.
  // gate: claude-only (see hasBlockGrammar) — preview blocks only ever exist for a Claude pane.
  const handlePreviewAction = useCallback(
    async (action: PreviewBlockAction, preview: PreviewSelectModel) => {
      if (readOnly) {
        setStatus("Read-only — device not authorised", "error");
        return;
      }
      const base = {
        paneId,
        session,
        requestedLines,
        detectedRevision: shown.revision,
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
          action.kind === "note" ? (action.text ? "Note saved" : "Note removed") : "Sent",
          "success",
        );
        setFollowing(true);
        revalidator.revalidate();
        listRef.current?.scrollToBottom();
      } else if (result.status === "changed") {
        setStatus("Dialog changed — refreshing", "warn");
        revalidator.revalidate();
      } else {
        setStatus(result.error || "Send failed", "error");
        revalidator.revalidate();
      }
    },
    [readOnly, paneId, session, requestedLines, shown.revision, revalidator],
  );

  // Tap a multi-select control (toggle a checkbox, Submit, the "Chat about this" escape, or the
  // review screen's confirm/cancel). Same guard-first shape as the wizard handler — the guard
  // re-derives the dialog from a FRESH read; toggle sends one digit, Submit drives the closed-loop
  // Down→Up→verify→Enter macro (see lib/multi-select-action.ts). gate: claude-only (multi-select
  // blocks only ever exist for a Claude pane, buildBlocks gates on ctx.agent).
  const handleMultiSelectAction = useCallback(
    async (action: MultiSelectIntent, multi: MultiSelectModel) => {
      if (readOnly) {
        setStatus("Read-only — device not authorised", "error");
        return;
      }
      const result = await submitMultiSelectIntent({
        paneId,
        session,
        requestedLines,
        detectedRevision: shown.revision,
        multi,
        intent: action,
      });
      if (result.status === "sent") {
        setStatus("Sent", "success");
        setFollowing(true);
        revalidator.revalidate();
        listRef.current?.scrollToBottom();
      } else if (result.status === "changed") {
        setStatus("Selection changed — refreshing", "warn");
        revalidator.revalidate();
      } else {
        setStatus(result.error || "Send failed", "error");
      }
    },
    [readOnly, paneId, session, requestedLines, shown.revision, revalidator],
  );

  // NOTE: the composer is deliberately NOT auto-focused on open/switch — that would pop the Android
  // keyboard and cover the output. You read the pane first, then tap the input to type. (Explicit
  // actions inside the composer still focus it; the mirror tap focuses it via composerRef.)

  // Switch to another thread from the sidebar or the swipe-up switcher (DetailRoute keys AgentChat
  // by pane, so this remounts fresh — composer resets — same as opening from home).
  function switchTo(id: string) {
    closeSwitcher();
    if (id === paneId) return;
    arrivingAt = id; // claimed by the incoming instance's mount effect — see `arrivingAt`
    onSelect(id);
  }

  // Jump to another tab in this space by opening one of its panes (the in-pane tab bar).
  function goToTab(tabId: string) {
    if (!agent || tabId === agent.tabId) return;
    const target = [...agents, ...shellPanes].find((p) => p.tabId === tabId);
    if (target) switchTo(target.paneId);
  }

  // Open a space from the nav hub — go to its detail route (its tabs + panes, incl. shells). A step
  // back up out of the pane, so it slides backward.
  function openSpace(workspaceId: string) {
    closeDrawer();
    navigate(spacePath(workspaceId, session));
  }

  // Tapping the terminal mirror focuses the composer so you can start typing right away. Two bails:
  //  - the tap landed on an interactive control INSIDE the mirror — a native prompt/wizard/preview
  //    button, the Load-older button, or the note editor's own textarea. Their click bubbles up to
  //    this handler, and focusing the composer here would pop the soft keyboard on every option tap
  //    (and steal focus from the note editor). Only a tap on the raw terminal text should focus.
  //  - the user is selecting text (a long-press selection), so copy works instead of the tap
  //    collapsing the selection and popping the keyboard.
  function focusFromMirror(e: ReactMouseEvent<HTMLDivElement>) {
    const target = e.target as Element | null;
    if (target?.closest?.("button, a, input, textarea, select, [role='textbox']")) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    composerRef.current?.focusInput();
  }

  return (
    <div className="flex min-h-0 w-full min-w-0 max-w-[100dvw] flex-1 flex-col overflow-x-hidden">
      {/* Header — the SAME AppHeader shell the dashboard and space mount, so the Collie mark is
          identical on every screen (no hand-rolled bar to drift). The pane's own bits ride in via
          slots: the `space › tab` breadcrumb as the center, the agent StatusBadge as the right-cluster
          lead, and the find bar as the full-row takeover while searching. */}
      <AppHeader
        bridge={bridge}
        error={error}
        stalled={stalled}
        onHome={onBack}
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
        // Right cluster, in reading order: History, then the agent status pill. The pill is the
        // rightmost item on every pane screen (it's the thing you glance at), so History sits to its
        // LEFT rather than trailing it. Both ride in `rightLead` because AppHeader renders
        // `rightLead` before `rightTrail` — the order here IS the on-screen order.
        //
        // History opens the agent's own transcript, the only real conversation history a Claude pane
        // has: its terminal runs on the alternate screen, so the mirror below can never show more
        // than the visible viewport. Offered only when the pane reported an agent session id (i.e. a
        // transcript can exist at all), so the button never leads to an empty screen.
        //
        // The status pill is dimmed while the connection isn't live, so a frozen "working"/"idle"
        // from the last snapshot doesn't masquerade as current. A bare shell shows a muted "shell" tag.
        rightLead={
          agent ? (
            <>
              {/* The pane is where you actually stare at the mirror, so the situational flip the
                  theme control exists for bites hardest here. Leads the cluster rather than
                  trailing it — the status pill stays the rightmost thing on every pane screen. */}
              <ThemeToggle />
              {agent.agentSessionId && (
                <button
                  type="button"
                  onClick={() => navigate(historyPath(paneId, session))}
                  aria-label="Conversation history"
                  className="-mr-1 flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors active:bg-muted/60"
                >
                  <ScrollText className="size-4" />
                </button>
              )}
              {isShell ? (
                <ShellBadge stale={connecting} />
              ) : (
                <StatusBadge status={agent.status} stale={connecting} />
              )}
            </>
          ) : undefined
        }
      >
        {/* Title block: the space › tab leads, with the agent's brand logo to its left (the agent
            name would just repeat the icon, so it's dropped), and the working directory on the
            subline. Tapping it leaves the pane for the space overview (all its tabs + panes). */}
        {agent ? (
          <button
            type="button"
            onClick={() => openSpace(agent.workspaceId)}
            aria-label={`Open ${agent.workspaceLabel} overview`}
            className="-mx-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1 py-0.5 text-left transition-colors active:bg-muted/60"
          >
            {isShell ? (
              <div className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-muted">
                <TerminalSquare className="size-3 text-muted-foreground" />
              </div>
            ) : (
              // Deliberately smaller than the size-8 Collie mark beside it — the agent logo is the
              // pane's subject, not a second brand competing with Collie's for the header.
              <AgentIcon agent={agent.agent} className="size-6" />
            )}
            <div className="min-w-0 flex-1">
              {/* A user-set pane label leads when present (the identifier they chose), then Claude's
                  own /rename session name, otherwise the default space › tab. The cwd subline keeps
                  context either way. */}
              <div className="truncate font-semibold leading-tight">
                {agent.paneLabel ??
                  agent.sessionName ??
                  `${agent.workspaceLabel}${tabLabel ? ` › ${tabLabel}` : ""}`}
              </div>
              <div className="truncate font-mono text-xs leading-tight text-muted-foreground">
                {shortCwd(agent.cwd)}
              </div>
            </div>
          </button>
        ) : (
          <div className="min-w-0 flex-1">
            <span className="truncate font-semibold">(agent gone)</span>
          </div>
        )}
      </AppHeader>

      {/* Content region below the header — the mirror inside is the scroller. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Status line — a slim row pinned directly below the header (NOT the scrolling mirror), so a
            "Sent" / "changed" notice reads at the top instead of floating over the terminal tail
            (prompt/cursor + up-levelled prompt buttons) it used to cover. Renders nothing — no
            reserved space — when idle; auto-dismisses. */}
        <StatusArea className="mx-3 mt-1.5 shrink-0" />

        {/* Read-only notice when this device isn't allowlisted (the composer below is disabled too). */}
        <ReadOnlyBanner device={device} />

        {/* In-pane tab bar: the current space's tabs above the mirror — switch tab without leaving the
            pane, or create one with +. No "All" here (you're always in a specific tab). */}
        {agent && (
          <TabStrip
            workspaceId={agent.workspaceId}
            tabs={tabs}
            agents={agents}
            selected={agent.tabId}
            onSelect={(id) => id && goToTab(id)}
            onNewTab={newTab}
            allowAll={false}
            session={session}
            readOnly={readOnly}
            onRenamed={() => revalidator.revalidate()}
            // Closing the tab this pane lives in kills the pane too — leave for Home the same way a
            // pane-close does (onBack); closing any other tab just revalidates so it drops out.
            onClosed={(tabId) => (agent?.tabId === tabId ? onBack() : revalidator.revalidate())}
          />
        )}

        {/* Pane switcher: the panes that share this tab (space › tab › pane). Mobile shows them as a
            tabbed row rather than tiling the panes; only appears when the tab holds more than one. */}
        {agent && (
          <PaneStrip
            panes={[...agents, ...shellPanes]
              .filter((p) => p.workspaceId === agent.workspaceId && p.tabId === agent.tabId)
              .sort((a, b) => a.paneId.localeCompare(b.paneId))}
            currentPaneId={paneId}
            onSelect={switchTo}
            session={session}
            readOnly={readOnly}
            onRenamed={() => revalidator.revalidate()}
            // Mirror closePane's success branch: closing the open pane returns Home, else revalidate.
            onClosed={(id) => (id === paneId ? onBack() : revalidator.revalidate())}
          />
        )}

        {/* Terminal mirror — tapping it focuses the composer so you can start typing right away
            (unless you're selecting text to copy, which the tap must not collapse). */}
        {/* min-w-0 only — do NOT set overflow-x-hidden here: that forces overflow-y to `auto` (CSS
            quirk) and makes this wrapper a second vertical scroller competing with ChatMessageList. */}
        <div className="min-h-0 min-w-0 flex-1" onClick={focusFromMirror}>
          <ChatMessageList
            ref={listRef}
            dep={display}
            onAtBottomChange={setFollowing}
            hasNew={hasNew}
            className="px-2 py-3"
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
                    onClick={() => navigate(historyPath(paneId, session))}
                    className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-xs font-medium text-muted-foreground transition-colors active:bg-muted/50"
                  >
                    <ScrollText className="size-3.5" />
                    Show entire history
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
                    {loadingOlder ? "Loading…" : "Load older"}
                  </button>
                ) : null}
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
                  promptDisabled={readOnly || gone}
                />
              </>
            ) : (
              <div className="py-16 text-center text-sm text-muted-foreground">(no recent output)</div>
            )}
          </ChatMessageList>
        </div>

        {/* Bottom region: the pane-switch handle + composer. The status line USED to float here as an
            overlay just above the composer, but it covered the terminal tail (the prompt/cursor and
            up-levelled prompt buttons) — it now lives as a slim row just below the header. */}
        <div className="relative">

          {/* Swipe-up / tap handle for the quick pane switcher — the sheet that switches AND closes
              panes (each row has a ✕). A tall, full-width hit area so the swipe is easy to land (and a
              tap always works). Shown whenever a pane is open — even the last one, so it stays
              closable now that the nav drawer is gone. `touch-none` so the gesture is ours, not a
              browser scroll. */}
          {agents.length + shellPanes.length > 0 && (
            <button
              ref={switchHandleRef}
              type="button"
              aria-label="Switch pane"
              {...swipe}
              onClick={openSwitcher}
              // min-h-11 is the 44px touch floor: this strip is the only way into the switcher, and
              // at py-3.5 it measured 34px tall — the entry point to the flow was the one control
              // in it below the bar.
              className="flex min-h-11 w-full touch-none items-center justify-center py-3.5 transition-colors active:bg-muted/50"
            >
              <span className="h-1.5 w-12 rounded-full bg-muted-foreground/50" />
            </button>
          )}

          {/* The agent's statusline, re-surfaced as app chrome (its branch/model/ctx would otherwise
              vanish with the stripped input box). Sits directly above the composer, as it did in the
              TUI. Verbatim text — a React text node, so no XSS surface. */}
          {statusLine && (
            <div className="truncate border-t border-border/40 px-3 py-1 font-mono text-[11px] leading-tight text-muted-foreground">
              {statusLine}
            </div>
          )}

          <Composer
            ref={composerRef}
            paneId={paneId}
            session={session}
            agent={agent?.agent}
            isShell={isShell}
            gone={gone}
            readOnly={readOnly}
            dialogPresent={dialogPresent}
            text={text}
            terminalDraft={terminalDraft}
            rawTerminalDraft={rawTerminalDraft}
            prefs={prefs}
            setWrap={setWrap}
            stepFontSize={stepFontSize}
            setRawTerminal={setRawTerminal}
            onSent={onSent}
            // Find-in-output lives in the composer's View row now (the header was the wrong home for it).
            // Enabled only when there's buffered output to search; opening it freezes the tail (openFind).
            onOpenFind={display ? openFind : undefined}
          />
        </div>
      </div>

      {/* Swipe-up quick switcher — just the panes (agents + shells), reached by the thumb gesture.
          Switch-only: pane closing lives in the pane pill's long-press sheet, not here. */}
      <BottomSheet
        open={drawer === "switcher"}
        onClose={closeSwitcher}
        title="Switch pane"
        // The filter sits in the STICKY header, not the scrolling body — see PaneFilterField.
        headerExtra={
          switcherFilterable || switcherChanged > 0 ? (
            <div className="flex flex-col gap-2">
              {switcherFilterable && (
                <PaneFilterField
                  value={paneQuery}
                  onChange={setPaneQuery}
                  total={switcherTotal}
                  // Enter commits ONLY when the query resolves to exactly one pane. Selecting
                  // navigates you off what you were reading, so an ambiguous Enter must do nothing.
                  {...(switcherMatches.length === 1
                    ? { onCommit: () => switchTo(switcherMatches[0]!.paneId) }
                    : {})}
                />
              )}
              {/* The list is frozen, so say so rather than letting it silently go stale. Refreshing
                  is the user's call, taken with both thumbs still — never under a moving list. */}
              {switcherChanged > 0 && (
                <button
                  type="button"
                  onClick={() => setFrozenHerd({ agents, shellPanes })}
                  className="flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-border bg-muted/40 px-3 text-sm font-medium transition-colors hover:bg-muted active:scale-[0.99]"
                >
                  <RefreshCw className="size-4 shrink-0" aria-hidden />
                  {switcherChanged} {switcherChanged === 1 ? "pane" : "panes"} changed — refresh
                </button>
              )}
            </div>
          ) : undefined
        }
        // PIN the panel height while the filter exists — not a floor, a fixed height. `max-h-[82dvh]`
        // alone let the panel hug its content, so a narrowing result set collapsed the sheet from the
        // top and slid the field being typed into 312px down the viewport between two keystrokes. A
        // 70dvh floor only cut that to 52px, because a range still resizes. At a fixed height the
        // header cannot move at all. The dead space under two results is where the keyboard sits.
        // A short, content-hugging sheet is still right for a small herd — which is exactly the case
        // where no filter is rendered.
        {...(switcherFilterable ? { className: "h-[82dvh]" } : {})}
      >
        <ThreadSidebar
          agents={switcherAgents}
          shellPanes={switcherShells}
          currentPaneId={paneId}
          onSelect={switchTo}
          query={paneQuery}
          onClearQuery={() => setPaneQuery("")}
          // Where you're standing — what the sheet's "Here" section is scoped to, and the only
          // input that makes the switcher differ depending on the pane you opened it from.
          currentSpaceId={agent?.workspaceId}
          onOpenSpace={(id) => {
            closeSwitcher();
            navigate(spacePath(id, session));
          }}
          recentOpen={dash.prefs.recentOpen}
          onRecentOpenChange={dash.setRecentOpen}
          // Shells fold on the same count rule Spaces uses: on a herd with dozens of bare shells
          // they'd otherwise bury the agents you opened this sheet to reach.
          shellsOpen={openForCount(dash.prefs.shellsOpen, switcherShells.length)}
          onShellsOpenChange={dash.setShellsOpen}
          className="px-0 py-1"
        />
      </BottomSheet>
    </div>
  );
}
