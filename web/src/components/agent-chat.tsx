import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useNavigate, useRevalidator } from "react-router";
import { ArrowUpToLine, EllipsisVertical, Loader2, ScrollText, TerminalSquare } from "lucide-react";
import { useSwipeUp } from "@/hooks/use-swipe";
import { useSpaceActions } from "@/hooks/use-spaces";
import { useDashPrefs, openForCount } from "@/hooks/use-dash-prefs";
import { mirrorFont, useDisplayPrefs } from "@/hooks/use-display-prefs";
import { useStableTerminalDraft } from "@/hooks/use-terminal-draft";
import { useLocale } from "@/hooks/use-locale";
import { isConnecting } from "@/lib/connection";
import { t } from "@/lib/i18n";
import { setStatus } from "@/lib/status";
import { ChatMessageList, type ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import { BottomSheet } from "@/components/ui/sheet";
import { RouteHeader } from "@/components/app-header";
import { AnsiOutput } from "@/components/ansi-output";
import { MIRROR_SPACE, MIRROR_INVERT, styleFor } from "@/components/mirror-space";
import { cn } from "@/lib/utils";
import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { adapterFor } from "@/lib/harness";
import { FindBar } from "@/components/find-bar";
import { Composer, type ComposerHandle } from "@/components/composer";
import { ThreadSidebar } from "@/components/agent-sidebar";
import { AgentIcon } from "@/components/agent-icon";
import { TabStrip } from "@/components/tab-strip";
import { PaneStrip } from "@/components/pane-strip";
import { PaneActionsSheet } from "@/components/pane-actions-sheet";
import { CompactStripLabels } from "@/components/ui/labelled-strip";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { HostStaleBanner } from "@/components/host-stale-banner";
import { useHostHealth } from "@/components/pack-provider";
import { writeRefusal } from "@/lib/host-health";
import { StatusArea } from "@/components/status-area";
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
  const listRef = useRef<ChatMessageListHandle>(null);
  const composerRef = useRef<ComposerHandle>(null);

  const gone = !agent;

  // Swipe up (or just tap) the handle above the composer to bring up the pane switcher. A lowish
  // threshold + a taller hit area (below) make the gesture easy to land with a thumb; tapping is the
  // reliable fallback. "Up" naturally reveals a bottom sheet without fighting the mirror's scroll.
  const swipe = useSwipeUp(() => setDrawer("switcher"), 24);
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

        {/* Content region below the header — the mirror inside is the scroller. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Status line — a slim row pinned directly below the header (NOT the scrolling mirror), so a
              "Sent" / "changed" notice reads at the top instead of floating over the terminal tail
              (prompt/cursor + up-levelled prompt buttons) it used to cover. Renders nothing — no
              reserved space — when idle; auto-dismisses. */}
          <StatusArea className="mx-3 mt-1.5 shrink-0" />

          {/* Read-only notice when this device isn't allowlisted (the composer below is disabled too). */}
          <ReadOnlyBanner device={device} className="mx-3 mt-1.5" />

          {/* The pane's MACHINE is not answering the lead — the mirror below is last-good and the
              composer is locked. Its tier-1 twin (the app-wide ConnectionBanner) lives up in
              RootLayout; this one is scoped to the pane because the phone's link is fine. Renders
              nothing on a solo install, or while the host is live. */}
          <HostStaleBanner health={hostHealth} className="mx-3 mt-1.5" />

          {/* In-pane tab bar: the current space's tabs above the mirror — switch tab without leaving the
              pane, or create one with +. No "All" here (you're always in a specific tab). */}
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
                .toSorted((a, b) => a.paneId.localeCompare(b.paneId))}
              currentPaneId={paneId}
              onSelect={switchTo}
              scope={scope}
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
          {/* THE MIRROR'S OWN TOP EDGE, and the 8px of PAGE the folder tab opens onto — `mt-2
              border-t border-rule`, one set, do not separate them.

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
              own to sit on. `mt-2` is 8px of PAGE below the baseline — the tab now opens onto the
              page, which is what a folder tab's open edge promises — and `border-t` is then the
              mirror's own top edge, 8px clear of the baseline, so the two lines read as two
              boundaries and never as one doubled hairline.

              It costs nothing. `ChatMessageList` below dropped the matching 12px of scroller
              `pt` in the same edit: the padding was invisible (page colour on page colour when at
              the top of the buffer, and gone entirely the moment the mirror follows the tail, which
              is nearly always), so 12px of nothing became 9px of an actual boundary — the stack
              above the first terminal glyph got 3px SHORTER. A terminal draws to its own edges;
              flush against its top rule is the honest rendering, and the bottom keeps its `pb-3`
              because the tail wants clearance from the composer.

              This is unconditional, and that is deliberate: when PaneStrip renders it closes its own
              band with a border-b and the mirror still announces its top edge the same way 8px
              below. One geometry, no state in which the seam is drawn differently (DESIGN.md §2). */}
          {/* `role="presentation"` because that is what this element is: a layout wrapper with no
              semantics of its own. Its click handler adds nothing a keyboard user needs — focusing the
              composer is what a keyboard user already has (the textarea is the next tabbable thing),
              and `focusFromMirror` deliberately declines a tap that landed on a control or a text
              selection. It is a touch convenience layered over an already-reachable action. */}
          <div
            role="presentation"
            className={cn("mt-2 min-h-0 min-w-0 flex-1 border-t border-rule", mirrorFace.className)}
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
              up-levelled prompt buttons) — it now lives as a slim row just below the header. */}
          <div className="relative">

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
                Height is bounded upstream (MAX_STATUS_LINES caps the run stripChrome will claim), so
                there is no second cap here; the mirror is a flex child that shrinks, never pushed off. */}
            {statusLines.length > 0 && (
              <div
                className={cn(
                  "border-t border-border/40 px-3 py-1 font-mono text-[11px] leading-tight",
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
            {agents.length + shellPanes.length > 0 && (
              <button
                type="button"
                aria-label={t("chat.switcher.aria")}
                {...swipe}
                onClick={() => setDrawer("switcher")}
                className="flex w-full touch-none items-center justify-center py-3.5 transition-colors active:bg-muted/50"
              >
                <span className="h-1.5 w-12 rounded-md bg-muted-foreground/50" />
              </button>
            )}

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
        />
      </div>
    </CompactStripLabels>
  );
}
