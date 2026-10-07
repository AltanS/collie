// THE PANE'S SCREEN ISLAND (S3): the strips, the notice, the Terminal over its `pane-screen` server
// frame, the docked dialog card, the statusline and the background agents. What the static shell's
// pane route (routes/pane/pane.tsx) draws between the header and the composer, from the same reads and
// the same leaf components, with three parts moved out:
//
//   - the header: its identity is server HTML in the `pane-head` frame (ssr/islands-layout.tsx), its ⋮
//     and the find bar are the `header-actions` island;
//   - the composer: the `composer` island (islands/composer.tsx), keyed by pane;
//   - the four sheets: the `sheets` island (islands/sheets.tsx).
//
// They meet in the pane controller (islands/pane-controller.ts), which this island opens for its pane
// and publishes to after each commit. The island is keyed by pane in the document (`data-rmx-key`), so
// a sideways move builds a new instance with its own setup, as the static shell's keyed route does.
//
// TERMINAL ONLY. An islands document is drawn for the Terminal view with the pane frames on; a pane
// whose chosen view is Chat, or a device with the frames off, gets the static shell's document (the
// bridge decides, ssr/islands-document.tsx). The frames latching off mid-page (an answer that is not
// the frame route's) therefore loads the page again as that document (`?islands=0`).
//
// NO HARNESS ON THE FIRST SCREEN. A frames read carries the screen model, parsed by
// routes/pane/parse-model.ts; the text parse (routes/pane/parse.ts, with every grammar) loads only for a
// read that carries its text, which only the find bar asks for. The writes load on the first write
// (routes/pane/answer-lazy.ts).
import { clientEntry, Frame, on, type Handle } from "remix/component";
import { KeyRound, Lock, Minimize2, TriangleAlert, WifiOff } from "lucide";

import { mirrorFont } from "@web/hooks/use-display-prefs";
import type { Block, StyledLine } from "@web/lib/blocks";
import { rendersNativeMirror } from "@web/lib/harness/muse/display";
import { hasJournalAdapter, reportsSessionOnFirstPrompt } from "@web/lib/journal-agents";
import { t } from "@web/lib/i18n";
import { locateReply, type ReplyPlacement } from "@web/lib/latest-reply";
import { fetchPane } from "@web/lib/api";
import { paneMirrorOverride } from "@web/lib/mirror-invert";
import { muxCapability } from "@web/lib/mux-capability";
import { historyPath, panePath } from "@web/lib/nav";
import { isNotPaired as webRefused, subscribePairing } from "@web/lib/pairing";
import { paneScope } from "@web/lib/hosts";
import { paneScopeKey } from "@web/lib/scope";
import { isReadOnly, type AgentView, type TranscriptEntry } from "@web/lib/types";

import { crewOf, hostHealthOf } from "../chips/crew";
import { address, config, paneStore, snapshot, snapshotAt } from "../lib/data";
import { createFind } from "../lib/find";
import { glideBack } from "../lib/glide";
import { useLocale } from "../lib/i18n-store";
import { clearNotPaired, markNotPaired, pairing } from "../lib/pairing";
import { focus, kick, want } from "../lib/polling";
import { buzz, displayPrefs, stripsCollapsed, zen as zenPref } from "../lib/prefs";
import { countRender } from "../lib/render-count";
import { setStatus } from "../lib/status";
import { onServer } from "../lib/server-render";
import { createStore, scheduleUpdate, useStore } from "../lib/store";
import { navigate } from "../lib/navigate";
import { href } from "../routes";
import { HostStaleBanner, hostStaleSpeaks } from "../shell/connection-banner";
import { ShellProvider } from "../shell/context";
import { Collapse } from "../ui/collapse";
import { Icon } from "../ui/icon";
import { Notice } from "../ui/notice";
import type { WriteTarget } from "../routes/pane/answer";
import {
  lazyAnswerFeedback,
  lazyAnswerMenu,
  lazyAnswerMultiSelect,
  lazyAnswerOption,
  lazyAnswerPreview,
  lazyAnswerUnread,
  lazyAnswerWizard,
} from "../routes/pane/answer-lazy";
import { goUp } from "../routes/pane/back";
import { dialogOwnsKeyboard, type DialogCard } from "../routes/pane/cards";
import { findPane, PANE_LINES, PANE_LINES_MAX, PANE_LINES_STEP, writeGate } from "../routes/pane/data";
import { CardDock, type CardActions } from "../routes/pane/dialog-card";
import { SCREEN_FRAME, STATUS_FRAME, type PaneFrameName, type ReplyProbe } from "../routes/pane/frames";
import { bindPaneFrames, framesLatched, paneFrameSrc, pollPaneFrames } from "../routes/pane/pane-frames";
import { createLatestReply, LatestReplyCard } from "../routes/pane/latest-reply";
import { parseAgent, parseModel, screenToken, type ScreenParse } from "../routes/pane/parse-model";
import { askForReply, placementOf, type ReplyAsk } from "../routes/pane/reply-ask";
import { AgentsFooter, StatusStrip } from "../routes/pane/statusline";
import { Strips, stripsExist } from "../routes/pane/strips";
import { ScreenSkeleton, TerminalView, type MirrorTop } from "../routes/pane/terminal";
import { watchViewport, autoZenSetting } from "../routes/pane/viewport";
import type { PaneRead } from "../lib/pane-read";
import { ISLAND } from "./ids";
import { islandShellModels } from "./shell-models";
import { noteSent, openPaneController, type PaneController } from "./pane-controller";

export interface PaneScreenIslandProps {
  paneId: string;
}

// ── The text parse, on demand ───────────────────────────────────────────────────────────────────────

type TextParse = typeof import("../routes/pane/parse");
let textParse: TextParse | null = null;
const textParseLoaded = createStore(false);
let textParseLoading: Promise<TextParse> | null = null;

function loadTextParse(): Promise<TextParse> {
  textParseLoading ??= import("../routes/pane/parse").then((mod) => {
    textParse = mod;
    textParseLoaded.set(true);
    return mod;
  });
  return textParseLoading;
}

const NO_LINES: StyledLine[] = [];
const WAITING: ScreenParse = {
  blocks: [],
  card: null,
  mirror: NO_LINES,
  rawDraft: null,
  statusLines: NO_LINES,
  agentsFooter: NO_LINES,
  mirrorRows: 0,
  statusRows: 0,
};

/** The parse of a read: its model, or its text once the text parse is here (else nothing yet). */
function parseIslandRead(read: PaneRead | undefined, agent: string | undefined): ScreenParse {
  if (read?.screen !== undefined) return parseModel(read.screen);
  if (read === undefined) return WAITING;
  if (textParse !== null) return textParse.parseScreen(read.text, agent);
  void loadTextParse();
  return WAITING;
}

export const PaneScreenIsland = clientEntry(ISLAND.screen, function PaneScreenIsland(handle: Handle<PaneScreenIslandProps>) {
  useLocale(handle);
  const { scope } = address.get();
  const paneId = handle.props.paneId;
  const key = paneScopeKey(scope, paneId);
  const store = paneStore(key);
  const mountedAt = Date.now();

  let lines = PANE_LINES;
  let olderLoading = false;
  const agentNow = (): string | undefined => parseAgent(findPane(snapshot.get().data, paneId)?.agent, displayPrefs.get().rawTerminal);
  let frameAgent = agentNow();
  const frameTargets: readonly PaneFrameName[] = [SCREEN_FRAME, STATUS_FRAME];
  const find = createFind();
  let findOpening = false;
  let replyProbe: ReplyProbe | undefined;
  const readMirror = (signal: AbortSignal, window: number): Promise<boolean> => {
    frameAgent = agentNow();
    const text = findOpening || find.state.get().open;
    return pollPaneFrames({ key, paneId, scope, lines: window, agent: frameAgent, targets: frameTargets, text, probe: replyProbe }, signal);
  };

  const readPane = useStore(handle, store);
  const readSnapshot = useStore(handle, snapshot);
  const readConfig = useStore(handle, config);
  const readDisplay = useStore(handle, displayPrefs);
  const readPairing = useStore(handle, pairing);
  const readStripsPref = useStore(handle, stripsCollapsed);
  const readZenAvailable = useStore(handle, zenPref);
  const readFind = useStore(handle, find.state);
  const readLatched = useStore(handle, framesLatched);
  useStore(handle, textParseLoaded);

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

  // On the server the island only draws: no poll source, no controller, no listener (lib/server-render.ts).
  const controller: PaneController | null = onServer() ? null : openPaneController({ paneId, scope, key, find, target }, handle.signal);
  const readUi = controller === null ? null : useStore(handle, controller.ui);

  if (!onServer()) {
    want({ key: `pane-screen:${key}`, poll: (signal) => readMirror(signal, lines) }, handle.signal);
    focus.set({ paneId, following: true });
    bindPaneFrames({ frame: (name) => handle.frames.get(name), src: () => paneFrameSrc(paneId, scope, lines, frameAgent) }, handle.signal);
    const unsubscribe = subscribePairing(() => (webRefused() ? markNotPaired() : clearNotPaired()));
    handle.signal.addEventListener("abort", () => {
      unsubscribe();
      if (focus.get().paneId === paneId) focus.set({ paneId: null, following: true });
    });
  }

  let freshSinceMount = false;
  handle.queueTask(() => {
    if (handle.signal.aborted || onServer()) return;
    snapshotAt.subscribe(() => {
      if (freshSinceMount || snapshotAt.get() <= mountedAt) return;
      freshSinceMount = true;
      if (findPane(snapshot.get().data, paneId) === undefined) scheduleUpdate(handle);
    }, handle.signal);
  });
  const viewport = onServer() ? { read: () => ({ keyboard: false, landscape: false }) } : watchViewport(() => scheduleUpdate(handle), handle.signal);

  let wasLandscape = viewport.read().landscape;
  let autoZen = false;
  let composerKeyboard = false;
  let keyboardFold: boolean | null = null;
  let seenInSnapshot = false;
  let exited = false;
  let lastBlocks: Block[] | undefined;
  let card: DialogCard | null = null;
  let parsed: ScreenParse = WAITING;
  let askedAgain: string | undefined | null = null;

  const wake = (): void => scheduleUpdate(handle);
  const latest = createLatestReply(paneId, scope, wake, handle.signal);
  let placedFor: { token: string; reply: TranscriptEntry } | null = null;
  let placement: ReplyPlacement | null = null;
  let replyAsk: { reply: TranscriptEntry; ask: ReplyAsk } | null = null;
  let collapsedReply: string | null = null;

  const glideKey = panePath(paneId, scope);
  const goUpHere = (): void => glideBack("pane", glideKey, () => goUp(scope));
  const onFollow = (following: boolean): void => focus.set({ paneId, following });

  const setZen = (zen: boolean): void => controller?.ui.update((ui) => ({ ...ui, zen }));
  const enterZen = (): void => {
    const active = document.activeElement;
    if (active instanceof HTMLElement || active instanceof SVGElement) active.blur();
    find.close();
    setZen(true);
    buzz();
  };
  const leaveZen = (): void => {
    autoZen = false;
    setZen(false);
  };
  if (!onServer()) {
    window.addEventListener(
      "keydown",
      (event) => {
        if (controller?.ui.get().zen === true && event.key === "Escape") leaveZen();
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
    void navigate(href(panePath(pane.paneId, paneScope(scope, pane, data?.servers, data?.sessions))), { history: "replace" });
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

  const copyOutput = async (): Promise<void> => {
    try {
      const held = readPane().data;
      const data = held?.screen === undefined ? held : await fetchPane(paneId, lines, scope);
      await navigator.clipboard.writeText(data?.logicalText || (data?.text ?? ""));
      setStatus(t("chat.copyOutput.done"), "success");
    } catch {
      setStatus(t("chat.copyOutput.failed"), "error");
    }
  };
  /** Find searches the mirror's text, which a frames read does not carry: read it (and its parse) first. */
  const openFind = async (): Promise<void> => {
    const parse = loadTextParse();
    if (readPane().data?.screen !== undefined) {
      findOpening = true;
      try {
        await readMirror(new AbortController().signal, lines);
      } finally {
        findOpening = false;
      }
      if (readPane().data?.screen !== undefined) return;
    }
    await parse;
    find.open();
  };

  if (controller !== null) {
    Object.assign(controller.acts, { openFind, copyOutput, enterZen, leaveZen, goToPane, goUp: goUpHere });
    controller.ui.subscribe(() => {
      const focused = controller.ui.get().composerFocused;
      if (focused !== composerFocusedSeen) {
        composerFocusedSeen = focused;
        wake();
      }
    }, handle.signal);
  }
  let composerFocusedSeen = false;

  const actions: CardActions = {
    option: (option) => (card?.kind === "prompt-select" ? lazyAnswerOption(target(), card.block.prompt, option) : Promise.resolve(false)),
    feedback: (text) => (card?.kind === "prompt-select" ? lazyAnswerFeedback(target(), card.block.prompt, text) : Promise.resolve(false)),
    menu: (keys, nav) => (card?.kind === "menu" ? lazyAnswerMenu(target(), card.block.menu, keys, nav) : Promise.resolve(false)),
    unread: () => (card?.kind === "unread-dialog" ? lazyAnswerUnread(target(), card.block.cancel) : Promise.resolve(false)),
    wizard: (keys) => (card?.kind === "wizard" ? lazyAnswerWizard(target(), card.block.wizard, keys) : Promise.resolve(false)),
    multiSelect: (intent) => (card?.kind === "multi-select" ? lazyAnswerMultiSelect(target(), card.block.multi, intent) : Promise.resolve(false)),
    preview: (action) => (card?.kind === "preview-select" ? lazyAnswerPreview(target(), card.block.preview, action) : Promise.resolve(false)),
  };

  return () => {
    countRender("PaneScreenIsland");
    // The frames went off for this page: this document cannot draw the rows. Load it as the static
    // shell's (see the file header).
    if (readLatched() && !onServer()) {
      handle.queueTask(() => {
        const url = new URL(window.location.href);
        url.searchParams.set("islands", "0");
        window.location.assign(url.href);
      });
    }
    const ui = readUi?.() ?? { zen: false, composerFocused: false, tailRev: 0 };
    const zenOn = ui.zen;
    const read = readPane();
    const snap = readSnapshot();
    const cfg = readConfig().data;
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
        setStatus("Pane closed", "info");
        goUp(scope);
      });
    }

    const override = paneMirrorOverride(scope, paneId);
    const native = rendersNativeMirror(pane?.agent, override);
    const text = read.data?.text ?? "";
    const token = screenToken(read.data);
    frameAgent = parseAgent(pane?.agent, display.rawTerminal);
    const next = parseIslandRead(read.data, frameAgent);
    if (read.data?.screen !== undefined && read.data.screen.agent !== frameAgent && askedAgain !== frameAgent && !onServer()) {
      askedAgain = frameAgent;
      handle.queueTask(kick);
    }
    if (next.blocks !== lastBlocks || next !== parsed) {
      lastBlocks = next.blocks;
      parsed = next;
      card = next.card;
    }

    const sessionLog = muxCapability(cfg?.mux ?? null, "agentSessionRef");
    const historyAvailable = pane?.hasSession === true && sessionLog.capable;
    const scrollback = muxCapability(cfg?.mux ?? null, "gridScrollback");
    let top: MirrorTop = null;
    // History is a static-shell route: a document load (an islands document draws `/` and `/pane/:id` only).
    if (historyAvailable) top = { kind: "history", onOpen: () => window.location.assign(href(historyPath(paneId, scope))) };
    else if (scrollback.capable && pane?.readableLines !== undefined && lines < pane.readableLines && lines < PANE_LINES_MAX) {
      top = { kind: "older", loading: olderLoading, onOlder: loadOlder };
    }
    const notes: string[] = [];
    if (!sessionLog.capable && sessionLog.note !== "") notes.push(sessionLog.note);
    if (sessionLog.capable && !shell && hasJournalAdapter(pane?.agent) && pane !== undefined && !pane.hasSession) {
      notes.push(t(reportsSessionOnFirstPrompt(pane.agent) ? "chat.scrollback.noSessionYet" : "chat.scrollback.noSessionReported", { agent: pane.agent }));
    }

    // ── Viewport: keyboard, landscape, zen ──────────────────────────────────────────────────────
    const vp = viewport.read();
    if (!vp.keyboard) composerKeyboard = false;
    else if (ui.composerFocused) composerKeyboard = true;
    if (!composerKeyboard) keyboardFold = null;
    const folded = composerKeyboard ? (keyboardFold ?? true) : readStripsPref();
    const zenAvailable = readZenAvailable();
    if (vp.landscape !== wasLandscape) {
      wasLandscape = vp.landscape;
      if (zenAvailable && autoZenSetting()) {
        if (vp.landscape && !zenOn) {
          autoZen = true;
          handle.queueTask(() => setZen(true));
        } else if (!vp.landscape && zenOn && autoZen) {
          autoZen = false;
          handle.queueTask(() => setZen(false));
        }
      }
    }
    if (!zenAvailable && zenOn) handle.queueTask(() => setZen(false));

    // ── The newest reply over the rows it covers ─────────────────────────────────────────────────
    const replyOn = historyAvailable && display.expandClippedReply;
    if (!onServer()) handle.queueTask(() => latest.see(token, replyOn));
    const reply = latest.reply(replyOn);
    if (reply === null) {
      placedFor = null;
      placement = null;
      replyAsk = null;
      replyProbe = undefined;
    } else {
      if (replyAsk === null || replyAsk.reply !== reply) {
        replyAsk = { reply, ask: askForReply(reply) };
        replyProbe = replyAsk.ask.kind === "probe" ? replyAsk.ask.probe : undefined;
        if (replyProbe !== undefined && read.data?.screen !== undefined) handle.queueTask(kick);
      }
      const screen = read.data?.screen;
      if (screen !== undefined) {
        placement = placementOf(screen, replyAsk.ask);
        placedFor = null;
      } else if (placedFor === null || placedFor.token !== token || placedFor.reply !== reply) {
        placedFor = { token, reply };
        placement = locateReply(text, reply);
      }
    }
    const findState = readFind();
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
        <a href={href("/settings/device")} class="block" data-testid="pane-unpaired" data-rmx-document="">
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
    const face = mirrorFont(display.fontFamily);
    const tabs = data?.tabs ?? [];
    const hasStrips = pane !== undefined && stripsExist(pane, tabs, all);
    const hostHealth = hostHealthOf(crewOf(data), pane?.host ?? scope.host);
    const hostStale = hostStaleSpeaks(hostHealth);
    const frameSrc = readLatched() ? undefined : paneFrameSrc(paneId, scope, lines, frameAgent);
    const statusRows = parsed.statusRows;
    const agentsFooter = parsed.agentsFooter;

    // What the composer, the sheets and the header read (islands/pane-controller.ts), after the commit.
    if (controller !== null) {
      const view = {
        pane,
        card,
        dialogOwns: dialogOwnsKeyboard(lastBlocks ?? []),
        rawDraft: parsed.rawDraft,
        token,
        gate: wg,
        readOnly,
        herd: all,
        changes: pane?.cwd !== undefined && pane.cwd !== "",
        history: historyAvailable,
        zenAvailable,
        hasText: token !== "",
      };
      handle.queueTask(() => controller.view.set(view));
    }

    return (
      <ShellProvider models={islandShellModels()}>
        <div class="contents" data-testid="pane-screen-island" data-zen={zenOn ? "" : undefined}>
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
            {read.data === undefined && read.error === undefined && frameSrc === undefined ? (
              <ScreenSkeleton key="skeleton:terminal" kind="terminal" />
            ) : (
              <TerminalView
                key={`terminal:${key}`}
                spotKey={key}
                lines={parsed.mirror}
                heldScreen={{ rows: parsed.mirrorRows, rev: token }}
                logicalText={read.data?.logicalText}
                loading={read.data === undefined && read.error === undefined}
                blank={token === ""}
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
                tailRev={ui.tailRev}
                onFollowChange={onFollow}
              />
            )}
          </div>
          <Collapse open={card !== null}>
            {card !== null ? <CardDock card={card} disabled={wg.locked} actions={actions} composing={vp.keyboard} /> : null}
          </Collapse>
          <Collapse open={!zenOn}>
            <div class="relative shrink-0" data-slot="bottom-bands">
              <Collapse open={!vp.keyboard && statusRows > 0}>
                {statusRows > 0 ? (
                  <StatusStrip
                    rows={parsed.statusLines}
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
            </div>
          </Collapse>
        </div>
      </ShellProvider>
    );
  };
});

export { noteSent };
