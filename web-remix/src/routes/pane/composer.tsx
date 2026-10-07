// The composer (ADR 0057): the bottom chrome block of the pane screen. Port of
// web/src/components/composer.tsx. Top to bottom: the "Sent" preview, the open drawer (Keys tray,
// Quick replies, Display), the actions belt, the condition strips (no-echo, direct typing, recording,
// draft too long), then ONE bordered box with the field, attach and the primary action.
//
// THE FIELD IS UNCONTROLLED. The textarea owns its value; this component reads it on `input` and
// writes it only on purpose (a marker, a transcript, a take-over, a clear, an undo) through `setText`,
// which also writes the draft through (lib/drafts.ts: web's per-pane store plus the reload hold). A
// poll never re-renders the value under the caret.
//
// SENDING, in the order a send meets it:
//   - A dialog with the keyboard refuses ("answer it first"); an unread dialog arms the deliberate
//     override instead, and the second tap types anyway (ADR 0053), within 10 s.
//   - A destructive line needs a second tap within 3 s.
//   - web's `sendGuardedReply` types, verifies the words reached the box, then submits. Its
//     `onComposerSeen` clears a draft stranded in the terminal's own box first (ctrl+k, then
//     Backspaces), so the reply does not land after it (ADR 0061).
//   - Sent: the ✓ for 1.5 s, the words held in a "Sent" strip until the mirror moves or 6 s pass,
//     and the status pill.
import { on, ref, type Handle, type RemixNode } from "remix/component";
import { Check, FileText, Image, Keyboard, LoaderCircle, Mic, Paperclip, Send, Settings2, Slash, Square, Terminal, Zap } from "lucide";

import { applyDraftFontSize, fontStack, inputFocusZoomsPage } from "@web/hooks/use-display-prefs";
import { sendKeys } from "@web/lib/api";
import { describeApiError } from "@web/lib/api-error-message";
import { composeLine, insertMarker, markerMissing, removeMarker } from "@web/lib/attachments";
import { isDestructiveInput } from "@web/lib/destructive";
import { buzz } from "@web/lib/haptics";
import { t, tn } from "@web/lib/i18n";
import { keyLabel } from "@web/lib/key-queue";
import { ctrlPresetsFor } from "@web/lib/operator-keys";
import type { Scope } from "@web/lib/scope";
import { cn } from "@web/lib/utils";

import { AttachmentChips } from "../../composer/attachment-chips";
import { createAttachments, fileAccept, offersFiles, PHOTO_ACCEPT, type PendingAttachment } from "../../composer/attachments";
import { DirectTypingStrip } from "../../composer/direct-typing-strip";
import { isSelfEcho, normalizeDraft, TerminalDraftPreview, createStableDraft } from "../../composer/draft-preview";
import { composerKeyIntent } from "../../composer/keys";
import { KeysTray } from "../../composer/keys-tray";
import { NoEchoNotice } from "../../composer/no-echo-notice";
import { createRecorder, elapsedLabel } from "../../composer/recorder";
import { RecordingStrip } from "../../composer/recording-strip";
import { countRender } from "../../lib/render-count";
import { beginBusy } from "../../lib/busy";
import { config } from "../../lib/data";
import { createDirectTyping } from "../../lib/direct-typing";
import { clearDraft, fitsDraftStore, holdDraft, loadDraft, saveDraft } from "../../lib/drafts";
import { LONG_PRESS_EVENT, longPress } from "../../lib/gestures";
import { useLocale } from "../../lib/i18n-store";
import { displayPrefs, type DisplayPrefs } from "../../lib/prefs";
import { setStatus } from "../../lib/status";
import { scheduleUpdate, useStore } from "../../lib/store";
import { adapterFor, harnessLoaded, loadHarness } from "../../lib/harness-lazy";
import { handsFree, sttCapability } from "../../lib/stt";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import type { WriteTarget } from "./answer";
import { lazySendTypedReply as sendTypedReply } from "./answer-lazy";
import { AgentPalette } from "./agent-palette";
import { Belt, BeltStandIn, type BeltPill, type BeltProps } from "./belt";
import { ComposerDock, DisplayDock, QuickTray } from "./belt-drawers";
import type { WriteGate } from "./data";

/** An armed destructive send waits this long for its second tap (web's `usePendingConfirm`). */
const CONFIRM_MS = 3000;
/** The unread-dialog override waits longer: the operator reads the card first (web: 10 s). */
const FORCE_MS = 10_000;
const JUST_SENT_MS = 1500;
/** How long the attach button holds its pressed tone (web: ATTACH_PRESS_MS). */
const ATTACH_PRESS_MS = 220;
const LAST_SENT_MS = 6000;
/** A draft in the terminal's box this soon after a send is our own echo (composer.tsx). */
const SENT_ECHO_GRACE_MS = 5000;
/** After the stranded-draft clear, let the TUI repaint before typing (composer.tsx TUI_SETTLE_MS). */
const TUI_SETTLE_MS = 120;
/** "Unread" chips cover a draft's opening words; this many characters is a preview (composer.tsx). */
const PREVIEW_CHARS = 60;

// The composer's boxes, shared with `ComposerStandIn` below so the two are one height by construction.
const CHROME_BLOCK = "relative shrink-0 border-t border-rule bg-chrome";
const COMPOSER_PAD = "px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))]";
const FIELD_BOX =
  "relative mt-1 flex items-end gap-1 rounded-xl border border-input bg-background p-1 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring";
const FIELD =
  "block max-h-[min(10rem,30dvh)] min-h-9 min-w-0 flex-1 resize-none bg-transparent py-1.5 pl-2 font-mono text-base [field-sizing:content] wrap-anywhere outline-none placeholder:overflow-hidden placeholder:whitespace-nowrap placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50";

/** The draft field's size and face (composer.tsx `draftStyle`): the operator's draft size with the
 *  iOS no-zoom floor, and the mirror's family only when a non-default one was chosen. */
function draftStyleOf(prefs: DisplayPrefs): { fontSize: string; fontFamily?: string } {
  const face = fontStack(prefs.fontFamily);
  const draftPx = `${String(applyDraftFontSize(prefs.draftFontSize, inputFocusZoomsPage()))}px`;
  return face === undefined ? { fontSize: draftPx } : { fontSize: draftPx, fontFamily: face };
}

type Drawer = "keys" | "quick" | "display" | "cmd" | null;
type Armed = "none" | "force" | "destructive";

interface Cleared {
  text: string;
  saved: ReturnType<ReturnType<typeof createAttachments>["snapshot"]>;
  caret: number | null;
}

export interface ComposerProps {
  paneId: string;
  scope: Scope;
  agent: string | undefined;
  isShell: boolean;
  gate: WriteGate;
  /** A lifted dialog has the keyboard (web's `dialogPresent`). */
  dialogOwns: boolean;
  /** …and it is the unread card, whose refusal arms the override (ADR 0053). */
  dialogUnread: boolean;
  /** The multiplexer's refused keys (`/api/config` → `mux.unsupportedKeys`). */
  unsupportedKeys: readonly string[];
  /** Built at call time, so a send uses the screen as it is now. */
  target: () => WriteTarget;
  /** The draft the harness adapter reads in the terminal's own input box (`extractInputDraft`). */
  rawDraft: string | null;
  /** The pane's text, so the "Sent" strip ends when the mirror moves. */
  paneText: string;
  /** Which body is on screen, for the Display dock. */
  chatShown: boolean;
  chatNote?: string;
  changes?: BeltProps["changes"];
  switcher: BeltProps["switcher"];
  onSent: () => void;
  /** The field took or lost focus: the strips stand down only for the composer's own keyboard. */
  onFocusChange: (focused: boolean) => void;
}

export function Composer(handle: Handle<ComposerProps>) {
  useLocale(handle);
  const { paneId, scope } = handle.props;
  const saved = loadDraft(scope, paneId);
  let text = saved.text;
  let caret: number | null = null;
  let field: HTMLTextAreaElement | undefined;
  let photoInput: HTMLInputElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  let sending = false;
  let justSent = false;
  // The attach button's press echo (web's ATTACH_PRESS_MS): lit for 220 ms after a tap.
  let attachPressed = false;
  let attachTimer: ReturnType<typeof setTimeout> | undefined;
  // The mark's fast orbit turns for exactly as long as OPERATOR work runs: a send, an upload, a
  // transcription (web's `useBusyWhile`). Held and released after each commit, from the three
  // readings the render already has; the release is idempotent and the pane leaving lets go.
  let releaseWork: (() => void) | null = null;
  const holdWork = (working: boolean): void => {
    if (working && releaseWork === null) releaseWork = beginBusy();
    else if (!working && releaseWork !== null) {
      releaseWork();
      releaseWork = null;
    }
  };
  handle.signal.addEventListener("abort", () => holdWork(false), { once: true });
  let lastSent: { text: string; at: number; paneText: string } | null = null;
  let armed: Armed = "none";
  let drawer: Drawer = null;
  let queuedKeys = 0;
  let discardArmed = false;
  let picking = false;
  let cleared: Cleared | null = null;
  let noEcho: { prompt: string; typed: boolean } | null = null;
  let handledKey: string | null = null;
  let previewLatched = false;
  let previewDismissed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let justTimer: ReturnType<typeof setTimeout> | undefined;
  let lastTimer: ReturnType<typeof setTimeout> | undefined;
  let discardTimer: ReturnType<typeof setTimeout> | undefined;
  handle.signal.addEventListener("abort", () => {
    for (const id of [armTimer, justTimer, lastTimer, discardTimer, ...timers]) clearTimeout(id);
  });
  const later = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  };
  const wake = (): void => scheduleUpdate(handle);

  const attachments = createAttachments(paneId, scope, { signal: handle.signal });
  attachments.restore(saved.attachments, saved.next);
  const readAttachments = useStore(handle, attachments.list);
  const readConfig = useStore(handle, config);
  const readHandsFree = useStore(handle, handsFree);
  const readDisplay = useStore(handle, displayPrefs);
  // The harness answers the draft questions below; it loads on the first focus or terminal draft (lib/harness-lazy.ts).
  useStore(handle, harnessLoaded);
  const draftPreview = createStableDraft(handle.signal);
  const readStable = useStore(handle, draftPreview.value);

  /** Hold the reload while anything here would be lost to it (composer.tsx `useHoldReload`). */
  const hold = (): void => {
    holdDraft(scope, paneId, text.trim() !== "" || readAttachments().length > 0 || cleared !== null || direct.active || direct.busy || attachments.uploading());
  };

  /** Write the box: the field, the draft store and the hold. */
  const persist = (): void => {
    const snap = attachments.snapshot();
    saveDraft(scope, paneId, text, snap.attachments, snap.next);
    hold();
    if (!fitsDraftStore(text)) wake();
  };

  const setText = (next: string, at: number | null = null): void => {
    text = next;
    if (field && field.value !== next) field.value = next;
    if (at !== null && field) {
      const node = field;
      queueMicrotask(() => {
        node.focus({ preventScroll: true });
        node.setSelectionRange(at, at);
      });
    }
    persist();
    wake();
  };

  const endUndo = (): void => {
    if (cleared === null) return;
    cleared = null;
    hold();
    wake();
  };

  const arm = (next: Armed, ttl: number | null): void => {
    clearTimeout(armTimer);
    armed = next;
    if (ttl !== null) {
      armTimer = later(() => {
        armed = "none";
        wake();
      }, ttl);
    }
    wake();
  };

  // ── Direct typing (lib/direct-typing.ts) ─────────────────────────────────────────────────────
  const direct = createDirectTyping({
    signal: handle.signal,
    send: async (keys) => {
      const target = handle.props.target();
      if (target.refusal !== undefined) return false;
      try {
        const res = await sendKeys(target.paneId, keys, target.scope);
        if (!res.ok) {
          setStatus(describeApiError(res), "error");
          return false;
        }
        return true;
      } catch {
        return false;
      }
    },
    onChange: () => {
      hold();
      wake();
    },
    canActivate: () => !handle.props.gate.locked,
    replyDraft: () => text,
    field: () => field,
    focusInput: () => field?.focus({ preventScroll: true }),
    notify: (words, tone) => setStatus(words, tone),
  });

  // ── Speech to text (lib/stt.ts, ADR 0029) ────────────────────────────────────────────────────
  const recorder = createRecorder(
    {
      onTranscript: (words) => {
        const empty = text.trim() === "" && readAttachments().length === 0;
        if (readHandsFree() && empty && noEcho === null && !handle.props.gate.locked && !handle.props.dialogOwns) {
          void send(words, false, false);
          return;
        }
        direct.disarm("silent");
        const start = field?.selectionStart ?? text.length;
        const end = field?.selectionEnd ?? text.length;
        const before = text.slice(0, start);
        const inserted = before !== "" && !/\s$/.test(before) ? ` ${words}` : words;
        setText(`${before}${inserted}${text.slice(end)}`, start + inserted.length);
      },
      onError: (message) => setStatus(message, "error"),
    },
    handle.signal,
  );
  const readRecorder = useStore(handle, recorder.state);

  // ── Attachments (ADR 0060) ───────────────────────────────────────────────────────────────────
  const insertAt = (marker: string): void => {
    const placed = insertMarker(text, caret, marker);
    caret = placed.caret;
    setText(placed.text, placed.caret);
  };
  const addFiles = (files: FileList | readonly File[]): void => {
    endUndo();
    hold();
    void attachments.add(files, insertAt).then(() => {
      persist();
      wake();
      return undefined;
    });
  };
  const removeAttachment = (id: string): void => {
    attachments.remove(id, (marker) => setText(removeMarker(text, marker)));
    persist();
  };

  // ── Drawers ──────────────────────────────────────────────────────────────────────────────────
  const requestDrawer = (next: Drawer): void => {
    if (drawer === "keys" && next !== "keys" && queuedKeys > 0 && !discardArmed) {
      discardArmed = true;
      clearTimeout(discardTimer);
      discardTimer = later(() => {
        discardArmed = false;
      }, CONFIRM_MS);
      setStatus(tn("composer.discard.confirmKeys", queuedKeys, { count: queuedKeys }), "info");
      return;
    }
    discardArmed = false;
    drawer = next;
    endUndo();
    wake();
  };

  const pressKeysFromTray = async (keys: string[]): Promise<boolean> => {
    const target = handle.props.target();
    if (target.refusal !== undefined) {
      setStatus(target.refusal, "error");
      return false;
    }
    try {
      const res = await sendKeys(target.paneId, keys, target.scope);
      if (!res.ok) {
        setStatus(describeApiError(res), "error");
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  // ── Clear by hand, and Undo ──────────────────────────────────────────────────────────────────
  const clearByHand = (): void => {
    if (sending) return;
    const held: Cleared = { text, saved: attachments.snapshot(), caret: field?.selectionStart ?? caret };
    arm("none", null);
    attachments.clear();
    caret = null;
    setText("");
    cleared = held;
    hold();
    wake();
  };
  const undoClear = (): void => {
    const held = cleared;
    if (held === null) return;
    cleared = null;
    attachments.restore(held.saved.attachments, held.saved.next);
    caret = held.caret;
    setText(held.text, document.activeElement === field ? (held.caret ?? held.text.length) : null);
  };

  // ── The terminal's own draft (ADR 0061) ──────────────────────────────────────────────────────
  /** Our own words, echoed in the terminal's box right after a send, are not a stranded draft. */
  const suppressEcho = (raw: string | null): string | null => {
    if (raw === null || lastSent === null || Date.now() - lastSent.at >= SENT_ECHO_GRACE_MS) return raw;
    const adapter = adapterFor(handle.props.agent);
    return isSelfEcho(raw, lastSent.text, adapter?.draftCarriesSend?.bind(adapter)) ? null : raw;
  };
  const takeOver = (draft: string): void => {
    const next = text.trim() === "" ? draft : `${text}\n${draft}`;
    handledKey = normalizeDraft(draft);
    previewLatched = false;
    setText(next, next.length);
  };

  function echoAttachPress(): void {
    buzz();
    attachPressed = true;
    clearTimeout(attachTimer);
    attachTimer = later(() => {
      attachPressed = false;
      wake();
    }, ATTACH_PRESS_MS);
  }

  // ── Send ─────────────────────────────────────────────────────────────────────────────────────
  async function send(value: string, isDraft: boolean, force: boolean): Promise<boolean> {
    const line = value.trim();
    const { gate, dialogOwns, dialogUnread, agent } = handle.props;
    if (line === "" || gate.locked || sending) return false;
    if (dialogOwns) {
      if (!dialogUnread) {
        setStatus(t("composer.status.dialogWaiting"), "error");
        return false;
      }
      if (!force) {
        arm("force", FORCE_MS);
        setStatus(t("composer.status.unreadDialog", { key: keyLabel(adapterFor(agent)?.cancelKey ?? "") }), "error");
        return false;
      }
    }
    sending = true;
    endUndo();
    wake();
    const target = handle.props.target();
    const stranded = suppressEcho(handle.props.rawDraft);
    try {
      const outcome = await sendTypedReply(target, line, force, async ({ promptRegion }) => {
        if (stranded === null) return { ok: true as const, keysSent: false };
        if (handle.props.gate.locked) return { ok: false as const, error: t("composer.status.paneNotWritable") };
        const count = [...stranded].length + 32;
        const res = await sendKeys(target.paneId, ["ctrl+k", ...Array<string>(count).fill("Backspace")], target.scope, promptRegion ?? undefined);
        if (!res.ok) {
          return {
            ok: false as const,
            error: res.code === "prompt_changed" ? t("composer.status.inputChanged") : describeApiError(res, t("composer.status.clearFailed")),
          };
        }
        await new Promise((resolve) => setTimeout(resolve, TUI_SETTLE_MS));
        return { ok: true as const, keysSent: true };
      });
      if (outcome.status === "sent") {
        if (isDraft) {
          attachments.clear();
          caret = null;
          setText("");
          clearDraft(scope, paneId);
          hold();
        }
        lastSent = { text: line, at: Date.now(), paneText: handle.props.paneText };
        if (stranded !== null) {
          handledKey = normalizeDraft(stranded);
          previewLatched = false;
        }
        justSent = true;
        clearTimeout(justTimer);
        justTimer = later(() => {
          justSent = false;
          wake();
        }, JUST_SENT_MS);
        clearTimeout(lastTimer);
        lastTimer = later(() => {
          lastSent = lastSent === null ? null : { ...lastSent, paneText: "\u0000ended" };
          wake();
        }, LAST_SENT_MS);
        setStatus(t("composer.status.sent"), "success");
        arm("none", null);
        noEcho = null;
        handle.props.onSent();
        return true;
      }
      if (outcome.status === "blocked") {
        arm("force", FORCE_MS);
        noEcho = outcome.noEcho !== undefined ? { prompt: outcome.noEcho, typed: false } : null;
        setStatus(t("composer.status.tapAgainToType", { error: outcome.error }), "error");
        return false;
      }
      noEcho = outcome.status === "stalled" && outcome.noEcho !== undefined ? { prompt: outcome.noEcho, typed: true } : null;
      setStatus(outcome.error, "error");
      return false;
    } finally {
      sending = false;
      wake();
    }
  }

  const onSendClick = (): void => {
    if (direct.active) {
      direct.disarm("stopped");
      return;
    }
    const line = composeLine(text, attachmentsMarked());
    if (armed === "force") {
      arm("none", null);
      void send(line, true, true);
      return;
    }
    const reason = isDestructiveInput(line);
    if (reason !== null && armed !== "destructive") {
      setStatus(t("composer.destructive.confirm", { reason }), "info");
      arm("destructive", CONFIRM_MS);
      return;
    }
    arm("none", null);
    void send(line, true, false);
  };

  /** The ready chips, as web's `composeLine` reads them. */
  const attachmentsMarked = (): { n: number; kind: "image" | "file"; path: string }[] =>
    readAttachments()
      .filter((a): a is PendingAttachment & { n: number; path: string } => a.state === "ready" && a.n !== undefined && a.path !== undefined)
      .map((a) => ({ n: a.n, kind: a.kind, path: a.path }));

  // The terminal's own draft is read per poll; the stable reading waits 1.5 s (createStableDraft).
  let lastRaw: string | null | undefined;

  // A restored draft holds the reload from the first frame; leaving the pane lets go, as web's
  // `useHoldReload` does on unmount (the draft itself stays in the store for the next visit).
  hold();
  handle.signal.addEventListener("abort", () => holdDraft(scope, paneId, false));

  return () => {
    countRender("Composer");
    const { gate, agent, isShell, unsupportedKeys, rawDraft, paneText, chatShown, chatNote, changes, switcher } = handle.props;
    const locked = gate.locked;
    const cfg = readConfig().data;
    const stt = sttCapability(cfg);
    const list = readAttachments();
    const uploading = attachments.uploading();
    const hasDraft = text.trim() !== "" || list.length > 0;
    const rec = readRecorder();
    const working = sending || uploading || rec.phase === "transcribing";
    handle.queueTask(() => holdWork(working));
    const micIsPrimary = stt !== null && !direct.active && !hasDraft;
    const draftStyle = draftStyleOf(readDisplay());

    // The Sent strip ends when the mirror moves past the words, or its 6 s pass.
    if (lastSent !== null && lastSent.paneText !== paneText) lastSent = null;
    const sentPreview = lastSent === null ? "" : lastSent.text.length > PREVIEW_CHARS ? `${lastSent.text.slice(0, PREVIEW_CHARS - 3)}…` : lastSent.text;

    // The stranded draft preview (ADR 0061): latch on a stable draft that is not our echo and not
    // the one already handled; show while the raw line still holds it; reset when the line clears.
    const raw = suppressEcho(rawDraft);
    if (rawDraft !== lastRaw) {
      lastRaw = rawDraft;
      draftPreview.set(raw);
    }
    if (raw === null) {
      previewLatched = false;
      previewDismissed = false;
      handledKey = null;
    }
    const stable = readStable();
    if (stable !== null && raw !== null && normalizeDraft(stable) !== handledKey) previewLatched = true;
    const showPreview = !gate.locked && previewLatched && !previewDismissed && raw !== null && normalizeDraft(raw) !== handledKey;
    // A draft in the terminal is one of the moments the harness is asked about (lib/harness-lazy.ts).
    if (rawDraft !== null && !harnessLoaded.get()) handle.queueTask(() => void loadHarness());
    const adapter = adapterFor(agent);
    const opaque = raw !== null && adapter?.draftIsOpaque?.(raw) === true;

    const general: BeltPill[] = [
      { id: "keys", icon: Keyboard, label: t("composer.controls.keys"), on: drawer === "keys", expanded: drawer === "keys", disabled: locked, onSelect: () => requestDrawer(drawer === "keys" ? null : "keys") },
      {
        id: "type",
        icon: Terminal,
        label: t("composer.controls.typeAria"),
        word: t("composer.controls.type"),
        on: direct.active,
        pressed: direct.active,
        disabled: locked || sending,
        onSelect: () => {
          if (direct.active) {
            direct.disarm("stopped");
            return;
          }
          requestDrawer(null);
          direct.arm();
        },
      },
      { id: "quick", icon: Zap, label: t("composer.controls.quick"), on: drawer === "quick", expanded: drawer === "quick", disabled: locked, onSelect: () => requestDrawer(drawer === "quick" ? null : "quick") },
      { id: "agent", icon: Slash, label: t("composer.controls.agent"), disabled: locked || isShell, onSelect: () => requestDrawer("cmd") },
      {
        id: "display",
        icon: Settings2,
        label: t("composer.controls.displayAria"),
        word: t("composer.controls.display"),
        on: drawer === "display",
        expanded: drawer === "display",
        onSelect: () => requestDrawer(drawer === "display" ? null : "display"),
      },
    ];
    const clearSlot: BeltProps["clear"] =
      cleared !== null
        ? { mode: "undo", onClick: undoClear, onOtherPress: endUndo }
        : hasDraft
          ? { mode: "clear", onClick: clearByHand, inert: sending || direct.active }
          : null;

    let primary: RemixNode;
    if (!direct.active && (armed === "force" || armed === "destructive")) {
      const words = armed === "force" ? t("composer.send.typeAnyway") : t("composer.send.reallySend");
      primary = (
        <button
          type="button"
          data-testid="composer-send"
          aria-label={words}
          disabled={locked || !hasDraft || sending}
          class="h-9 shrink-0 rounded-md bg-destructive px-3 text-sm font-semibold text-white transition-all active:scale-[0.98] disabled:opacity-50"
          mix={on("click", onSendClick)}
        >
          {words}
        </button>
      );
    } else if (micIsPrimary && stt !== null) {
      primary = (
        <button
          type="button"
          data-testid="composer-mic"
          aria-pressed={rec.phase !== "idle"}
          aria-label={
            !stt.available
              ? (stt.reason ?? t("composer.mic.unavailable"))
              : rec.phase === "recording"
                ? t("composer.mic.stopAria")
                : t("composer.mic.recordAria")
          }
          title={stt.available ? undefined : stt.reason}
          disabled={!stt.available || locked || sending || rec.phase === "transcribing"}
          class={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full transition-all active:scale-[0.98] disabled:opacity-50",
            rec.phase === "idle" ? "bg-primary text-primary-foreground" : "bg-destructive text-white",
          )}
          mix={[
            on("pointerdown", (event) => event.preventDefault()),
            on("click", () => (rec.phase === "recording" ? recorder.stopAndSend() : recorder.start())),
          ]}
        >
          <Icon
            icon={rec.phase === "transcribing" ? LoaderCircle : rec.phase === "recording" ? Square : Mic}
            class={cn("size-4", rec.phase === "transcribing" && "animate-spin", rec.phase === "recording" && "fill-current")}
          />
        </button>
      );
    } else {
      primary = (
        <button
          type="button"
          data-testid="composer-send"
          data-sent={justSent ? "" : undefined}
          aria-label={direct.active ? t("composer.send.stopTypingAria") : t("composer.send.sendAria")}
          aria-pressed={direct.active}
          // web/src/components/composer.tsx: `disabled={locked || sending}`. An empty draft keeps
          // the primary ink; `send` refuses a blank value on its own.
          disabled={locked || sending}
          class="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-all active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
          mix={[
            longPress({ disabled: locked || direct.active }),
            on(LONG_PRESS_EVENT, () => {
              requestDrawer(null);
              direct.arm();
            }),
            on("pointerdown", (event) => event.preventDefault()),
            on("click", onSendClick),
          ]}
        >
          <Icon
            icon={direct.active ? Keyboard : sending ? LoaderCircle : justSent ? Check : Send}
            class={cn("size-4", sending && !direct.active && "animate-spin")}
          />
        </button>
      );
    }

    const placeholder = direct.active && !locked ? t("composer.placeholder.direct") : gate.placeholder;
    const asksWhich = offersFiles(cfg);

    return (
      <div data-slot="chrome-block" translate="no" class={CHROME_BLOCK}>
        <div class="pointer-events-none absolute inset-x-0 bottom-full z-20 px-3 pb-2" data-slot="draft-notice-slot">
          {showPreview && raw !== null ? (
            <div class="pointer-events-auto">
              <TerminalDraftPreview
                text={raw}
                onTakeOver={opaque ? null : () => takeOver(raw)}
                onDismiss={() => {
                  previewDismissed = true;
                  wake();
                }}
              />
            </div>
          ) : null}
        </div>
        <div data-slot="composer" class={COMPOSER_PAD}>
          <Collapse open={lastSent !== null}>
            <div data-testid="sent-preview" class="mb-2 flex items-center gap-1.5 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
              <Icon icon={LoaderCircle} class="size-3 shrink-0 animate-spin" />
              <span class="truncate">
                <span class="font-medium">{t("composer.sentPreview.label")}</span> {sentPreview}
              </span>
            </div>
          </Collapse>
          <Collapse open={drawer === "keys"}>
            <ComposerDock title={t("composer.controls.keys")} onClose={() => requestDrawer(null)} testId="keys-dock">
              <KeysTray
                onSend={pressKeysFromTray}
                presets={ctrlPresetsFor(agent, cfg?.operatorKeys ?? [])}
                disabled={locked}
                unsupportedKeys={unsupportedKeys}
                onQueueChange={(n) => {
                  queuedKeys = n;
                }}
              />
            </ComposerDock>
          </Collapse>
          <Collapse open={drawer === "quick"}>
            <ComposerDock title={t("composer.controls.quick")} onClose={() => requestDrawer(null)}>
              <QuickTray
                agent={agent}
                isShell={isShell}
                disabled={locked || sending}
                onSend={(words) => send(words, false, false)}
                onClose={() => requestDrawer(null)}
              />
            </ComposerDock>
          </Collapse>
          <Collapse open={drawer === "display"}>
            <ComposerDock title={t("composer.controls.display")} onClose={() => requestDrawer(null)}>
              <DisplayDock chatShown={chatShown} chatNote={chatNote} />
            </ComposerDock>
          </Collapse>
          <Belt
            general={general}
            agent={isShell ? undefined : agent}
            onRun={(command) => send(command, false, false)}
            disabled={locked}
            changes={changes}
            clear={clearSlot}
            switcher={switcher}
          />
          <Collapse open={noEcho !== null && !direct.active}>
            <NoEchoNotice
              prompt={noEcho?.prompt ?? ""}
              typed={noEcho?.typed ?? false}
              onUseType={
                locked
                  ? null
                  : () => {
                      noEcho = null;
                      direct.arm();
                      wake();
                    }
              }
              onDismiss={() => {
                noEcho = null;
                wake();
              }}
            />
          </Collapse>
          <Collapse open={direct.active}>
            <DirectTypingStrip onStop={() => direct.disarm("stopped")} />
          </Collapse>
          <Collapse open={rec.phase === "recording" || rec.phase === "transcribing"}>
            <RecordingStrip
              elapsed={elapsedLabel(rec.elapsedMs)}
              transcribing={rec.phase === "transcribing"}
              handsFree={readHandsFree()}
              onStop={() => recorder.stopAndSend()}
              onDiscard={() => recorder.discard()}
            />
          </Collapse>
          <Collapse open={!direct.active && !fitsDraftStore(text)}>
            <p class="px-1 pb-1 text-xs leading-snug text-muted-foreground">{t("composer.draft.tooLong")}</p>
          </Collapse>
          <input
            type="file"
            data-testid="attach-photos"
            accept={PHOTO_ACCEPT}
            multiple
            class="hidden"
            mix={[
              ref((node: HTMLInputElement) => {
                photoInput = node;
              }),
              on("change", (event) => {
                const files = event.currentTarget.files;
                if (files && files.length > 0) addFiles([...files]);
                event.currentTarget.value = "";
              }),
            ]}
          />
          <input
            type="file"
            data-testid="attach-files"
            accept={fileAccept(cfg)}
            class="hidden"
            mix={[
              ref((node: HTMLInputElement) => {
                fileInput = node;
              }),
              on("change", (event) => {
                const files = event.currentTarget.files;
                if (files && files.length > 0) addFiles([...files]);
                event.currentTarget.value = "";
              }),
            ]}
          />
          <div
            class={cn(
              FIELD_BOX,
              list.length > 0 && "flex-wrap",
              locked && "bg-muted/40",
              direct.active && "border-primary focus-within:border-primary focus-within:ring-primary",
            )}
          >
            <Collapse open={list.length > 0} class="w-full basis-full">
              <AttachmentChips list={list} onRemove={removeAttachment} disabled={sending} inFront={(a) => a.n !== undefined && markerMissing(text, { n: a.n, kind: a.kind })} />
            </Collapse>
            <textarea
              data-slot="chat-input"
              aria-label={placeholder}
              placeholder={placeholder}
              disabled={locked}
              rows={1}
              autoCapitalize="none"
              autoCorrect={direct.active ? "off" : undefined}
              spellCheck={direct.active ? false : undefined}
              enterkeyhint="enter"
              class={FIELD}
              style={draftStyle}
              mix={[
                ref((node: HTMLTextAreaElement) => {
                  field = node;
                  node.value = text;
                }),
                on("beforeinput", (event) => direct.onBeforeInput(event)),
                on("compositionstart", () => direct.onCompositionStart()),
                on("compositionend", (event) => direct.onCompositionEnd(event)),
                on("input", (event) => {
                  if (direct.active) {
                    direct.onInput(event);
                    return;
                  }
                  const node = event.currentTarget;
                  caret = node.selectionStart;
                  text = node.value;
                  if (text !== "" || list.length > 0) cleared = null;
                  if (armed !== "none") armed = "none";
                  persist();
                  handle.update();
                }),
                on("select", (event) => {
                  caret = event.currentTarget.selectionStart;
                }),
                on("focus", () => {
                  void loadHarness();
                  handle.props.onFocusChange(true);
                }),
                on("blur", (event) => {
                  caret = event.currentTarget.selectionStart;
                  handle.props.onFocusChange(false);
                }),
                on("paste", (event) => {
                  const files = [...(event.clipboardData?.files ?? [])];
                  if (files.length === 0 || locked) return;
                  event.preventDefault();
                  addFiles(files);
                }),
                on("keydown", (event) => {
                  if (direct.active) {
                    direct.onKeyDown(event);
                    return;
                  }
                  if (composerKeyIntent(event) !== "send") return;
                  event.preventDefault();
                  onSendClick();
                }),
              ]}
            />
            <button
              type="button"
              data-testid="composer-attach"
              aria-label={t("composer.attach.aria")}
              aria-haspopup={asksWhich ? "dialog" : undefined}
              aria-expanded={asksWhich ? picking : undefined}
              disabled={uploading || locked || direct.active}
              class={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-all active:bg-muted active:scale-[0.98] disabled:opacity-50",
                // The press echo: `duration-0` on the way in (a press must answer at once), the base
                // duration on the way out. Lit while its menu stands, as web/'s.
                (attachPressed || picking) && "scale-95 bg-primary text-primary-foreground duration-0",
              )}
              mix={[
                on("pointerdown", (event) => event.preventDefault()),
                on("click", () => {
                  echoAttachPress();
                  if (asksWhich) {
                    picking = !picking;
                    handle.update();
                  } else photoInput?.click();
                }),
              ]}
            >
              <Icon icon={uploading ? LoaderCircle : Paperclip} class={cn("size-4", uploading && "animate-spin")} />
            </button>
            {picking ? (
              <div
                role="menu"
                aria-label={t("composer.attach.title")}
                data-testid="attach-menu"
                class="absolute right-0 bottom-full z-30 mb-2 flex min-w-44 flex-col gap-1 rounded-lg border border-border bg-popover p-1 shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  class="flex min-h-11 items-center gap-2 rounded-md px-3 text-sm active:bg-muted"
                  mix={on("click", () => {
                    picking = false;
                    handle.update();
                    photoInput?.click();
                  })}
                >
                  <Icon icon={Image} class="size-4 shrink-0" />
                  {t("composer.attach.photos")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  class="flex min-h-11 items-center gap-2 rounded-md px-3 text-sm active:bg-muted"
                  mix={on("click", () => {
                    picking = false;
                    handle.update();
                    fileInput?.click();
                  })}
                >
                  <Icon icon={FileText} class="size-4 shrink-0" />
                  {t("composer.attach.files")}
                </button>
              </div>
            ) : null}
            {primary}
          </div>
        </div>
        <AgentPalette
          open={drawer === "cmd"}
          onClose={() => requestDrawer(null)}
          agent={agent}
          disabled={locked}
          onRun={(command) => send(command, false, false)}
          onInsert={(command) => {
            requestDrawer(null);
            const next = text.trim() === "" ? `${command} ` : `${text} ${command} `;
            setText(next, next.length);
          }}
        />
      </div>
    );
  };
}

// ── The stand-in, for the pane's first frame ──────────────────────────────────────────────────────

export interface ComposerStandInProps {
  paneId: string;
  scope: Scope;
  gate: WriteGate;
}

/**
 * What the pane draws where the composer goes, for the frame before the composer mounts (pane.tsx,
 * "the two-step mount"). The same boxes as `Composer`: the chrome block, the padded column, the belt's
 * band (`BeltStandIn`) and the bordered field box holding a textarea with the same classes, size,
 * face, placeholder and saved draft text, so `field-sizing: content` gives it the composer's own
 * height. The attach slot and the round primary keep their 36 px. Inert and hidden from the
 * accessibility tree; no listeners, no subscriptions (it lives for one frame, `get()` is enough).
 *
 * The no-shift rule (DESIGN.md §2) is why it exists: the real composer replaces it at the same height,
 * so neither the screen above nor its pinned tail moves. A saved draft with attachments draws chips
 * this box cannot size, so the pane mounts the composer at once for that one (pane.tsx).
 */
export function ComposerStandIn(handle: Handle<ComposerStandInProps>) {
  const text = loadDraft(handle.props.scope, handle.props.paneId).text;
  return () => {
    const { gate } = handle.props;
    return (
      <div data-slot="chrome-block-standin" translate="no" aria-hidden="true" inert class={CHROME_BLOCK}>
        <div class={COMPOSER_PAD}>
          <BeltStandIn />
          <div class={cn(FIELD_BOX, gate.locked && "bg-muted/40")}>
            <textarea
              tabIndex={-1}
              readOnly
              rows={1}
              placeholder={gate.placeholder}
              disabled={gate.locked}
              class={FIELD}
              style={draftStyleOf(displayPrefs.get())}
              mix={ref((node: HTMLTextAreaElement) => {
                node.value = text;
              })}
            />
            <span class="size-9 shrink-0" />
            <span class={cn("size-9 shrink-0 rounded-full bg-primary", gate.locked && "opacity-50")} />
          </div>
        </div>
      </div>
    );
  };
}
