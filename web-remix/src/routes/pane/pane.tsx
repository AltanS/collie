// The pane screen, `/pane/:paneId`: header, the Chat or Terminal body, the lifted dialog card, the
// status line and the composer. Port of web/src/routes/pane.tsx + components/agent-chat.tsx.
//
// DATA. The mirror is polled through web's `fetchPane` into the shell's `paneStore` (data.ts says
// why); the snapshot and the config come from the shell's own sources. The open pane is published
// to `focus`, so the scheduler polls it hot while the view follows the tail, and every write calls
// `noteSend` (answer.ts) for the 300 ms burst.
//
// BLOCKS. One screen is parsed once per text (web's `parseAnsi` → `splitLines` → `buildBlocks`
// with the pane's agent string). The first dialog block becomes the card (cards.ts); the rest is the
// mirror the Terminal tab draws. Nothing here names a harness or a multiplexer.
import { on, type Handle } from "remix/component";
import { KeyRound, Lock, TriangleAlert, WifiOff } from "lucide";

import { isNotPaired as webRefused, subscribePairing } from "@web/lib/pairing";
import { paneScopeKey } from "@web/lib/scope";
import { t } from "@web/lib/i18n";
import type { Block, StyledLine } from "@web/lib/blocks";
import { paneName } from "@web/lib/pane-name";

import { address, config, paneStore, snapshot } from "../../lib/data";
import { focus, kick, want } from "../../lib/polling";
import { clearNotPaired, markNotPaired, pairing } from "../../lib/pairing";
import { dashPrefs } from "../../lib/prefs";
import { setStatus } from "../../lib/status";
import { useStore } from "../../lib/store";
import { href } from "../../routes";
import { headerOf } from "../../shell/context";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import { Notice } from "../../ui/notice";
import { answerFeedback, answerMenu, answerOption, answerUnread, type WriteTarget } from "./answer";
import { goUp, upPath } from "./back";
import { dialogCardOf, dialogOwnsKeyboard, mirrorLines, type DialogCard } from "./cards";
import { ChatView } from "./chat";
import { chatStore } from "./chat-store";
import { Composer } from "./composer";
import { blockBuilder, findPane, pollPane, writeGate } from "./data";
import { CardDock, type CardActions } from "./dialog-card";
import { clearPaneStatus, paneStatus } from "./status";
import { TerminalView } from "./terminal";

type PaneTab = "chat" | "terminal";

export function PaneRoute(handle: Handle<{ paneId: string }>) {
  const { scope } = address.get();
  const paneId = handle.props.paneId;
  const key = paneScopeKey(scope, paneId);
  const store = paneStore(key);
  want({ key: `pane-screen:${key}`, poll: (signal) => pollPane(key, paneId, scope, signal) }, handle.signal);
  focus.set({ paneId, following: true });

  // Every write on this screen goes through web's api.ts (the guarded taps, the reply, the keys),
  // which reads each answer into WEB's pairing latch (`notePairing`: a 403 "device not paired" sets
  // it, a 2xx write clears it). This shell keeps its own latch (lib/pairing.ts) that every other
  // screen reads, so each move of web's latch is carried into it: a refusal seen here shows the
  // pairing notice everywhere, and a write that went through clears it everywhere.
  const unsubscribe = subscribePairing(() => (webRefused() ? markNotPaired() : clearNotPaired()));
  handle.signal.addEventListener("abort", () => {
    unsubscribe();
    clearPaneStatus();
    if (focus.get().paneId === paneId) focus.set({ paneId: null, following: true });
  });

  const readPane = useStore(handle, store);
  const readSnapshot = useStore(handle, snapshot);
  const readConfig = useStore(handle, config);
  // The header is the Shell's; this route claims it (REMIX3.md rule 6). The status line moved into
  // the header's title slot (web/'s HeaderStatus): every pane status is published to lib/status.
  const header = headerOf(handle).owner(handle.signal);
  const goUpHere = (): void => goUp(scope);
  paneStatus.subscribe(() => {
    const said = paneStatus.get();
    if (said) setStatus(said.text, said.tone);
  }, handle.signal);
  const readView = useStore(handle, dashPrefs);
  const readPairing = useStore(handle, pairing);
  const readChat = useStore(handle, chatStore(key));

  const blocksOf = blockBuilder();
  let lastBlocks: Block[] | undefined;
  let card: DialogCard | null = null;
  let mirror: StyledLine[] = [];

  const onFollow = (following: boolean): void => focus.set({ paneId, following });

  /** The write target as it is NOW: a tap uses the read it was drawn from, never an older one. */
  const target = (): WriteTarget => {
    const pane = findPane(readSnapshot().data, paneId);
    const gate = writeGate({
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
      refusal: gate.locked ? (gate.unpaired ? t("chat.status.readOnly") : gate.placeholder) : undefined,
    };
  };

  const actions: CardActions = {
    option: (option) => (card?.kind === "prompt-select" ? answerOption(target(), card.block.prompt, option) : Promise.resolve(false)),
    feedback: (text) => (card?.kind === "prompt-select" ? answerFeedback(target(), card.block.prompt, text) : Promise.resolve(false)),
    menu: (keys, nav) => (card?.kind === "menu" ? answerMenu(target(), card.block.menu, keys, nav) : Promise.resolve(false)),
    unread: () => (card?.kind === "unread-dialog" ? answerUnread(target(), card.block.cancel) : Promise.resolve(false)),
  };

  return () => {
    const read = readPane();
    const snap = readSnapshot();
    const pane = findPane(snap.data, paneId);
    const shell = pane?.kind === "shell";
    const gone = read.status === 404;
    const refused = readPairing().refused || read.status === 401 || snap.status === 401;
    const gate = writeGate({ gone, shell, snapshot: snap.data, config: readConfig().data, notPaired: refused });

    const blocks = blocksOf(read.data?.text ?? "", pane?.agent);
    if (blocks !== lastBlocks) {
      lastBlocks = blocks;
      card = dialogCardOf(blocks);
      mirror = mirrorLines(blocks);
    }

    // Chat when the pane has a session to read; the terminal otherwise, and whenever the server
    // says it cannot read this pane at all (reading off, or a member too old for the chat route).
    const chatStatus = readChat().window.status;
    const chatOff = chatStatus.kind === "stale" || (chatStatus.kind === "unavailable" && chatStatus.reason === "disabled");
    const canChat = pane !== undefined && !shell;
    // The view is a device pref (`paneView`, ADR 0082), switched in the ⋮ sheet; no tab bar.
    const tab: PaneTab = canChat && pane.hasSession === true && !chatOff && readView().paneView === "chat" ? "chat" : "terminal";

    // One notice at a time, most fundamental first.
    let notice = null;
    if (refused) {
      notice = (
        <a href={href("/settings/device")} class="block" data-testid="pane-unpaired">
          <Notice variant="strip" tone="caution" announce="status" icon={<Icon icon={KeyRound} />}>
            {t("space.readOnly.notPaired")}
          </Notice>
        </a>
      );
    } else if (read.status === 403 || gate.unpaired) {
      notice = (
        <Notice variant="strip" tone="caution" announce="status" icon={<Icon icon={Lock} />}>
          {t("space.readOnly.deviceUnauthorised")}
        </Notice>
      );
    } else if (gone) {
      notice = (
        <div data-testid="pane-gone">
          <Notice
            variant="strip"
            tone="neutral"
            announce="status"
            icon={<Icon icon={TriangleAlert} />}
            onActivate={() => goUp(scope)}
          >
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

    const name = gone ? t("chat.header.agentGone") : pane ? paneName(pane) : paneId;
    handle.queueTask(() =>
      header.claim({
        center: { kind: "pane", name, workspace: pane?.workspaceLabel ?? "", status: shell ? undefined : pane?.status, agent: shell ? "" : (pane?.agent ?? "") },
        right: { kind: "menu", label: t("chat.paneMenu.aria") },
        width: "wide",
        home: goUpHere,
        homeLabel: upPath(scope).startsWith("/space/") ? t("changes.backAria.workspace") : t("changes.backAria.dashboard"),
        glideKey: key,
      }),
    );
    const unreadKey = card?.kind === "unread-dialog" ? card.keyName : "";
    return (
      <main class="flex min-h-0 flex-1 flex-col" data-testid="pane-view" data-tab={tab}>
        <Collapse open={notice !== null}>{notice}</Collapse>
        {tab === "chat" ? (
          <ChatView
            key={`chat:${key}`}
            paneKey={key}
            paneId={paneId}
            scope={scope}
            working={pane?.status === "working"}
            onFollowChange={onFollow}
          />
        ) : (
          <TerminalView
            key={`terminal:${key}`}
            spotKey={key}
            lines={mirror}
            loading={read.at === 0 && read.error === undefined}
            onFollowChange={onFollow}
          />
        )}
        <Collapse open={card !== null}>{card !== null ? <CardDock card={card} disabled={gate.locked} actions={actions} /> : null}</Collapse>
        <Composer
          key={`composer:${key}`}
          paneId={paneId}
          scope={scope}
          gate={gate}
          dialogOwns={dialogOwnsKeyboard(lastBlocks ?? [])}
          dialogUnread={card?.kind === "unread-dialog"}
          unreadKey={unreadKey}
          unsupportedKeys={readConfig().data?.mux?.unsupportedKeys ?? []}
          target={target}
        />
      </main>
    );
  };
}
