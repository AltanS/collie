import { useRef, useState } from "react";
import { Check, Loader2, Send, Settings2 } from "lucide-react";

import { ActionsRow, type Hand } from "@/components/actions-row";
import { useDurableBarItems } from "@/components/harness-bar";
import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { TOOLBAR_TAP_TARGET } from "@/components/ui/tap-target";
import { useLocale } from "@/hooks/use-locale";
import { abortPane, apiErrorStatus, sendToPane, type ControlResult } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { clearDraft, loadDraft, saveDraft } from "@/lib/drafts";
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
import type { Scope } from "@/lib/scope";
import { setStatus } from "@/lib/status";
import type { AgentStatus, Ask } from "@/lib/types";
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
// The belt keeps what is not about a screen: the Display button, the Switch pill and the Changes
// pill. The Keys, Type and Quick buttons are not drawn, because there is nothing for them to type
// into.

export interface DurableComposerProps {
  paneId: string;
  scope?: Scope;
  /** What the pane has shown that a control may name: its newest turn and its open asks. */
  turnId?: string;
  asks?: readonly Ask[];
  status?: AgentStatus;
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
  /** A send landed: snap the stream to its tail. */
  onSent: () => void;
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
  status,
  locked,
  lockedWhy,
  offline,
  composing = false,
  display,
  pullHandle,
  changesPill,
  hand = "right",
  onSent,
  onReload,
}: DurableComposerProps) {
  useLocale();
  const [input, setInput] = useState(() => loadDraft(scope, paneId) ?? "");
  const [steer, setSteer] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [justSent, setJustSent] = useState(false);
  // The request id of the last send or stop, kept only while its outcome is unknown.
  const sendIntent = useRef<IntentId | null>(null);
  const stopIntent = useRef<IntentId | null>(null);

  const barItems = useDurableBarItems(scope);
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
    const id = requestIdFor(sendIntent.current, intentKey(text, steerNow, target), mintRequestId);
    sendIntent.current = id;
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
      setInput("");
      clearDraft(scope, paneId);
      setSteer(false);
      setJustSent(true);
      setTimeout(() => setJustSent(false), 1500);
      onSent();
    }
    if (reading.reload) onReload();
    setStatus(say(reading, "send"), reading.note === "sent" ? "success" : "error");
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

  return (
    <div
      data-slot="durable-composer"
      className={cn(
        "relative bg-chrome px-3",
        composing ? "pb-2" : "pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)]",
      )}
    >
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
          },
        }}
        onRun={() => Promise.resolve(false)}
        disabled={locked}
        handle={pullHandle}
        changes={changesPill}
        hand={hand}
      />
      <div
        data-slot="composer-box"
        className={cn(
          "relative flex items-end gap-1 rounded-xl border border-input bg-background p-1 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring",
          hand === "left" && "flex-row-reverse",
          locked && "bg-muted/40",
        )}
      >
        <ChatInput
          value={input}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={locked ? lockedWhy : t("durable.composer.placeholder")}
          className={cn("min-w-0 flex-1 min-h-9 pl-2 py-1.5 font-mono", hand === "left" && "pr-2")}
          disabled={locked}
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
