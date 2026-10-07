// The pane screen, `/pane/:paneId`. Port of web/src/routes/detail.tsx + components/agent-chat.tsx.
//
// LAYOUT, top to bottom: the header (a claim on the shell's header, REMIX3.md rule 6: the identity
// block, the ⋮, the find bar as an override), the strips (tabs and panes, folding to a summary), one
// notice, the body (Chat, the Chat start state, or the Terminal, chosen by the chat gate), the
// docked dialog card, and the chrome block (composer.tsx: drawers, belt, field). Zen takes the
// header, the strips and the chrome block out through Collapse and leaves one floating exit; the
// card dock stays, because it is the pane's own dialog and not Collie's chrome.
//
// DATA. The mirror is polled through web's `fetchPane` into the shell's `paneStore` (data.ts says
// why), with the window Load older grows. The chat window is polled only while the gate wants it
// (pane-start.ts). The open pane is published to `focus`, so the scheduler polls it hot while the
// view follows the tail, and every write calls `noteSend` (answer.ts) for the 300 ms burst.
//
// THE TWO-STEP MOUNT. The pane is one route render, and the runtime commits a render in one task
// with no yield, so a tap used to mount everything (header claim, screen, composer, belt, keys tray,
// four sheets) in one 135 to 182 ms task at 4x CPU (the profile of 2026-10-06, 3.3). So the first
// commit draws what the eye goes to: the header claim, the strips, the notice, the screen (its
// skeleton or the prefetched text), the dialog card, the agent's two bands, and `ComposerStandIn`, a
// box of the composer's exact height. The composer (and in it the belt, the drawers, the keys tray,
// the palette) and the four sheet wrappers mount in a second task, after the first paint: the commit
// task asks for one animation frame (it runs before that paint) and, from it, a timer (it runs
// after); the timer wakes this screen through `scheduleUpdate` (rule 1). While a glide's update
// callback is pending no frame runs, so step two also waits for the callback to settle (REMIX3.md,
// "Frames during a view transition") and never lands inside the morph's capture. The two bands and
// the strips stay in step one: they sit in flow beside the screen and their height cannot be
// reserved without drawing them, and they read no layout. Nothing moves when step two lands: the
// stand-in and the composer are one height by construction (composer.tsx). A saved draft with
// attachments (chips the stand-in cannot size) and an opened sheet both skip the wait.
//
// LEAVING. A pane that is gone from a healthy snapshot taken after this screen opened says "Pane
// closed" once and goes up (ADR 0067); a pane that never showed up waits for that same proof.
import { Frame, on, type Handle } from "remix/component";
import { KeyRound, Lock, Minimize2, TriangleAlert, WifiOff } from "lucide";

import { mirrorFont } from "@web/hooks/use-display-prefs";
import type { Block, StyledLine } from "@web/lib/blocks";
import { rendersNativeMirror } from "@web/lib/harness";
import { t } from "@web/lib/i18n";
import { locateReply, type ReplyPlacement } from "@web/lib/latest-reply";
import { paneMirrorOverride } from "@web/lib/mirror-invert";
import { muxCapability } from "@web/lib/mux-capability";
import { changesPath, historyPath, panePath, spacePath } from "@web/lib/nav";
import { paneName, panePlaceParts } from "@web/lib/pane-name";
import { isNotPaired as webRefused, subscribePairing } from "@web/lib/pairing";
import { reportsSessionOnFirstPrompt, hasJournalAdapter } from "@web/lib/journal-agents";
import { paneScope } from "@web/lib/hosts";
import { paneScopeKey } from "@web/lib/scope";
import { isReadOnly, type AgentView, type TranscriptEntry } from "@web/lib/types";

import { navigate } from "../../lib/navigate";
import { CacheSheet } from "../../chips/cache-sheet";
import { crewOf, hostHealthOf } from "../../chips/crew";
import { PaneActionsSheet } from "../../chips/pane-actions-sheet";
import { address, config, paneStore, snapshot, snapshotAt } from "../../lib/data";
import { createFind } from "../../lib/find";
import { glideBack } from "../../lib/glide";
import { useLocale } from "../../lib/i18n-store";
import { loadDraft } from "../../lib/drafts";
import { clearNotPaired, markNotPaired, pairing } from "../../lib/pairing";
import { focus, kick, want } from "../../lib/polling";
import { buzz, dashPrefs, displayPrefs, paneFrames, setDashPref, stripsCollapsed, zen as zenPref } from "../../lib/prefs";
import { countRender } from "../../lib/render-count";
import { setStatus } from "../../lib/status";
import { onServer } from "../../lib/server-render";
import { scheduleUpdate, useStore } from "../../lib/store";
import { href } from "../../routes";
import { headerOf } from "../../shell/context";
import { HostStaleBanner, hostStaleSpeaks } from "../../shell/connection-banner";
import type { CustomSlot } from "../../shell/header-model";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import { Notice } from "../../ui/notice";
import { SheetPeek } from "../../ui/sheet";
import { answerFeedback, answerMenu, answerOption, answerUnread, type WriteTarget } from "./answer";
import { goUp, upPath } from "./back";
import { dialogOwnsKeyboard, type DialogCard } from "./cards";
import { ChatView } from "./chat";
import { chatReads, chatStore, pollChat } from "./chat-store";
import { Composer, ComposerStandIn } from "./composer";
import { findPane, PANE_LINES, PANE_LINES_MAX, PANE_LINES_STEP, pollPane, writeGate } from "./data";
import { CardDock, type CardActions } from "./dialog-card";
import { answerMultiSelect, answerPreview, answerWizard } from "./dialogs/actions";
import { FindBar } from "./find-bar";
import { SCREEN_FRAME, STATUS_FRAME, type PaneFrameName } from "./frames";
import { bindPaneFrames, framesActive, framesLatched, paneFrameSrc, pollPaneFrames } from "./pane-frames";
import { createLatestReply, LatestReplyCard } from "./latest-reply";
import { parseAgent, parseScreen } from "./parse";
import { PaneIdentity } from "./identity";
import type { PaneIdentityProps } from "./identity";
import { questionNotes } from "./question-note";
import { createGate } from "./pane-start";
import { PaneSettingsSheet } from "./settings-sheet";
import { AgentsFooter, StatusStrip } from "./statusline";
import { Strips, stripsExist } from "./strips";
import { needsYouElsewhere, SwitcherSheet } from "./switcher-sheet";
import { ScreenSkeleton, TerminalView, type MirrorTop } from "./terminal";
import { autoZenSetting, watchViewport } from "./viewport";

/** What the header slot draws: the identity props minus the handlers the slot binds itself. */
type IdentityState = Omit<PaneIdentityProps, "onName" | "onWorkspace" | "onCache">;

type Sheet = "actions" | "settings" | "cache" | "switcher" | null;

export function PaneRoute(handle: Handle<{ paneId: string }>) {
  useLocale(handle);
  const { scope } = address.get();
  const paneId = handle.props.paneId;
  const key = paneScopeKey(scope, paneId);
  const store = paneStore(key);
  const mountedAt = Date.now();

  // ── Reads ─────────────────────────────────────────────────────────────────────────────────────
  /** The mirror window: 600 rows, grown by Load older up to 1000 (web/src/lib/loaders.ts). */
  let lines = PANE_LINES;
  let olderLoading = false;
  // THE HOW OF THE MIRROR READ (S2). The beat (lib/polling.ts) decides when; with the frames switch
  // on, the read is the pane's two server frames and the read in one answer (pane-frames.ts), else
  // web's JSON `fetchPane`. The parse's agent is read when the beat fires (the first beat runs before
  // the first render), from the same snapshot and pref the render reads; the frames on screen come
  // from the last render.
  const agentNow = (): string | undefined => parseAgent(findPane(snapshot.get().data, paneId)?.agent, displayPrefs.get().rawTerminal);
  let frameAgent = agentNow();
  let frameTargets: readonly PaneFrameName[] = [SCREEN_FRAME, STATUS_FRAME];
  const readMirror = (signal: AbortSignal, window: number): Promise<boolean> => {
    if (!framesActive()) return pollPane(key, paneId, scope, signal, window);
    frameAgent = agentNow();
    return pollPaneFrames({ key, paneId, scope, lines: window, agent: frameAgent, targets: frameTargets }, signal);
  };
  want({ key: `pane-screen:${key}`, poll: (signal) => readMirror(signal, lines) }, handle.signal);
  focus.set({ paneId, following: true });
  if (!onServer()) {
    bindPaneFrames(
      {
        frame: (name) => handle.frames.get(name),
        src: () => paneFrameSrc(paneId, scope, lines, frameAgent),
      },
      handle.signal,
    );
  }

  // Every write here goes through web's api.ts, which reads each answer into WEB's pairing latch.
  // Each move of that latch is carried into this shell's own (lib/pairing.ts).
  // Not in a server render: nothing would ever end the subscription there (lib/server-render.ts).
  const unsubscribe = onServer() ? () => {} : subscribePairing(() => (webRefused() ? markNotPaired() : clearNotPaired()));
  handle.signal.addEventListener("abort", () => {
    unsubscribe();
    if (focus.get().paneId === paneId) focus.set({ paneId: null, following: true });
  });

  const readPane = useStore(handle, store);
  const readSnapshot = useStore(handle, snapshot);
  const readConfig = useStore(handle, config);
  const readDash = useStore(handle, dashPrefs);
  const readDisplay = useStore(handle, displayPrefs);
  const readPairing = useStore(handle, pairing);
  const readChat = useStore(handle, chatStore(key));
  const chatCounters = chatReads(key);
  const readStripsPref = useStore(handle, stripsCollapsed);
  const readZenAvailable = useStore(handle, zenPref);
  const find = createFind();
  const readFind = useStore(handle, find.state);
  const readFramesOn = useStore(handle, paneFrames);
  const readLatched = useStore(handle, framesLatched);
  const gate = createGate(() => scheduleUpdate(handle), handle.signal);
  /** The `answered` count the gate last read: a reply wakes this screen only when it settles the gate. */
  let gateAnswered = chatCounters.replies.get();
  /** A snapshot answered after this screen opened: the proof auto-exit waits for (ADR 0067). */
  let freshSinceMount = false;
  // Freshness moves on every answer, so it is not a `useStore`: these two listeners wake this screen
  // only when the answer can change what it draws (REMIX3.md, "A module store is right when").
  handle.queueTask(() => {
    if (handle.signal.aborted) return;
    chatCounters.replies.subscribe(() => {
      const end = gate.record.endMark;
      if (end !== null && gateAnswered <= end && chatCounters.replies.get() > end) scheduleUpdate(handle);
    }, handle.signal);
    snapshotAt.subscribe(() => {
      if (freshSinceMount || snapshotAt.get() <= mountedAt) return;
      freshSinceMount = true;
      // A pane in the snapshot needs no proof now; one that goes missing later changes the snapshot.
      if (findPane(snapshot.get().data, paneId) === undefined) scheduleUpdate(handle);
    }, handle.signal);
  });
  const viewport = watchViewport(() => scheduleUpdate(handle), handle.signal);

  // ── Local state ───────────────────────────────────────────────────────────────────────────────
  let sheet: Sheet = null;
  const peek = new SheetPeek();
  let zenOn = false;
  let autoZen = false;
  let wasLandscape = viewport.read().landscape;
  let composerFocused = false;
  let composerKeyboard = false;
  /** While the composer's keyboard is up the strips fold; a tap can open them for that stretch. */
  let keyboardFold: boolean | null = null;
  let tailRev = 0;
  let seenInSnapshot = false;
  let exited = false;
  let chatPoll: AbortController | null = null;

  // ── The two-step mount (file header) ──────────────────────────────────────────────────────────
  /** Step two has landed: the composer and the sheets are mounted. */
  let full = loadDraft(scope, paneId).attachments.length > 0;
  let stepTwoArmed = full;
  /** Asked from the first commit: one frame (before the first paint), then a timer (after it). */
  const armStepTwo = (): void => {
    if (handle.signal.aborted) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        if (full || handle.signal.aborted) return;
        full = true;
        scheduleUpdate(handle);
      }, 0);
    });
    handle.signal.addEventListener(
      "abort",
      () => {
        cancelAnimationFrame(frame);
        clearTimeout(timer);
      },
      { once: true },
    );
  };

  let lastBlocks: Block[] | undefined;
  let card: DialogCard | null = null;
  let mirror: StyledLine[] = [];
  let rawDraft: string | null = null;
  /** The agent's statusline rows and background-agents block (agent-chat.tsx `statusLines`, `agentsFooter`). */
  let statusLines: StyledLine[] = [];
  let agentsFooter: StyledLine[] = [];

  const wake = (): void => scheduleUpdate(handle);

  // The newest reply in full over the rows that only hold its end (agent-chat.tsx `useLatestReply`).
  const latest = createLatestReply(paneId, scope, wake, handle.signal);
  let placedFor: { text: string; reply: TranscriptEntry } | null = null;
  let placement: ReplyPlacement | null = null;
  /** A collapsed card is a judgement about ONE message, so it is remembered by uuid. */
  let collapsedReply: string | null = null;

  /** Copy the buffered output (agent-chat.tsx `copyOutput`): the unwrapped text when the read has it.
   *  The row is offered only where `navigator.clipboard` exists; plain HTTP has none (a SecureContext API). */
  const copyOutput = async (): Promise<void> => {
    const data = readPane().data;
    try {
      await navigator.clipboard.writeText(data?.logicalText || (data?.text ?? ""));
      setStatus(t("chat.copyOutput.done"), "success");
    } catch {
      setStatus(t("chat.copyOutput.failed"), "error");
    }
  };

  const setSheet = (next: Sheet): void => {
    sheet = next;
    wake();
  };

  const header = headerOf(handle).owner(handle.signal);
  // The reverse glide finds the dashboard row by the key the row was opened with: its pane path.
  const glideKey = panePath(paneId, scope);
  const goUpHere = (): void => glideBack("pane", glideKey, () => goUp(scope));
  const onFollow = (following: boolean): void => focus.set({ paneId, following });

  const enterZen = (): void => {
    const active = document.activeElement;
    if (active instanceof HTMLElement || active instanceof SVGElement) active.blur();
    sheet = null;
    find.close();
    zenOn = true;
    buzz();
    wake();
  };
  const leaveZen = (): void => {
    zenOn = false;
    autoZen = false;
    wake();
  };
  if (!onServer()) {
    window.addEventListener(
      "keydown",
      (event) => {
        if (zenOn && event.key === "Escape") leaveZen();
      },
      { signal: handle.signal },
    );
  }

  const toggleStrips = (): void => {
    const folded = composerKeyboard ? (keyboardFold ?? true) : stripsCollapsed.get();
    if (composerKeyboard) {
      keyboardFold = !folded;
      wake();
      return;
    }
    stripsCollapsed.set(!folded);
  };

  const herd = (): AgentView[] => {
    const data = readSnapshot().data;
    return [...(data?.agents ?? []), ...(data?.shellPanes ?? [])];
  };
  const goToPane = (pane: AgentView): void => {
    if (pane.paneId === paneId) return;
    const data = readSnapshot().data;
    sheet = null;
    void navigate(href(panePath(pane.paneId, paneScope(scope, pane, data?.servers, data?.sessions))), { history: "replace" });
  };
  const openSpace = (): void => {
    const pane = findPane(readSnapshot().data, paneId);
    if (pane) void navigate(href(spacePath(pane.workspaceId, scope)));
  };
  const loadOlder = (): void => {
    if (olderLoading || lines >= PANE_LINES_MAX) return;
    lines = Math.min(lines + PANE_LINES_STEP, PANE_LINES_MAX);
    olderLoading = true;
    wake();
    void readMirror(new AbortController().signal, lines).finally(() => {
      olderLoading = false;
      wake();
    });
  };
  const onSent = (): void => {
    gate.markSent();
    tailRev++;
    focus.set({ paneId, following: true });
    wake();
  };

  /** The write target as it is NOW: a tap uses the read it was drawn from, never an older one. */
  const target = (): WriteTarget => {
    const pane = findPane(readSnapshot().data, paneId);
    const g = writeGate({
      gone: readPane().status === 404,
      shell: pane?.kind === "shell",
      snapshot: readSnapshot().data,
      config: readConfig().data,
      notPaired: readPairing().refused,
    });
    return {
      paneId,
      scope,
      agent: pane?.agent,
      revision: readPane().data?.revision ?? 0,
      refusal: g.locked ? (g.unpaired ? t("chat.status.readOnly") : g.placeholder) : undefined,
      lines,
    };
  };

  const actions: CardActions = {
    option: (option) => (card?.kind === "prompt-select" ? answerOption(target(), card.block.prompt, option) : Promise.resolve(false)),
    feedback: (text) => (card?.kind === "prompt-select" ? answerFeedback(target(), card.block.prompt, text) : Promise.resolve(false)),
    menu: (keys, nav) => (card?.kind === "menu" ? answerMenu(target(), card.block.menu, keys, nav) : Promise.resolve(false)),
    unread: () => (card?.kind === "unread-dialog" ? answerUnread(target(), card.block.cancel) : Promise.resolve(false)),
    wizard: (keys) => (card?.kind === "wizard" ? answerWizard(target(), card.block.wizard, keys) : Promise.resolve(false)),
    multiSelect: (intent) => (card?.kind === "multi-select" ? answerMultiSelect(target(), card.block.multi, intent) : Promise.resolve(false)),
    preview: (action) => (card?.kind === "preview-select" ? answerPreview(target(), card.block.preview, action) : Promise.resolve(false)),
  };

  // The header slots are made ONCE, so the claim's shallow compare sees the same functions; what
  // they draw is read from these lets at render time, and `rev` tells the header when it moved.
  let identity: IdentityState = {
    name: "",
    workspace: "",
    agent: undefined,
    status: undefined,
    host: undefined,
    session: undefined,
    cache: undefined,
    gone: false,
  };
  const identitySlot = (): CustomSlot["render"] extends () => infer R ? R : never => (
    <PaneIdentity
      {...identity}
      onName={() => setSheet("settings")}
      onWorkspace={openSpace}
      onCache={() => setSheet("cache")}
    />
  );
  const findSlot = (): CustomSlot["render"] extends () => infer R ? R : never => <FindBar find={find} />;
  const openActions = (): void => setSheet("actions");
  const closeFind = (): void => find.close();

  return () => {
    countRender("PaneRoute");
    // A sheet asked for before step two (the header's ⋮ is in step one) mounts the rest at once.
    if (sheet !== null) full = true;
    if (!stepTwoArmed) {
      stepTwoArmed = true;
      handle.queueTask(armStepTwo);
    }
    const read = readPane();
    const snap = readSnapshot();
    const cfg = readConfig().data;
    const dash = readDash();
    const display = readDisplay();
    const data = snap.data;
    const pane = findPane(data, paneId);
    if (pane) seenInSnapshot = true;
    const shell = pane?.kind === "shell";
    const gone = read.status === 404 || (pane === undefined && seenInSnapshot);
    const refused = readPairing().refused || read.status === 401 || snap.status === 401;
    const wg = writeGate({ gone, shell, snapshot: data, config: cfg, notPaired: refused });
    const readOnly = refused || isReadOnly(data?.device);

    // ── Auto-exit (ADR 0067): only on a healthy snapshot taken after this screen opened ────────
    if (!freshSinceMount && snapshotAt.get() > mountedAt) freshSinceMount = true;
    const healthy = data !== undefined && snap.error === undefined && freshSinceMount;
    if (!exited && pane === undefined && healthy && (seenInSnapshot || read.status === 404 || read.data !== undefined)) {
      exited = true;
      handle.queueTask(() => {
        // web/src/routes/detail.tsx says this in English and through no catalog key; kept as is.
        setStatus("Pane closed", "info");
        goUp(scope);
      });
    }

    // ── Blocks: one parse per text, shared with the dashboard's prefetch (parse.ts) ───────────────
    const rawMirror = display.rawTerminal;
    const override = paneMirrorOverride(scope, paneId);
    const native = rendersNativeMirror(pane?.agent, override);
    const text = read.data?.text ?? "";
    frameAgent = parseAgent(pane?.agent, rawMirror);
    const parsed = parseScreen(text, frameAgent);
    if (parsed.blocks !== lastBlocks) {
      lastBlocks = parsed.blocks;
      card = parsed.card;
      mirror = parsed.mirror;
      rawDraft = parsed.rawDraft;
      statusLines = parsed.statusLines;
      agentsFooter = parsed.agentsFooter;
    }

    // ── The chat gate (ADR 0082) ─────────────────────────────────────────────────────────────────
    const chat = readChat();
    const sessionLog = muxCapability(cfg?.mux ?? null, "agentSessionRef");
    const reading = gate.read({
      paneId,
      harness: pane === undefined ? undefined : shell ? "" : pane.agent,
      isShell: shell,
      status: pane?.status,
      hasSession: pane?.hasSession === true,
      chatChosen: dash.paneView === "chat",
      sessionLog: sessionLog.capable,
      chat: chat.window.status,
      asked: chatCounters.asked,
      answered: (gateAnswered = chatCounters.replies.get()),
    });
    if (reading.fetch && chatPoll === null && !handle.signal.aborted) {
      chatPoll = new AbortController();
      const until = chatPoll.signal;
      handle.signal.addEventListener("abort", () => chatPoll?.abort(), { signal: until });
      want({ key: `chat:${key}`, poll: (signal) => pollChat(key, paneId, scope, signal) }, until);
    } else if (!reading.fetch && chatPoll !== null) {
      chatPoll.abort();
      chatPoll = null;
    }
    const chatAnswered = chat.window.status.kind !== "empty" || chat.answered;
    const chatShown = reading.body !== "terminal" && chatAnswered;
    // THE VIEW IS PICKED FROM THE STORED PREFERENCE, BEFORE ANY ANSWER. While Chat is the chosen view
    // and its first answer is out, the screen draws Chat's skeleton, never the mirror: the mirror
    // would show for the 38 ms (a phone: one read) until Chat replaced it. That holds while the
    // snapshot has not yet said what the pane is (the gate cannot pick Chat without a pane row), unless
    // the snapshot already failed, when the Terminal and its notice are the honest screen.
    const chatChosen = dash.paneView === "chat";
    const awaitingPane = pane === undefined && data === undefined && snap.error === undefined;
    const chatSkeleton = chatChosen && !gone && (awaitingPane || (reading.body !== "terminal" && !chatAnswered));
    const historyAvailable = pane?.hasSession === true && sessionLog.capable;
    const chatReason =
      !sessionLog.capable
        ? sessionLog.note || t("history.unavailable.noLog")
        : reading.body !== "terminal"
          ? null
          : reading.journal === "off"
            ? t("history.unavailable.disabled")
            : pane?.hasSession && reading.journal === "missing"
              ? t("history.unavailable.noLog")
              : t("history.unavailable.noSession");
    const chatNote = chatReason === null || dash.paneView !== "chat" ? undefined : t("chat.mode.noChat", { reason: chatReason });

    // ── The terminal's top: History for a session, Load older for scrollback ────────────────────
    const scrollback = muxCapability(cfg?.mux ?? null, "gridScrollback");
    let top: MirrorTop = null;
    if (historyAvailable) top = { kind: "history", onOpen: () => void navigate(href(historyPath(paneId, scope))) };
    else if (scrollback.capable && pane?.readableLines !== undefined && lines < pane.readableLines && lines < PANE_LINES_MAX) {
      top = { kind: "older", loading: olderLoading, onOlder: loadOlder };
    }
    const notes: string[] = [];
    if (!sessionLog.capable && sessionLog.note !== "") notes.push(sessionLog.note);
    if (sessionLog.capable && !shell && hasJournalAdapter(pane?.agent) && pane !== undefined && !pane.hasSession) {
      notes.push(t(reportsSessionOnFirstPrompt(pane.agent) ? "chat.scrollback.noSessionYet" : "chat.scrollback.noSessionReported", { agent: pane.agent }));
    }
    if (dash.paneView === "chat" && reading.body === "terminal" && pane?.hasSession && reading.journal === "missing") notes.push(t("history.unavailable.noLog"));

    // ── Viewport: keyboard, landscape, zen ──────────────────────────────────────────────────────
    const vp = viewport.read();
    if (!vp.keyboard) composerKeyboard = false;
    else if (composerFocused) composerKeyboard = true;
    if (!composerKeyboard) keyboardFold = null;
    const folded = composerKeyboard ? (keyboardFold ?? true) : readStripsPref();
    const zenAvailable = readZenAvailable();
    if (vp.landscape !== wasLandscape) {
      wasLandscape = vp.landscape;
      if (zenAvailable && autoZenSetting()) {
        if (vp.landscape && !zenOn) {
          zenOn = true;
          autoZen = true;
        } else if (!vp.landscape && zenOn && autoZen) {
          zenOn = false;
          autoZen = false;
        }
      }
    }
    if (!zenAvailable && zenOn) zenOn = false;

    // ── Header claim ─────────────────────────────────────────────────────────────────────────────
    const name = pane ? paneName(pane) : paneId;
    identity = {
      name,
      workspace: pane ? panePlaceParts(pane, data?.tabs).space : "",
      agent: shell ? undefined : (pane?.agent ?? ""),
      status: shell ? undefined : pane?.status,
      host: pane?.host,
      session: pane?.session,
      cache: pane?.cache,
      gone,
    };
    const findState = readFind();
    const rev = JSON.stringify(identity);
    handle.queueTask(() =>
      header.claim({
        center: { kind: "custom", render: identitySlot, rev },
        right: { kind: "menu", label: t("chat.paneMenu.aria"), onOpen: gone ? undefined : openActions },
        override: findState.open
          ? { title: "", backLabel: t("find.closeAria"), onBack: closeFind, trailing: { kind: "custom", render: findSlot, rev: "find" } }
          : null,
        hidden: zenOn,
        width: "wide",
        home: goUpHere,
        homeLabel: upPath(scope).startsWith("/space/") ? t("changes.backAria.workspace") : t("changes.backAria.dashboard"),
        glideKey,
      }),
    );

    // ── The newest reply over the rows it covers (agent-chat.tsx `clippedReply`) ───────────────────
    // Read only while the Terminal is the body: the card lives in the mirror and nowhere else.
    const replyOn = historyAvailable && display.expandClippedReply && !chatShown;
    handle.queueTask(() => latest.see(text, replyOn));
    const reply = latest.reply(replyOn);
    if (reply === null) {
      placedFor = null;
      placement = null;
    } else if (placedFor === null || placedFor.text !== text || placedFor.reply !== reply) {
      placedFor = { text, reply };
      placement = locateReply(text, reply);
    }
    // Find searches the mirror, so while it is open the mirror is whole and the card stands down.
    const clippedReply = placement?.fit === "clipped" && !findState.open ? reply : null;
    const replyOpen = clippedReply !== null && collapsedReply !== clippedReply.uuid;
    const hiddenRows = replyOpen && placement !== null ? placement.endLine + 1 : 0;
    const lead =
      clippedReply === null ? undefined : (
        <LatestReplyCard
          key={clippedReply.uuid}
          entry={clippedReply}
          agent={pane?.agent}
          open={replyOpen}
          scope={scope}
          onToggle={() => {
            collapsedReply = replyOpen ? clippedReply.uuid : null;
            wake();
          }}
        />
      );

    // ── One notice at a time, most fundamental first ─────────────────────────────────────────────
    let notice = null;
    if (refused) {
      notice = (
        <a href={href("/settings/device")} class="block" data-testid="pane-unpaired" data-rmx-reset-scroll="false">
          <Notice variant="strip" tone="caution" announce="status" icon={<Icon icon={KeyRound} />}>
            {t("space.readOnly.notPaired")}
          </Notice>
        </a>
      );
    } else if (read.status === 403 || wg.unpaired) {
      notice = (
        <Notice variant="strip" tone="caution" announce="status" icon={<Icon icon={Lock} />}>
          {t("space.readOnly.deviceUnauthorised")}
        </Notice>
      );
    } else if (gone) {
      notice = (
        <div data-testid="pane-gone">
          <Notice variant="strip" tone="neutral" announce="status" icon={<Icon icon={TriangleAlert} />} onActivate={() => goUp(scope)}>
            {t("chat.header.agentGone")}
          </Notice>
        </div>
      );
    } else if (read.error !== undefined && read.status !== 409) {
      notice = (
        <div data-testid="pane-unreachable">
          <Notice
            variant="strip"
            tone="danger"
            announce="alert"
            icon={<Icon icon={WifiOff} />}
            action={
              <button type="button" class="h-6 rounded-sm px-2 text-xs font-medium underline" mix={on("click", () => kick())}>
                {t("connection.retry")}
              </button>
            }
          >
            {read.status === 502 || read.status === 503 ? t("connection.herdrDown") : t("connection.cantReach")}
          </Notice>
        </div>
      );
    }

    const all = herd();
    const notesForQuestions = questionNotes(chat.window.entries, lastBlocks ?? []);
    const face = mirrorFont(display.fontFamily);
    const tabs = data?.tabs ?? [];
    const others = all.filter((p) => p.paneId !== paneId);
    const switcher = others.length > 0 ? { onOpen: () => setSheet("switcher"), peek, label: t("chat.switcher.aria"), needsYou: needsYouElsewhere(pane, all) } : null;
    const hasStrips = pane !== undefined && stripsExist(pane, tabs, all);
    const hostHealth = hostHealthOf(crewOf(data), pane?.host ?? scope.host);
    const hostStale = hostStaleSpeaks(hostHealth);
    const body = chatShown ? "chat" : "terminal";
    // The server frames (S2): the Terminal's rows and the statusline's rows, while the switch is on.
    frameTargets = chatShown ? [STATUS_FRAME] : [SCREEN_FRAME, STATUS_FRAME];
    const framesOn = readFramesOn() && !readLatched();
    const frameSrc = framesOn ? paneFrameSrc(paneId, scope, lines, frameAgent) : undefined;

    return (
      <main class="flex min-h-0 flex-1 flex-col" data-testid="pane-view" data-tab={body} data-body={reading.body} data-zen={zenOn ? "" : undefined}>
        {/* The pane's MACHINE is not answering the lead (tier 2; the tier-1 strip is the band's). Above the
            strips, as in web, and it leaves with zen. Nothing on a solo install or a live host. */}
        <Collapse open={!zenOn && hostStale}>
          <HostStaleBanner health={hostHealth} class="mx-3 mt-1.5" />
        </Collapse>
        <Collapse open={!zenOn && hasStrips}>
          {pane !== undefined ? (
            <Strips
              pane={pane}
              agents={data?.agents ?? []}
              shellPanes={data?.shellPanes ?? []}
              tabs={tabs}
              scope={scope}
              readOnly={readOnly}
              folded={folded}
              onToggleFold={toggleStrips}
              onSelectPane={goToPane}
              onPaneClosed={(id) => (id === paneId ? goUp(scope) : kick())}
              onTabClosed={(tabId) => (pane.tabId === tabId ? goUp(scope) : kick())}
            />
          ) : null}
        </Collapse>
        {/* Zen is the screen and nothing else: the notice leaves with the strips, and comes back with them. */}
        <Collapse open={!zenOn && notice !== null}>{notice}</Collapse>
        <div class="relative flex min-h-0 min-w-0 flex-1 flex-col border-t border-rule">
          {zenOn ? (
            <button
              type="button"
              data-testid="zen-exit"
              aria-label={t("chat.zen.exitAria")}
              class="absolute top-3 right-3 z-30 flex size-11 items-center justify-center rounded-full border border-border bg-background/90 shadow-md backdrop-blur"
              mix={on("click", leaveZen)}
            >
              <Icon icon={Minimize2} class="size-4" />
            </button>
          ) : null}
          {chatSkeleton ? (
            <ScreenSkeleton key="skeleton:chat" kind="chat" />
          ) : chatShown ? (
            <ChatView
              key={`chat:${key}`}
              paneKey={key}
              paneId={paneId}
              scope={scope}
              working={pane?.status === "working"}
              starting={reading.body === "start"}
              showToolCalls={dash.showToolCalls}
              showCompactions={dash.showCompactions}
              fontSize={display.chatFontSize}
              notes={notesForQuestions}
              tailRev={tailRev}
              onFollowChange={onFollow}
            />
          ) : (
            <TerminalView
              key={`terminal:${key}`}
              spotKey={key}
              lines={mirror}
              logicalText={read.data?.logicalText}
              loading={read.data === undefined && read.error === undefined}
              blank={text === ""}
              lead={lead}
              hideLeading={hiddenRows}
              wrap={display.wrap}
              fontSize={display.fontSize}
              native={native}
              faceClass={face.className}
              faceFamily={face.style?.fontFamily}
              find={find}
              frameSrc={frameSrc}
              top={top}
              notes={notes}
              tailRev={tailRev}
              onFollowChange={onFollow}
            />
          )}
        </div>
        <Collapse open={card !== null}>
          {card !== null ? <CardDock card={card} disabled={wg.locked} actions={actions} composing={vp.keyboard} /> : null}
        </Collapse>
        {/* THE BOTTOM REGION, one row of this column that zen takes out whole (agent-chat.tsx): the
            agent's statusline, its background agents, then the chrome block. The two bands stand
            down while the keyboard is up (web's `composing`), through Collapse. */}
        <Collapse open={!zenOn}>
          <div class="relative shrink-0" data-slot="bottom-region">
          <Collapse open={!vp.keyboard && statusLines.length > 0}>
            {statusLines.length > 0 ? (
              <StatusStrip
                rows={statusLines}
                frame={frameSrc === undefined ? undefined : <Frame name={STATUS_FRAME} src={frameSrc} />}
                native={rendersNativeMirror(pane?.agent)}
                faceClass={face.className}
                faceFamily={face.style?.fontFamily}
              />
            ) : null}
          </Collapse>
          <Collapse open={!vp.keyboard && agentsFooter.length > 0}>
            {agentsFooter.length > 0 ? <AgentsFooter rows={agentsFooter} faceClass={face.className} faceFamily={face.style?.fontFamily} /> : null}
          </Collapse>
          {full ? (
          <Composer
            key={`composer:${key}`}
            paneId={paneId}
            scope={scope}
            agent={shell ? undefined : pane?.agent}
            isShell={shell}
            gate={wg}
            dialogOwns={dialogOwnsKeyboard(lastBlocks ?? [])}
            dialogUnread={card?.kind === "unread-dialog"}
            unsupportedKeys={cfg?.mux?.unsupportedKeys ?? []}
            target={target}
            rawDraft={rawDraft}
            paneText={text}
            chatShown={chatShown}
            chatNote={chatNote}
            changes={pane?.cwd ? { label: t("chat.changes.label"), onClick: () => void navigate(href(changesPath(paneId, scope))) } : undefined}
            switcher={switcher}
            onSent={onSent}
            onFocusChange={(focused) => {
              composerFocused = focused;
              wake();
            }}
          />
          ) : (
            <ComposerStandIn key={`composer-standin:${key}`} paneId={paneId} scope={scope} gate={wg} />
          )}
          </div>
        </Collapse>
        {full ? (
        <>
        <PaneActionsSheet
          open={sheet === "actions"}
          onClose={() => setSheet(null)}
          pane={pane ?? null}
          scope={scope}
          readOnly={readOnly}
          herd={all}
          onRenamed={kick}
          onClosed={() => goUp(scope)}
          onFind={text !== "" && !chatShown ? () => find.open() : undefined}
          onHistory={historyAvailable ? () => void navigate(href(historyPath(paneId, scope))) : undefined}
          onCopyOutput={text !== "" && "clipboard" in navigator ? () => void copyOutput() : undefined}
          paneView={dash.paneView}
          onPaneViewChange={(view) => setDashPref("paneView", view)}
          paneViewNote={chatNote}
          onSettings={() => setSheet("settings")}
          onZen={zenAvailable && text !== "" ? enterZen : undefined}
        />
        <PaneSettingsSheet open={sheet === "settings"} onClose={() => setSheet(null)} pane={pane ?? null} scope={scope} />
        <CacheSheet open={sheet === "cache"} onClose={() => setSheet(null)} cache={pane?.cache} host={pane?.host} />
        <SwitcherSheet
          open={sheet === "switcher"}
          onClose={() => setSheet(null)}
          peek={peek}
          here={pane}
          agents={data?.agents ?? []}
          shellPanes={data?.shellPanes ?? []}
          scope={scope}
          readOnly={readOnly}
          onPick={goToPane}
        />
        </>
        ) : null}
      </main>
    );
  };
}
