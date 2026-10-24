import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Loader2, Send, Settings2 } from "lucide-react";

import { ActionsRow, type Hand } from "@/components/actions-row";
import { useDurableBarItems } from "@/components/harness-bar";
import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { TOOLBAR_TAP_TARGET } from "@/components/ui/tap-target";
import { useLocale } from "@/hooks/use-locale";
import { SendRefusalNotice, phoneRefusal, programRefusal, type SendRefusal } from "@/components/send-notice";
import { NOTICE_ACTION } from "@/components/ui/notice";
import { Collapse } from "@/components/ui/collapse";
import { abortPane, apiErrorStatus, postProgramSend, runPaneAction, sendToPane, type ControlResult } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { clearDraft, loadDraft, saveDraft } from "@/lib/drafts";
import { addPending, dropNotSent, setPendingState } from "@/lib/durable-pending";
import {
  controlTarget,
  intentKey,
  noteKey,
  readControl,
  readThrown,
  requestIdFor,
  steerOffered,
  stopOffered,
  type ControlKind,
  type IntentId,
} from "@/lib/durable-control";
import { t } from "@/lib/i18n";
import { isLead, paneScopeKey, type Scope } from "@/lib/scope";
import { textRouteFor } from "@/lib/send-path";
import { readSend, type SendReply } from "@/lib/send-protocol";
import type { SendRequestBody } from "@/lib/surface/send";
import { setStatus } from "@/lib/status";
import type { AgentStatus, Ask, PaneAction } from "@/lib/types";
import { cn } from "@/lib/utils";
import { mintRequestId } from "@/lib/worktree-name";

// THE COMPOSER OF A PANE WITH NO SCREEN (ADR 0101).
//
// A durable conversation has no terminal, so none of the terminal composer's machinery applies to it:
// no typed keys, no read-back of an input box, no key dock, no direct typing, no quick keys, no
// destructive-text confirm that reads shell lines. What it does have is a program that keeps its own
// turns. So this composer is its own, small component, and the terminal composer (composer.tsx) is
// left alone for every pane that has a screen.
//
// Three things leave it, and each is a tap:
//
//   * SEND posts the text to the send route with the turn id the phone saw (or, with no turn yet,
//     the oldest open ask), and a request id minted for the intent. A STALE name comes back 409: the
//     pane is read again, the person is told the turn moved, and THE DRAFT STAYS, so nothing typed on
//     a phone thumb is lost to a race.
//   * STEER is a switch in the program's section of the belt: it says the text is for the turn that
//     is running. It is dimmed and reads as off while no turn runs, and it is off after every send.
//   * STOP posts the abort route with the same name. It is in the same section, and dimmed while
//     there is nothing to stop.
//
// STEER AND STOP NEVER COME AND GO (M51 spec 08). They used to share a row above the field that
// opened and closed with the pane's state, and the field jumped with it. They are the program's own
// section of the belt now (components/harness-bar.tsx `DurableBar`), drawn from the caps the program
// declares (`caps.steer`, `caps.abort`), and a button that cannot act is dimmed in place. The field
// is the same height in every state.
//
// A RETRY IS THE SAME INTENT. After an unknown outcome (a dropped reply, a 504) "send again" carries
// the SAME request id while the text, the switch and the name are unchanged, so the bridge answers
// from its receipt and the program is never told twice (lib/durable-control.ts `requestIdFor`).
//
// SENDING SHOWS AT ONCE (M53 spec 10). A durable program writes the person's line into the thread only when the
// next read carries it, a second or two later, so a tap used to look like nothing happened. Now:
//
//   * The line goes into the thread the moment Send is tapped, as a PENDING line keyed by the request id of the
//     send (lib/durable-pending.ts), drawn in the user's well at a lower weight with a small clock. The program's
//     own `user` item replaces it when it arrives, matched by that request id.
//   * The words leave the field and the field is HELD, with "Sending…" in it, until the POST returns. A send is one
//     POST, so the hold is short. It is never a long lock.
//   * If the send did not land, the words come back to the field and the pending line says why: "Not sent" when the
//     turn had moved or the program refused, "Sending, not confirmed" when the answer never came (the retry then
//     carries the same request id, so the program is told once).
//
// THE SEND PROTOCOL ON THIS MACHINE (M56 spec 14). When the bridge marks the pane with `sendProtocol` and
// the program runs on this machine, a plain send is one Send Protocol request (`POST /api/send`), run by
// the bridge's structured driver. It names the Surface revision the phone saw, so a turn that moved is
// refused before the program is asked. The answer is told with the terminal composer's own notice at
// the thumb (components/send-notice.tsx), and a send the program takes for after its turn says Queued.
// Steer and Stop stay on the program's own routes: a steer is not part of the Send Protocol. A program
// on a crew member keeps the program's own send route (lib/send-path.ts).
//
// The belt keeps what is not about a screen: the Display button, the Switch pill and the Changes
// pill. The Keys, Type and Quick buttons are not drawn, because there is nothing for them to type
// into.

export interface DurableComposerProps {
  paneId: string;
  scope?: Scope;
  /** What the pane has shown that a control may name: its newest turn and its open asks. */
  turnId?: string;
  asks?: readonly Ask[];
  /** The buttons the pane's program lists for the belt (M53 spec 07), in its order. */
  actions?: readonly PaneAction[];
  status?: AgentStatus;
  /** The bridge marks the pane for the Send Protocol (the snapshot's `sendProtocol`). */
  sendProtocol?: boolean;
  /** The Surface revision the phone shows, sent with a Send Protocol request; 0 or absent names none. */
  revision?: number;
  /** The pane is gone, this device may not write, or the pane's machine is not taking writes. */
  locked: boolean;
  /** The placeholder while locked: why nothing can be sent. ALREADY TRANSLATED. */
  lockedWhy: string;
  /** The pane is drawn from saved or frozen data: nothing may act (M46 spec 11). */
  offline: boolean;
  /** The soft keyboard is up: the bottom pad gives back the home-indicator inset. */
  composing?: boolean;
  display: { open: boolean; onToggle: () => void };
  pullHandle?: {
    ref: (node: HTMLElement | null) => void;
    onClick: () => void;
    label: string;
    alert?: boolean;
  };
  changesPill?: { onClick: () => void; label: string };
  hand?: Hand;
  /** Drawn directly above the belt: the joystick handle band of Settings → Pane navigation (ADR 0121). */
  aboveBelt?: ReactNode;
  /** A send landed: snap the stream to its tail. */
  onSent: () => void;
  /** Scroll to the open question's card and focus its first button: the way on from a send an open question refused. */
  onAnswerDialog?: () => void;
  /** Read the pane again: the turn moved, or a write changed what is current. */
  onReload: () => void;
}

/** The text a reading says: the bridge's own words for a refusal, the catalog's otherwise. */
function say(reading: ReturnType<typeof readControl>, kind: ControlKind): string {
  return reading.note === "refused" && reading.detail !== "" ? reading.detail : t(noteKey(reading, kind));
}

export function DurableComposer({
  paneId,
  scope,
  turnId,
  asks,
  actions,
  status,
  sendProtocol = false,
  revision = 0,
  locked,
  lockedWhy,
  offline,
  composing = false,
  display,
  pullHandle,
  changesPill,
  hand = "right",
  aboveBelt,
  onSent,
  onReload,
  onAnswerDialog,
}: DurableComposerProps) {
  useLocale();
  const [input, setInput] = useState(() => loadDraft(scope, paneId) ?? "");
  const [steer, setSteer] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  // The id of the program button whose tap is in flight, so a second tap on it waits for the first.
  const [running, setRunning] = useState<string | null>(null);
  const [justSent, setJustSent] = useState(false);
  // The timer that ends the "Sent" check. One at a time, and none after the composer is gone.
  const justSentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What became of the last Send Protocol request, at the thumb; null after a clean send.
  const [refusal, setRefusal] = useState<SendRefusal | null>(null);
  // The request id of the last send or stop, kept only while its outcome is unknown.
  const sendIntent = useRef<IntentId | null>(null);
  const stopIntent = useRef<IntentId | null>(null);
  // One intent per program button: a retry after an unknown outcome carries the same request id.
  const actionIntents = useRef(new Map<string, IntentId>());

  const field = useRef<HTMLTextAreaElement | null>(null);
  // The field had focus when Send was tapped: it gets it back when the hold ends, so a thumb can go on typing.
  const refocus = useRef(false);
  useEffect(() => () => clearTimeout(justSentTimer.current ?? undefined), []);
  function flashSent() {
    clearTimeout(justSentTimer.current ?? undefined);
    setJustSent(true);
    justSentTimer.current = setTimeout(() => setJustSent(false), 1500);
  }
  useEffect(() => {
    if (sending || !refocus.current) return;
    refocus.current = false;
    field.current?.focus();
  }, [sending]);

  const barItems = useDurableBarItems(scope, actions);
  const target = controlTarget({ turnId, asks });
  const canSteer = steerOffered(status);
  const canStop = stopOffered(status, target);
  const steerNow = steer && canSteer;
  const hasDraft = input.trim() !== "";
  const off = locked || offline;

  function edit(value: string) {
    setInput(value);
    saveDraft(scope, paneId, value);
  }

  async function send() {
    const text = input.trim();
    if (text === "" || off || sending) return;
    if (textRouteFor({ program: true, crew: !isLead(scope), sendProtocol }, steerNow) === "api-send") {
      await sendThroughProtocol(text);
      return;
    }
    setRefusal(null);
    const id = requestIdFor(sendIntent.current, intentKey(text, steerNow, target), mintRequestId);
    sendIntent.current = id;
    const key = paneScopeKey(scope, paneId);
    refocus.current = document.activeElement === field.current;
    // A line that never left is replaced by this try. A retry of the same request id takes its place again.
    dropNotSent(key);
    addPending(key, { requestId: id.requestId, text, at: Date.now(), state: "sending" });
    // The words move to the thread; the field waits for the send. They come back below if the send did not land.
    setInput("");
    clearDraft(scope, paneId);
    setSending(true);
    let result: ControlResult | null = null;
    let thrown: { status: number | undefined; message: string } | null = null;
    try {
      result = await sendToPane(paneId, { requestId: id.requestId, text, steer: steerNow, target }, scope);
    } catch (error) {
      thrown = { status: apiErrorStatus(error), message: describeThrownError(error) };
    } finally {
      setSending(false);
    }
    const reading = result !== null ? readControl(result) : readThrown(thrown?.status, thrown?.message ?? "");
    if (!reading.keepId) sendIntent.current = null;
    if (reading.clear) {
      // The pending line stays: the program's own item takes its place when the next read carries it.
      setPendingState(key, id.requestId, "sent");
      setSteer(false);
      flashSent();
      onSent();
    } else {
      setInput(text);
      saveDraft(scope, paneId, text);
      // The answer never came, or the program may have it: only "send again" can tell. Otherwise nothing ran.
      setPendingState(key, id.requestId, reading.keepId || reading.note === "maybe" ? "unconfirmed" : "notSent");
    }
    if (reading.reload) onReload();
    setStatus(say(reading, "send"), reading.note === "sent" ? "success" : "error");
  }

  // One Send Protocol request. The id is kept for a retry of the same intent only while no answer came,
  // so a lost answer never sends twice; any answer ends the intent, as in the terminal composer.
  async function sendThroughProtocol(text: string) {
    // Keyed on the text alone: while no answer came, the same text is the same request, even after the
    // next read moved the turn, so a retry never sends twice. The bridge checks the turn by the revision.
    const id = requestIdFor(sendIntent.current, `protocol\u0000${text}`, mintRequestId);
    sendIntent.current = id;
    const key = paneScopeKey(scope, paneId);
    refocus.current = document.activeElement === field.current;
    dropNotSent(key);
    addPending(key, { requestId: id.requestId, text, at: Date.now(), state: "sending" });
    setInput("");
    clearDraft(scope, paneId);
    setRefusal(null);
    setSending(true);
    let reply: SendReply | null = null;
    let error = "";
    try {
      // The revision names the turn the phone saw; 0 names none, and the bridge then checks no turn.
      const body: SendRequestBody = { id: id.requestId, pane: paneId, text, mode: "send", revision: revision > 0 ? revision : undefined };
      reply = await postProgramSend(body, scope);
    } catch (thrown) {
      error = describeThrownError(thrown);
    } finally {
      setSending(false);
    }
    if (reply === null) {
      // No answer: the id stays, so the next tap on the same text asks for the same request.
      setInput(text);
      saveDraft(scope, paneId, text);
      setPendingState(key, id.requestId, "unconfirmed");
      setRefusal(phoneRefusal(t("composer.protocol.retry", { error })));
      return;
    }
    sendIntent.current = null;
    const reading = readSend(reply);
    if (reading.clear) {
      // The pending line stays: the program's own item takes its place, and closes the receipt as effective.
      setPendingState(key, id.requestId, "sent");
      flashSent();
      onSent();
      onReload();
      // A send the program takes for after its turn says so, in the place "Sent" stands.
      setStatus(t(reading.note === "queued" ? "composer.protocol.queued" : "durable.composer.sent"), "success");
      return;
    }
    setInput(text);
    saveDraft(scope, paneId, text);
    setPendingState(key, id.requestId, reply.outcome === "unknown" ? "unconfirmed" : "notSent");
    setRefusal(programRefusal(reply, reading));
    // The answer says what the bridge saw; the next read draws it.
    onReload();
  }

  async function stop() {
    if (off || stopping || target === null) return;
    const id = requestIdFor(stopIntent.current, intentKey("", false, target), mintRequestId);
    stopIntent.current = id;
    setStopping(true);
    let result: ControlResult | null = null;
    let thrown: { status: number | undefined; message: string } | null = null;
    try {
      result = await abortPane(paneId, { requestId: id.requestId, target }, scope);
    } catch (error) {
      thrown = { status: apiErrorStatus(error), message: describeThrownError(error) };
    } finally {
      setStopping(false);
    }
    const reading = result !== null ? readControl(result) : readThrown(thrown?.status, thrown?.message ?? "");
    if (!reading.keepId) stopIntent.current = null;
    if (reading.reload) onReload();
    setStatus(say(reading, "stop"), reading.note === "sent" ? "success" : "error");
  }

  async function run(action: PaneAction) {
    if (off || running !== null) return;
    // The turn is named when the phone has one: a button belongs to the pane, but a turn that moved since the
    // phone looked is worth knowing about before the program acts (the bridge answers it as stale).
    const key = intentKey(action.id, false, turnId === undefined || turnId === "" ? null : { turnId });
    const id = requestIdFor(actionIntents.current.get(action.id) ?? null, key, mintRequestId);
    actionIntents.current.set(action.id, id);
    setRunning(action.id);
    let result: ControlResult | null = null;
    let thrown: { status: number | undefined; message: string } | null = null;
    try {
      result = await runPaneAction(paneId, { requestId: id.requestId, actionId: action.id, turnId }, scope);
    } catch (error) {
      thrown = { status: apiErrorStatus(error), message: describeThrownError(error) };
    } finally {
      setRunning(null);
    }
    const reading = result !== null ? readControl(result) : readThrown(thrown?.status, thrown?.message ?? "");
    if (!reading.keepId) actionIntents.current.delete(action.id);
    // The program may have changed its buttons, its thread or its state: read the pane again.
    if (reading.reload) onReload();
    setStatus(say(reading, "action"), reading.note === "sent" ? "success" : "error");
  }

  return (
    <div
      data-slot="durable-composer"
      className={cn(
        "relative bg-chrome px-3",
        composing ? "pb-2" : "pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)]",
      )}
    >
      {aboveBelt}
      <ActionsRow
        general={[
          {
            id: "display",
            icon: Settings2,
            label: t("composer.controls.displayAria"),
            word: t("composer.controls.display"),
            on: display.open,
            expanded: display.open,
            onSelect: display.onToggle,
          },
        ]}
        agent={undefined}
        mine={[]}
        durable={{
          items: barItems,
          state: {
            steer: { pressed: steer, offered: canSteer && !off, onPressedChange: setSteer },
            stop: { offered: canStop && !off, busy: stopping, onStop: () => void stop() },
            action: { running, onRun: (action) => void run(action) },
          },
        }}
        onRun={() => Promise.resolve(false)}
        disabled={locked}
        handle={pullHandle}
        changes={changesPill}
        hand={hand}
      />
      {/* What became of a Send Protocol request, at the thumb: the terminal composer's own notice. */}
      <Collapse open={refusal !== null}>
        {refusal !== null && (
          <SendRefusalNotice
            refusal={refusal}
            action={
              refusal.toCard && onAnswerDialog !== undefined ? (
                <Button variant="ghost" size="sm" className={NOTICE_ACTION} onClick={onAnswerDialog}>
                  {t("durable.protocol.goToQuestion")}
                </Button>
              ) : undefined
            }
          />
        )}
      </Collapse>
      <div
        data-slot="composer-box"
        className={cn(
          "relative flex items-end gap-1 rounded-xl border border-input bg-background p-1 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring",
          hand === "left" && "flex-row-reverse",
          locked && "bg-muted/40",
        )}
      >
        <ChatInput
          ref={field}
          value={input}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={locked ? lockedWhy : sending ? t("durable.composer.sending") : t("durable.composer.placeholder")}
          className={cn("min-w-0 flex-1 min-h-9 pl-2 py-1.5 font-mono", hand === "left" && "pr-2")}
          disabled={locked || sending}
          rows={1}
        />
        <Button
          type="button"
          data-slot="composer-primary"
          size="icon"
          className={cn(TOOLBAR_TAP_TARGET, "size-9 shrink-0 rounded-full")}
          disabled={off || sending || !hasDraft}
          aria-label={offline ? t("composer.send.reconnect") : t("composer.send.sendAria")}
          title={offline ? t("composer.send.reconnect") : undefined}
          onClick={() => void send()}
        >
          {sending ? <Loader2 className="size-4 animate-spin" /> : justSent ? <Check className="size-4" /> : <Send className="size-4" />}
        </Button>
      </div>
    </div>
  );
}
