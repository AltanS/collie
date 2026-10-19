import { forwardRef, useContext, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChangeEvent, ClipboardEvent, CSSProperties, ReactNode } from "react";
import { useRevalidator } from "react-router";
import { Check, FileText, Image, Keyboard, ListEnd, ListTodo, Loader2, Mic, Monitor, Navigation, Paperclip, Pencil, Send, Settings2, Slash, Square, Terminal, TriangleAlert, X, Zap } from "lucide-react";

import { StatusDot } from "@/components/status-badge";
import { applyDraftFontSize, fontStack, inputFocusZoomsPage, reportOfferOf, sentSuggestionsOf } from "@/hooks/use-display-prefs";
import type { DisplayPrefs, Hand } from "@/hooks/use-display-prefs";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { useDirectTyping } from "@/hooks/use-direct-typing";
import { useLocale } from "@/hooks/use-locale";
import { t as translate, tn as translatePlural } from "@/lib/i18n";
import { holdsMask } from "@/lib/masked-text";
import { setStatus } from "@/lib/status";
import { buzz } from "@/lib/haptics";
import { stampSend } from "@/lib/poll-intent";
import { useBusyWhile } from "@/lib/busy";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TOOLBAR_TAP_TARGET } from "@/components/ui/tap-target";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { NavTray } from "@/components/nav-tray";
import { KeyBoardEditor } from "@/components/key-board-editor";
import { CommandPalette, useClaudeCommands } from "@/components/command-palette";
import { SentSheet } from "@/components/sent-sheet";
import { SuggestionStrip } from "@/components/suggestion-strip";
import { useSentSuggestions } from "@/hooks/use-sent-suggestions";
import { QuickActionsContent } from "@/components/quick-actions";
import { ActionsRow, type GeneralAction } from "@/components/actions-row";
import { SectionLabel } from "@/components/ui/section-label";
import { Collapse } from "@/components/ui/collapse";
import { BottomSheet } from "@/components/ui/sheet";
import { SendOfferStrip } from "@/components/send-offer-strip";
import { HeldCard, type HeldAction } from "@/components/composer-held";
import { offerMode, type SendNote } from "@/lib/send-protocol";
import { modeFor, sendText } from "@/lib/reply-action";
import { fieldLocked, sendSlot, unreachable } from "@/lib/send-slot";
import { wayOut } from "@/lib/way-out";
import type { Surface } from "@/lib/surface/surface";
import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { detectNoEchoPrompt } from "@/lib/no-echo";
import type { HeldRow, SendMode, SendOffer, SendWhen } from "@/lib/surface/send";
import type { IntentId } from "@/lib/durable-control";
import { Notice, NOTICE_ACTION } from "@/components/ui/notice";
import { ActionRow } from "@/components/action-sheet-rows";
import { AnchoredMenu } from "@/components/ui/anchored-menu";
import { WalkyAimStrip, WalkyHeldStrip, WalkyNoteStrip } from "@/components/walky-composer-strip";
import { WalkyIcon } from "@/components/walky-icon";
import { useLongPress } from "@/hooks/use-long-press";
import { useWalkyComposer, type WalkyAim } from "@/hooks/use-walky-composer";
import * as api from "@/lib/api";
import { describeApiError, describeThrownError } from "@/lib/api-error-message";
import { commandsFor, suggestCommands, type AgentCommand } from "@/lib/agent-commands";
import { useMuxCapability, useMuxUnsupportedKeys } from "@/lib/mux-capability";
import { useOperatorCommands, useOperatorKeys, useUploadCapability } from "@/lib/operator-config";
import {
  acceptAttribute,
  attachmentKind,
  composeLine,
  expandAttachmentInText,
  insertMarker,
  isCollapsiblePaste,
  limitMb,
  markerFor,
  markerMissing,
  nextMarkerNumber,
  offersFiles,
  pasteLineCount,
  pastePreviewName,
  PHOTO_ACCEPT,
  rejectAttachment,
  removeMarker,
  uploadLimits,
} from "@/lib/attachments";
import { ctrlPresetsFor } from "@/lib/operator-keys";
import { useKeyBoard } from "@/lib/key-board-store";
import { isDestructiveInput } from "@/lib/destructive";
import { useHostLabel } from "@/components/crew-provider";
import { fitsDraftStore, loadDraftEntry, saveDraft } from "@/lib/drafts";
import { wipeDevice } from "@/lib/wipe";
import { AttachmentChip, type ComposerAttachment } from "@/components/attachment-chip";
import { useHoldReload } from "@/lib/reload-guard";
import { isSelfEcho, normalizeDraft } from "@/hooks/use-terminal-draft";
import { adapterFor } from "@/lib/harness";
import { useLive } from "@/lib/liveness";
import { useCatchingUp, useLocked } from "@/lib/idle";
import { ClearNotice, OfflineDraftNote, TerminalDraftPreview } from "@/components/terminal-draft-preview";
import { ReportCard } from "@/components/report-card";
import { textToKeySequence } from "@/lib/key-queue";
import { isLead, paneScopeKey, scopeKey, type Scope } from "@/lib/scope";
import { closeTrouble, noteSend, openReport, streakIds, useTroubleOffer } from "@/lib/report/store";
import { takeBeltIntent } from "@/lib/belt-intent";
import type { PaneSubagent, PaneTodo } from "@/lib/types";
import { AgentsSheet, subagentName } from "@/components/agents-sheet";
import { SubagentSheetCtx, type SubagentTarget } from "@/components/chat-cards";
import { DirectTypingStrip } from "@/components/direct-typing-strip";
import { VoiceTakeover } from "@/components/voice-takeover";
import { usePhoneEngineUse } from "@/hooks/use-phone-engine";
import { useSttRecorder } from "@/hooks/use-stt-recorder";
import { useHandsFree, useSttCapability } from "@/lib/stt";
import { NoEchoNotice } from "@/components/no-echo-notice";
import type { TranscriptEntry } from "@/lib/types";
import { findUnknownSendMatch, type UnknownSend } from "@/lib/unknown-send";
import { clearNotice, phoneRefusal, readingRefusal, refusalKey, SendRefusalNotice, stopNotice, type SendRefusal } from "@/components/send-notice";
import { mintRequestId } from "@/lib/worktree-name";

/** The status line a verified send leaves, by where the text went. */
const STATUS_KEY = {
  sent: "composer.status.sent",
  queued: "composer.protocol.queued",
  held: "composer.protocol.held",
  steered: "composer.steer.steered",
  queuedInstead: "composer.steer.queuedInstead",
} as const;

/** What a cleared reading tells the status line; a steer the harness queued says so (M69). */
function verifiedNote(note: SendNote, when: SendWhen | undefined): keyof typeof STATUS_KEY {
  if (note === "steered" || note === "held") return note;
  if (note === "queued") return when === "steer" ? "queuedInstead" : "queued";
  return "sent";
}

export interface ComposerHandle {
  /** Focus the input and put the caret at the end — used by the mirror-tap-to-focus in AgentChat. */
  focusInput: () => void;
  /**
   * Open the box for a message to another session (M62): the Reply of the pane's Messages sheet. The
   * strip above the box names the target, and Send posts through `POST /api/walky` with `replyTo`,
   * until the person turns it off or the message leaves.
   */
  startMessage: (aim: WalkyAim) => void;
}

interface ComposerProps {
  paneId: string;
  /** The pane's current session instance (`AgentView.instance`). "Send as message" addresses it. */
  instance?: string | undefined;
  /**
   * The pane's input surface as the bridge last read it (M56 spec 06): what owns the agent's keyboard.
   * The Send slot is a pure function of this and the three facts below (`lib/send-slot.ts`). The
   * caller turns a fact it knows before any read into `composer: unreachable` (a machine the lead
   * cannot reach, a bridge whose Send Protocol is off), and names the reason in `unreachableNote`.
   */
  surface: Surface;
  /** Why the box cannot be reached, for the placeholder, when `surface.composer` is `unreachable`. */
  unreachableNote?: string;
  /** Which machine + which named session the pane lives in — scopes every write to the right Herdr. */
  scope?: Scope;
  /** The pane's agent name — drives the slash-command palette and the reply-vs-shell placeholder. */
  agent: string | undefined | null;
  /**
   * The pane's profile has a steer key and the pane is a trusted screen pane (`AgentView.canSteer`,
   * M69). While the turn runs, the Send button's long-press menu then offers "Steer". Absent or false:
   * the menu has no such row, whatever the harness is.
   */
  canSteer?: boolean | undefined;
  /**
   * The pane's Chat holds a returned queued card (ADR 0122): a Stop put a queued message back in the
   * box. A send refused `draft_present` then points at that card instead of at an unseen draft.
   */
  returnedDraft?: boolean;
  /** True for a bare shell pane — tweaks the placeholder copy. */
  isShell: boolean;
  /** The pane's folder, absolute. Sent (M61) lists "This folder" with it; absent, it offers the machine only. */
  cwd?: string | undefined;
  /* NO `status` AND NO `stale` HERE ANY MORE. The composer took the pane's state as a prop for one
     reason: the status band above the controls row drew it as a word. That band is gone (see the
     long note at the row below), the word went with it rather than moving, and the state is the
     pane header's and the dashboard's to state. A composer that knows what the pane is DOING is a
     composer that will be asked to draw it again; it does not know any more. */
  /** Pane is gone (no agent) — locks the composer with a distinct placeholder. */
  gone: boolean;
  /** This device isn't authorised to type — locks the composer with a distinct placeholder. */
  readOnly: boolean;
  /**
   * The soft keyboard is up, so this dock is standing on it rather than on the screen's own bottom
   * edge. Read ONCE by the pane (agent-chat.tsx, `composing`) and passed down — never re-derived
   * here, or the boundary animates out of step with the two rows above that read the same fact.
   *
   * All it changes in this file is the bottom pad. `env(safe-area-inset-bottom)` reserves room for
   * the home indicator, and the keyboard is already covering the home indicator: while it is up the
   * inset is a second reservation for the same strip of glass, ~24px of it, paid at the exact moment
   * the screen has none to give. The `0.5rem` of real breathing room stays, in both states.
   */
  composing?: boolean;
  /**
   * The belt draws Stop (M68 spec 02): the bridge says a key exists (`stopFor`, lib/harness-bar.ts,
   * decided by the pane). The turn only decides whether it is live or dimmed. Absent or false and no
   * Stop is drawn.
   */
  stopOffered?: boolean;
  /** The "Answer the dialog" word's tap: scroll to the dialog card and focus its first button. It sends
   * no text and no key. The same tap is the control of a refusal notice whose screen holds an ask or
   * an overlay Collie cannot read. */
  onAnswerDialog?: () => void;
  /** A dialog card stands in the card dock. A refusal notice offers "Answer the dialog" only then: an
   *  unreadable screen with no card has nothing to go to (the 2026-10-16 field case). */
  dialogCard?: boolean;
  /** Latest pane text — clears the pending-send preview once the mirror echoes the send back. */
  text: string;
  /** A user draft stranded on the terminal's "❯" input line (extractInputDraft), STABILISED across
   * polls (useStableTerminalDraft) — non-null only once the same text has held for ~1.5s. Gates the
   * APPEARANCE of the read-only draft preview, so a one-poll blip or an in-flight send never flashes it. */
  terminalDraft: string | null;
  /** The SAME draft, but the RAW per-poll value (pre-stabilisation). Once the preview is showing, its
   * text tracks this live so host typing streams into it, and it unmounts the preview when it goes
   * null. Never written into the input, and never swept by the phone: since M56 spec 06 the bridge
   * refuses a send onto a draft (`draft_present`) and offers Add, Replace or Cancel. */
  rawTerminalDraft: string | null;
  /** Mirror display prefs — the mirror (in AgentChat) reads the same single instance, so they're
   * threaded through rather than each calling useDisplayPrefs. Only the DRAFT field's own size and
   * the terminal face are read here; the rows that write any of this moved to AgentChat's ⚙ sheet. */
  prefs: DisplayPrefs;
  /**
   * The ⚙ on the belt, whose sheet AgentChat owns and mounts.
   *
   * The button stays here because it is one of four on one row and the row is this file's. The
   * PANEL moved out: a sheet is a `fixed inset-0` element with no portal, so it must not be mounted
   * inside the composer's animated, sticky ancestry (see the note beside the pane-menu sheet in
   * agent-chat.tsx).
   */
  display: { open: boolean; onToggle: () => void };
  /** Snap the mirror to the live tail (follow + revalidate + scroll) after a successful send. */
  onSent: () => void;
  /**
   * Opens the pane's Messages sheet (M62 spec 03): where the held mark above the box takes a tap. Absent
   * where the pane has no sheet, and then no mark is drawn.
   */
  onOpenMessages?: (() => void) | undefined;
  /**
   * The pane's held sends from the snapshot (M56 spec 15), oldest first: a send the harness could not
   * take mid-turn, kept by the bridge and sent when the pane reads free. One queued row each, above the box.
   */
  held?: readonly HeldRow[] | undefined;
  /**
   * The Chat window's journal turns, as AgentChat already read them. Their one job here is settling
   * a send that ended `unknown` (#511, `lib/unknown-send.ts`): when the sent text lands as a new
   * user turn, the kept draft and its notice retire as sent. Absent or empty until Chat is read —
   * then nothing retires, which is the safe side.
   */
  chatEntries?: readonly TranscriptEntry[] | undefined;

  /**
   * The pane switcher, in two pieces: a Switch pill pinned at the actions belt's right end
   * (`onClick`, the tap) and the belt itself as a drag surface (`ref`, the finger-tracked pull).
   * Threaded straight through to {@link import("@/components/actions-row").ActionsRow} — this file
   * decides nothing about either and draws none of it.
   *
   * Absent, rather than flagged off: the pane passes nothing here when there is nowhere to switch
   * to.
   */
  pullHandle?: {
    ref: (node: HTMLElement | null) => void;
    onClick: () => void;
    label: string;
    /** Another pane needs you: the switcher mark wears a red dot. */
    alert?: boolean;
  };

  /**
   * Where the floating cards go (ADR 0061): an absolutely positioned box the pane view keeps at the
   * bottom edge of the mirror, above the card dock and the belt. The terminal-draft notice (or the
   * offline note) and the held-send card are portalled into it, so they cover terminal text and never
   * take a row of the composer's own flow. Absent (a composer mounted alone, as in its tests), they
   * float above the composer itself.
   */
  draftNoticeSlot?: HTMLElement | null;

  /** EXPERIMENT (operator, 2026-09-23): the Changes pill on the belt's pinned block, beside the
   *  switcher mark (actions-row.tsx's `changes`). Absent when the pane reports no folder. */
  changesPill?: { onClick: () => void; label: string };

  /** The output, zoomed: the Zoom pill on the belt's pinned block, directly left of the switcher
   *  mark (actions-row.tsx's `zoom`). Absent where there is no screen to zoom. */
  zoomPill?: { onClick: () => void; label: string };

  /**
   * The parent drew this pane from the on-device cache (M46 spec 10), so nothing it shows is proven
   * current. Together with a lapsed liveness stamp (lib/liveness.ts) it turns the SEND paths off while
   * typing, and the draft's own save, stay on. M46 spec 11: no queue, no retry and no auto-send when
   * the bridge comes back, because the words may answer a screen that has moved on.
   */
  stale?: boolean;

  /**
   * Which thumb the pane is laid out for (the Settings "Hand" choice). `"right"` (default) is the
   * shipped layout, unchanged. `"left"` mirrors the two ends a thumb has to reach: the belt turns
   * round, with its pinned block at the left end above Send and the pills running right to left
   * from Keys ({@link Hand} in actions-row.tsx), and in the reply box Send and Attach move to the
   * left of the field, Send on the outer edge, Attach beside the field.
   */
  hand?: Hand;

  /**
   * Drawn directly above the actions belt, under any open dock: the pane's joystick handle band when
   * Settings → Pane navigation is Joystick (ADR 0121). The pane decides; absent, nothing is drawn.
   */
  aboveBelt?: ReactNode;

  /**
   * One more floating notice from the pane, nearest the belt in the floating group (ADR 0061): the Two
   * fingers first-arm hint (ADR 0121). The pane decides; absent, nothing is drawn.
   */
  floatingHint?: ReactNode;

  /**
   * The Screen pill on the belt (M56 spec 07): the raw rows of the terminal, without cards, one tap
   * away in every state. `on` is true while those rows are what the pane draws; `onToggle` turns
   * them on and off. Absent on a pane with no screen (Chat is its only body, ADR 0099 point 9), where
   * the pill would have nothing to show.
   */
  screen?: { on: boolean; onToggle: () => void };
  /** The pane's active todo list, drawn as a belt pill and an in-flow dock when non-empty. */
  todos?: readonly PaneTodo[];
  /**
   * The pane's subagents that have not finished yet (bridge/subagents.ts), drawn as the agents mark
   * on the belt's fixed block and an in-flow dock when non-empty. A finished one leaves the list and stays in Chat.
   */
  subagents?: readonly PaneSubagent[];
}

// The composer cluster at the bottom of the pane view — everything a phone keyboard can't do on its
// own: quick actions, an agent-aware slash-command palette, an inline key tray (via
// `pane.send_keys`), attachment upload, display prefs, and the reply Send (with a destructive-command
// two-tap guard). Its state (draft, sending, upload, pending preview, its own Keys/Quick/Agent
// sheets) is entirely local; it reaches AgentChat only through `onSent` (to re-follow the tail) and
// exposes `focusInput` so the mirror tap can bring up the keyboard.
//
// "display" joined the drawer union when the permanent icon-only View row was retired: wrap / raw
// terminal / font size are settings you touch once, so they cost a whole row of a phone viewport for
// nothing, and the raw-terminal toggle in particular was an unlabelled `>_` glyph nobody could
// decode. They now live behind the ⚙ on the actions row, as labelled rows in the same
// in-flow dock (they change how the mirror LOOKS, so the mirror has to stay visible while you flip
// them). Find moved the other way — to the header, where its find bar already takes over the row.
type ComposerDrawer = "quick" | "cmd" | "keys" | "todos" | null;

/** The card key a subagent sheet opened from the belt carries. No Chat card uses it. */
const BELT_SUBAGENT_KEY = "belt-subagent:";



// Grace window after a send during which a terminal draft matching what we just sent is treated as
// our own in-flight reply (still on the "❯" line before the bridge's Enter lands), NOT a
// stranded draft. Wide enough to cover a slow tailnet round-trip; the parent's cross-poll
// stabilisation (useStableTerminalDraft) closes the other half of the same window.
const SENT_ECHO_GRACE_MS = 5_000;

// Burst window for post-keypress revalidation (see scheduleKeyRevalidate).
const KEY_REVALIDATE_MS = 300;

// Shared in-flow dock chrome for Keys/Quick — an IN-FLOW panel (never an overlay), so the terminal
// mirror's flex-1 box shrinks and its tail stays visible while the dock is open (a covering sheet
// hid exactly the prompt you were driving). Full-bleed top border + capped height keep the mirror
// usable on a phone. The header (title + Close X) is a NON-scrolling child of a flex column; only the
// body below it scrolls (max-h + overflow), so the Close X can never scroll out of reach on a short
// viewport with a tall tray. One wrapper so Keys and Quick can't drift apart.
function ComposerDock({
  title,
  onEdit,
  onClose,
  children,
}: {
  title: string;
  /** Draws a pencil beside the label, centred on it. Only the Keys dock has one (ADR 0092). */
  onEdit?: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="-mx-3 mb-2 flex flex-col border-t border-border bg-background">
      <div className="flex items-center justify-between px-3 pt-2">
        <div className="flex min-w-0 items-center gap-2">
          <SectionLabel>{title}</SectionLabel>
          {onEdit !== undefined && (
            // 28px drawn, 44px reached: the `::before` reaches 8px past each edge into the header's own
            // padding and the dock's gap, the same trade the Close X beside it makes (DESIGN.md §6).
            <Button
              variant="ghost"
              size="icon"
              className="relative -ml-1 size-7 text-muted-foreground before:absolute before:-inset-2 before:content-['']"
              onClick={onEdit}
              aria-label={translate("composer.dock.editKeys")}
            >
              <Pencil className="size-3.5" />
            </Button>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          onClick={onClose}
          aria-label={translate("composer.dock.closeAria", { title })}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="max-h-[45dvh] min-h-0 overflow-y-auto">{children}</div>
    </div>
  );
}

/** How long the attach button holds its pressed tone, in ms. Just under the sheet's own 240ms
 *  entrance, so the flash hands over to the sheet rather than lingering behind it. */
const ATTACH_PRESS_MS = 220;
/** Frames the composer keeps asking for focus back after the voice takeover goes (about 250 ms at 60 Hz). */
const TAKEOVER_FOCUS_FRAMES = 15;


/**
 * A photo chip's thumbnail source: a blob URL for the picked file, valid for this page session only
 * (ADR 0060). Undefined where the browser has no object URLs (jsdom), which draws the icon tile. The
 * bridge's CSP admits `blob:` in `img-src` for exactly this; a blob URL is minted by this page's own
 * script, so it opens no new origin.
 */
function makePreview(file: File): string | undefined {
  if (!("createObjectURL" in URL)) return undefined;
  try {
    return URL.createObjectURL(file);
  } catch {
    return undefined;
  }
}

/** Release a chip's thumbnail. Called when the chip is removed, sent, or its pane is left, and for a
 *  chip the belt's X took out, when its Undo window ends without an Undo. */
function revokePreview(attachment: ComposerAttachment) {
  if (attachment.previewUrl === undefined || !("revokeObjectURL" in URL)) return;
  URL.revokeObjectURL(attachment.previewUrl);
}

/** What the belt's X took out of the box, held in memory for its Undo (M40 spec 04). */
/** What the last Clear answered, while its floating notice stands (ADR 0116, the Clear paragraph). */
interface ClearNote {
  /** The pane the Clear was for: the notice never shows on another. */
  readonly paneId: string;
  readonly refusal: SendRefusal;
  /** The text the Clear removed, while Restore is offered; null once it is not. */
  readonly draft: string | null;
  /** When the receipt came back: the notice goes after {@link CLEAR_NOTE_MS}. */
  readonly at: number;
  /** A read since the Clear showed the box without a draft (see the composer's effect). */
  readonly seenEmpty: boolean;
}

/** How long a Clear's floating notice, and its Restore, stand. */
export const CLEAR_NOTE_MS = 120_000;

interface ClearedDraft {
  text: string;
  /** The chips, preview URLs included: those stay alive until the window ends. */
  attachments: ComposerAttachment[];
  /** The number the next chip would have got. A clear restarts it at 1; Undo puts it back. */
  next: number;
  /** Where the caret stood, or null when the field never reported one. */
  caret: number | null;
}


export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { paneId, instance, surface, unreachableNote, scope, stopOffered = false, agent, canSteer, returnedDraft = false, isShell, cwd, gone, readOnly, composing, onAnswerDialog, dialogCard = false, text, terminalDraft, rawTerminalDraft, prefs, display, onSent, onOpenMessages, held: heldRows, chatEntries, pullHandle, draftNoticeSlot, changesPill, zoomPill, stale, hand = "right", aboveBelt, floatingHint, screen, todos, subagents },
  ref,
) {
  const revalidator = useRevalidator();
  useLocale();
  // The mirror-family stack for the draft field, or undefined when the operator kept the default
  // (the stylesheet's `font-mono` then answers alone). Derived once; the ChatInput below wears it.
  const terminalFace = fontStack(prefs.fontFamily);
  // The draft field's px, with the iOS floor already applied — hooks/use-display-prefs.ts owns both
  // the number and the browser fact behind the floor. Read at render rather than memoised: it is two
  // string tests on `navigator`, and the alternative is a cached answer that would survive a device
  // it was not measured on.
  const draftFontPx = applyDraftFontSize(prefs.draftFontSize, inputFocusZoomsPage());
  // ONE style object for the field, built here rather than at the prop. `fontSize` is always written
  // — the field has a size of its own now, so there is no "leave it alone" value — while
  // `fontFamily` is written ONLY for a non-default family, so an install that never opened the
  // setting renders from the stylesheet's own `--font-mono`, byte for byte as before.
  const draftStyle: CSSProperties = { fontSize: `${draftFontPx}px` };
  if (terminalFace !== undefined) draftStyle.fontFamily = terminalFace;
  // THE SEND SLOT (M56 spec 06): one pure function of the pane's Surface and three facts (gone,
  // read-only, offline), in lib/send-slot.ts. The multiplexer underneath that cannot type into a pane
  // at all (M10/06) is one more way the box is out of reach, so it folds into `composer: unreachable`
  // with the multiplexer's own words, as the caller folds a machine the lead cannot reach. Two
  // capabilities, one fact: a reply is `typeText` then `sendKeys` (bridge/mux/capabilities.ts), and
  // half a reply is not a feature. Asked of the machine this row is on (M22/03).
  const canType = useMuxCapability("typeText", scope);
  const canSendKeys = useMuxCapability("sendKeys", scope);
  const missingSend = !canType.capable ? canType : !canSendKeys.capable ? canSendKeys : null;
  const shownSurface = missingSend !== null ? unreachable(surface) : surface;
  const unreachableWords =
    missingSend !== null
      ? missingSend.note || translate("composer.placeholder.noMuxSend")
      : (unreachableNote ?? translate("composer.placeholder.unreachable"));
  // The machine every write on this row lands on, as words for a confirm. The Keys dock header used
  // to carry a chip for it; that header now holds the KEYS label and the pencil and nothing else
  // (M48 spec 03), because the pane header already names the machine.
  // Its display name, or undefined when there is no crew — the copy-level half of the hide rule.
  const writeHostLabel = useHostLabel(scope?.host);
  // M46 spec 11: nothing is sent from cached state. The field stays typeable while the bridge is
  // away (the draft saves as before, drafts.ts); the slot gates every path that reaches the pane
  // (send, raw keys, the belt) and nothing else. There is no outbox: a send refused here is gone, the
  // draft stays in the box.
  const live = useLive(paneId, scope);
  const offline = stale === true || !live;
  const slot = sendSlot(shownSurface, { gone, readOnly, offline });
  // THE WAY OUT (M56 spec 07, lib/way-out.ts): which state this is, and whether the Keys dock opens and
  // can send. The rule is one function so that no refusal, no flag and no lock can hide the key pad on
  // its own; only a pane that is gone, a device that may not write and a multiplexer that sends no key
  // at all do.
  const way = wayOut(shownSurface, { gone, readOnly, offline }, { keysCapable: canSendKeys.capable });
  // The field itself is off only when nothing typed here can ever leave for this pane: a gone pane,
  // a read-only device, a box out of reach. Derived from the slot, never passed in.
  const locked = fieldLocked(slot);
  // Clear (ADR 0116) is offered while the box holds a draft and no dialog owns the keys. The Surface's own
  // words, so a stale or unreadable read greys it; the keys door and the link are `way.keysSendable`.
  const clearOffered = way.keysSendable && shownSurface.composer === "draft" && shownSurface.modal === "none";
  const offlineRef = useRef(offline);
  offlineRef.current = offline;
  // The one-line note while Send is off for want of a live read: what happens to the words already
  // typed. It floats in the terminal-draft notice's slot (see `floatingNotice`), so it moves nothing.
  // It appears only on the first keystroke made while offline that leaves text in the field (see
  // `noteOfflineKeystroke`): not on going offline, not for a draft restored from the store, not for
  // an emptied field. Once per pane view (this component is keyed by pane): spent when its x is
  // tapped or when the pane is live again, so a flaky link does not repeat it.
  const [draftNote, setDraftNote] = useState<"idle" | "shown" | "spent">("idle");
  useEffect(() => {
    if (draftNote === "shown" && !offline) setDraftNote("spent");
  }, [draftNote, offline]);
  const noteOfflineKeystroke = (value: string) => {
    if (value === "" || !offlineRef.current) return;
    setDraftNote((note) => (note === "idle" ? "shown" : note));
  };

  // The phone-owned draft, restored from (and written through to) the per-pane draft store — the
  // pane view is keyed by paneId, so without this, stepping over to another tab mid-reply ate the
  // message. Lazy initialiser so the restore happens on the mount, before first paint.
  const [restoredDraft] = useState(() => loadDraftEntry(scope, paneId));
  const [input, setInput] = useState(restoredDraft?.text ?? "");
  // The attachments waiting as chips above the field (ADR 0060), and the number the next one gets.
  // Each chip's `[Image #N]` / `[File #N]` marker sits in `input` where it was added; Send swaps
  // the marker for the chip's path (lib/attachments.ts, `composeLine`). Refs beside the state for
  // the same reason `inputValueRef` exists: the write-through reads them in the tick they change.
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(restoredDraft?.attachments ?? []);
  const attachmentsRef = useRef<ComposerAttachment[]>(attachments);
  const nextAttachmentRef = useRef(restoredDraft?.next ?? 1);
  const [editingPaste, setEditingPaste] = useState<{
    paneId: string;
    scopeId: string;
    n: number;
  } | null>(null);
  // Where the caret last stood in the field, so an upload that lands after the field lost focus (a
  // native picker took it) still puts its marker where the operator was. Null means "no caret
  // yet", which puts the marker at the end.
  const caretRef = useRef<number | null>(null);
  // Mirror of `input` for the write-through path: updateInput needs the previous value to apply a
  // functional update AND to persist the result, without either reading stale state or doing the
  // save inside a (double-invoked) state updater.
  const inputValueRef = useRef(input);
  // Which pane the current `input` belongs to. DetailRoute keys AgentChat by paneId, so in the app a
  // pane→pane navigation remounts this component and the lazy initialiser above does the work — but
  // the component must not depend on that: if it is ever rendered with a changed paneId/session in
  // place, the effect below saves the outgoing pane's draft and loads the incoming one, so pane A's
  // text can never surface in pane B.
  // Compared by VALUE (its cache key), never by object identity: a scope is a value passed as an
  // object, and an identity compare here would re-run the save/restore below on every poll.
  const scopeId = scopeKey(scope);
  // Report a problem (ADR 0123): this pane's failure streak, and whether this device offers the card.
  const reportKey = paneScopeKey(scope, paneId);
  const reportOn = isLead(scope) && reportOfferOf(prefs);
  const reportCount = useTroubleOffer(reportKey);
  const draftPaneRef = useRef({ scope, scopeId, paneId });
  // THE BELT'S X AND ITS UNDO (M40 spec 04, issue #291). The X empties this box in one tap
  // (`clearByHand`); until the operator's next act the same slot is Undo, and this is what Undo puts
  // back. NO TIMER (Altan, 2026-09-27): a slot that left on a clock would narrow the pinned block
  // under a tap on its way, and the pill beside it can be a harness command (DESIGN.md §2). Undo
  // ends on the next act instead: a keystroke, a chip, a send, arming Type, leaving the pane, or a
  // tap on any other belt control. A sideways scroll of the belt is looking, not acting, and keeps it. MEMORY ONLY and for this pane view only: never stored, dropped on a pane switch and on
  // unmount, the posture ADR 0005 gives a key queue. State for the render, a ref for the handlers
  // that read it in the tick it changes, as with the chips above.
  const [clearedDraft, setClearedDraft] = useState<ClearedDraft | null>(null);
  const clearedDraftRef = useRef<ClearedDraft | null>(null);

  /**
   * Set the draft AND persist it. Every write to `input` goes through here — an empty value removes
   * the stored key, so the deliberate-clear paths (verified send, user emptying the box) need no
   * special case.
   *
   * PERSISTENCE STOPS while a password prompt is on screen (#103). By the time the notice appears the
   * secret is already in the 48h store — the write-through ran on every keystroke, before any send was
   * attempted — so `noEchoRef` gates the save AND the pane-leave save below, and the outcome that sets
   * it removes the stored copy outright. The button was never enough: the operator who taps Send,
   * gives up and walks to a laptop (which is exactly what #103 reports doing, for three days) never
   * presses anything, and the pane-leave path would have re-saved it on the way out.
   *
   * Gating on a REF, not the state, because the two must change in the same tick as the outcome that
   * decides it — a render behind is a render in which the next keystroke is still being stored.
   * The in-memory draft is untouched: a false positive costs one draft its ability to survive the OS
   * killing the PWA, which is a cheap price for never storing a real one.
   */
  function updateInput(value: string) {
    // Anything written INTO the box ends the belt X's Undo window (M40 spec 04): a keystroke, a
    // chip's marker, a transcript, a Take over, a slash command. An Undo after that would overwrite
    // what the operator just put there. The clear itself writes "" and so never ends its own window.
    if (value !== "" || attachmentsRef.current.length > 0) endUndoWindow();
    inputValueRef.current = value;
    setInput(value);
    persistDraft();
  }

  /** The write-through, text and chips together. The chip writers (addAttachment, removeAttachment,
   *  clearComposedDraft) set the chip ref first and then write the text through updateInput, so
   *  one save carries both. An empty draft (no text, no chips) also forgets its chip
   *  numbering, so the next draft starts at #1 again; lib/drafts.ts forgets it on disk the same way. */
  function persistDraft() {
    if (inputValueRef.current.trim() === "" && attachmentsRef.current.length === 0) {
      nextAttachmentRef.current = 1;
    }
    if (noEchoRef.current !== null) return;
    saveDraft(scope, paneId, inputValueRef.current, attachmentsRef.current, nextAttachmentRef.current);
  }

  /** {@link updateInput} for the appenders, which need the current value to build the next one.
   *  Split from it rather than overloaded on the argument: the two callers are different shapes,
   *  and the ref — not React state — is what carries "the current value" here. */
  function updateInputFrom(next: (prev: string) => string) {
    updateInput(next(inputValueRef.current));
  }

  useEffect(() => {
    const prev = draftPaneRef.current;
    if (prev.paneId === paneId && prev.scopeId === scopeId) return;
    if (noEchoRef.current === null) {
      saveDraft(prev.scope, prev.paneId, inputValueRef.current, attachmentsRef.current, nextAttachmentRef.current);
    }
    // The outgoing pane's previews die here: its chips come back from the store as icon tiles.
    for (const attachment of attachmentsRef.current) revokePreview(attachment);
    // So does an open Undo window from the belt's X: it held the outgoing pane's draft, and it
    // never outlives that pane's view.
    endUndoWindowRef.current();
    draftPaneRef.current = { scope, scopeId, paneId };
    const restored = loadDraftEntry(scope, paneId);
    inputValueRef.current = restored?.text ?? "";
    setInput(inputValueRef.current);
    attachmentsRef.current = restored?.attachments ?? [];
    setAttachments(attachmentsRef.current);
    nextAttachmentRef.current = restored?.next ?? 1;
    caretRef.current = null;
    setPreviewDismissed(false); // it was about the pane we just left
    noticeNoEchoRef.current(null); // it described the pane we just left
  }, [scope, scopeId, paneId]);
  const [sending, setSending] = useState(false);
  // The Send Protocol's held intent (its request id) and the offers its last answer made (M56 spec 05).
  const protocolIntent = useRef<IntentId | null>(null);
  // A send that ended `unknown`, remembered until the journal settles it (#511, lib/unknown-send.ts):
  // the person may submit the stranded text by hand, and the user turn landing in Chat is then the
  // proof it went through. Memory only, like the notice it retires; a new send replaces it.
  const [pendingUnknown, setPendingUnknown] = useState<UnknownSend | null>(null);
  // The journal as this render has it, for the send path to snapshot which turns predate a send.
  const chatEntriesRef = useRef(chatEntries);
  chatEntriesRef.current = chatEntries;
  // The settling effect below must fire on the journal and the remembered send, not on every
  // render's fresh closure — the latest-value ref says that outright, as `noticeNoEchoRef` does.
  const clearComposedDraftRef = useRef(clearComposedDraft);
  clearComposedDraftRef.current = clearComposedDraft;
  const [protocolOffer, setProtocolOffer] = useState<{ text: string; isDraft: boolean; rowsHash: string | null; offers: readonly SendOffer[]; capAck: boolean } | null>(null);
  const [uploading, setUploading] = useState(false);
  // Pending-send preview: set on a successful send, cleared when the mirror catches up (next text
  // update) or after a 6s safety timeout. Shows "You sent: …" so the user knows the message landed.
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [justSent, setJustSent] = useState(false); // brief ✓ on the send button after a send
  // Terminal-draft preview bookkeeping. The composer input is EXCLUSIVELY phone-owned — a host draft
  // is never written into it implicitly; it only surfaces in a read-only preview the user can
  // deliberately Take over. The x (ADR 0061) hides it until the host line clears; otherwise it stays
  // visible until the host line clears, the user takes it over, or the user sends. `handledKey` is the NORMALISED text the user has handled (took
  // over or sent) — the preview stays hidden while the live draft still normalises to it, so it can't
  // re-latch onto the same text we just copied/sent (the raw line still holds it until the host clears
  // or Enter lands); a genuinely different draft is fair game again. `previewLatched` is the show/hide
  // latch: a STABLE draft flips it on (gating appearance behind the 1.5s stability), and it stays on —
  // its text tracking the RAW draft live — until the host line clears or the user acts (see the effects
  // below).
  const [handledKey, setHandledKey] = useState<string | null>(null);
  const [previewLatched, setPreviewLatched] = useState(false);
  // The notice's x (ADR 0061): hidden until the terminal draft is gone. Not keyed on the text, so a
  // host that keeps typing into the same line keeps it hidden; the line clearing (below, where the
  // latch drops) is the only thing that lifts it. In memory and per pane: the pane-change effect
  // resets it, and nothing stores it.
  const [previewDismissed, setPreviewDismissed] = useState(false);
  // Composer sheets are mutually exclusive — at most one open (Keys / Quick / Agent / Display).
  const [drawer, setDrawer] = useState<ComposerDrawer>(null);
  // Keys staged in the (unmounted-on-close) NavTray, pushed up so leaving the Keys dock can guard a
  // composed sequence. See requestDrawer.
  const [queuedKeys, setQueuedKeys] = useState(0);
  // Two-tap guard for discarding that sequence. Separate from sendConfirm so an armed "Really send?"
  // and an armed discard can't clobber each other.
  const discardConfirm = usePendingConfirm();

  // The SINGLE choke point for every drawer transition. Closing the Keys dock destroys the composed
  // queue (NavTray unmounts, useKeyQueue resets) — deliberate, because a queue that survived into a
  // later open would let Send fire yesterday's chord sequence into today's TUI state, and this
  // surface's whole safety story is "you review exactly what is about to go on the wire". So the fix
  // for a mis-tap is a confirm, not persistence.
  //
  // Routed through here rather than guarding the dock's ✕ alone: the Keys toggle and the Quick /
  // Agent / Display buttons all unmount the tray just as effectively. An armed-but-EMPTY queue (a
  // lone `once` modifier, no chips) does not arm the confirm — one tap of setup isn't work worth
  // protecting, and over-guarding just trains you to double-tap through it reflexively.
  function requestDrawer(next: ComposerDrawer) {
    if (drawer === "keys" && next !== "keys" && queuedKeys > 0 && !discardConfirm.confirm("discard")) {
      setStatus(
        translatePlural("composer.discard.confirmKeys", queuedKeys, { count: queuedKeys }),
        "info",
      );
      return;
    }
    discardConfirm.reset();
    setDrawer(next);
  }
  const closeDrawer = () => requestDrawer(null);
  // Two-tap guard for destructive commands (rm -rf, force-push, …): the first tap arms a "Really
  // send?" state on the Send button (auto-disarms after 3 s), the second actually sends. Same shared
  // confirm the command palette uses for /clear.
  const sendConfirm = usePendingConfirm();
  const armedWhen = useRef<SendWhen | undefined>(undefined);
  // The password prompt the last refused send was looking at, if it was one (#103). Since M56 spec 06
  // the phone reads nothing before a send; this is a display read of the screen the composer already
  // has (`text`), taken when the bridge refused or left the text unsubmitted, and only to say so and
  // offer Type. Cleared by the x, by arming Type, by a send that goes through, and by leaving the
  // pane. Not persisted: it is a statement about what is on screen right now.
  //
  // It is state AND a ref because it has two jobs on two clocks: the strip renders from the state,
  // while the draft write-through (updateInput, above) has to stop storing keystrokes in the same tick
  // the outcome lands, not on the render after. `noticeNoEcho` is the only writer of both — go through
  // it, or the two disagree and the gap is measured in stored passwords.
  const [noEcho, setNoEcho] = useState<{ prompt: string; typed: boolean } | null>(null);
  // True while Type mode was armed by the password-prompt handoff: the field then shows dots.
  // `noEcho` cannot gate that, because arming clears the notice and it also gates draft saves and
  // the refusal strip. Set in the handoff, cleared by the effect after useDirectTyping below.
  const [handoffMask, setHandoffMask] = useState(false);
  // Why the last text did not go, or what became of it: the sentence, what the bridge saw on the screen,
  // its own words, and the way on (the card, the screen, the Keys dock). It stands at the Send slot until
  // the next send, a tap on an offer, or the strip's x. Every outcome that is not a send lands here and
  // nowhere in the header, which a phone has scrolled off or put under the keyboard when Send is tapped
  // (field case 2026-10-15, M56 spec 07): a refusal, a text left in the box, a send that ended unknown,
  // no answer, a link that is down, a dialog that owns the keys.
  const [sendRefusal, setSendRefusalState] = useState<SendRefusal | null>(null);
  // Which notice that is (send-notice.tsx `refusalKey`: the screen it is about and its words), and
  // the one the person hid with its ✕ or the offers' ✕. A hidden notice stays hidden until a refusal
  // reads another Surface (its hash or its revision) or says other words, or a tap meets the same
  // refusal with no offers (see setSendRefusal).
  const [shownRefusalKey, setShownRefusalKey] = useState<string | null>(null);
  const [hiddenRefusalKey, setHiddenRefusalKey] = useState<string | null>(null);
  /**
   * Raise or clear the notice. `on` is the Surface the bridge's answer carried, else the one on screen.
   * A refusal with no offers that repeats the hidden notice shows it again: with no offers strip,
   * the notice is the tap's only visible answer (review of 2026-10-16). With offers, the strip answers.
   */
  function setSendRefusal(next: SendRefusal | null, on: Surface | null = shownSurface, offers = false) {
    setSendRefusalState(next);
    const key = next === null ? null : refusalKey(next, on);
    setShownRefusalKey(key);
    if (key !== null && !offers) setHiddenRefusalKey((hidden) => (hidden === key ? null : hidden));
  }
  const hideRefusal = () => setHiddenRefusalKey(shownRefusalKey);
  // STOP (M68 spec 02): one fresh request id per second tap, the bridge's receipt told in the notice a send's
  // refusal uses. The bridge presses the profile's interrupt key as this person's tap, so nothing is typed
  // and no draft is touched; a refusal says why nothing was pressed. A thrown error that says nothing about
  // the key (a timeout, a dropped link, a body the phone cannot read) is the Stop's `unknown`: the key may
  // have gone in. A refusal that came back as an error (an unknown host) is the status line's.
  async function stopTurn(): Promise<void> {
    const requestId = mintRequestId();
    try {
      const receipt = await api.abortPane(paneId, { requestId }, scope);
      setSendRefusal(stopNotice(receipt), shownSurface);
      if (receipt.keys !== undefined) onSent();
    } catch (e) {
      if (api.outcomeUnknown(e)) setSendRefusal(stopNotice({ requestId, outcome: "unknown" }), shownSurface);
      else setStatus(describeThrownError(e), "error");
    }
  }
  // What the last Clear answered, for the floating notice: its words, and the text it cleared while Restore
  // is offered. `seenEmpty` turns true once a read shows the box without a draft, so the read from before the
  // Clear, still on screen when the receipt lands, does not end the offer.
  const [clearNote, setClearNote] = useState<ClearNote | null>(null);
  // CLEAR (ADR 0116, the Clear paragraph): the Keys board's button that empties the harness's box. One fresh
  // request id per tap; the bridge presses the profile's clear key as this person's tap and reads back. No arm:
  // Restore types a cleared draft back (below). A thrown
  // error that says nothing about the key (a timeout, a dropped link) is the Clear's `unknown`. The button is
  // offered only while the Surface reads a draft and no dialog, and the link is up; the bridge decides again.
  //
  // The receipt floats above the belt with the other floating notices (`floating`, ADR 0061), not in the
  // send notice under the box: a notice that came and went there moved the composer and the belt (Altan's
  // phone, 2026-10-24). A `cleared` receipt carries the text it cleared, and the notice offers Restore.
  async function clearBox(): Promise<void> {
    const requestId = mintRequestId();
    try {
      const receipt = await api.clearPane(paneId, { requestId }, scope);
      const draft = receipt.outcome === "cleared" && receipt.draft !== undefined && receipt.draft !== "" ? receipt.draft : null;
      setClearNote({ paneId, refusal: clearNotice(receipt), draft, at: Date.now(), seenEmpty: false });
    } catch (e) {
      if (api.outcomeUnknown(e)) setClearNote({ paneId, refusal: clearNotice({ requestId, outcome: "unknown" }), draft: null, at: Date.now(), seenEmpty: false });
      else setStatus(describeThrownError(e), "error");
    }
  }
  // RESTORE (ADR 0116, the Clear paragraph): the cleared text typed back into the box as this person's taps
  // through the keys route (`POST /api/pane/:id/keys`, the key gate's `person_tap`, the way Type mode types),
  // with no Enter: a line break or a tab in the text becomes a space (`boundedDraft`), so no key in it
  // submits. The keys route audits a typed character only as a mask, never the text. One Restore per Clear:
  // the offer goes as the tap leaves, so a second tap cannot type the text twice; a refusal that says
  // nothing was typed gives it back.
  const [restoring, setRestoring] = useState(false);
  async function restoreDraft(): Promise<void> {
    const note = clearNote;
    if (note === null || note.draft === null || restoring) return;
    const keys = textToKeySequence(note.draft.replace(/[\r\n\t]+/gu, " "));
    setRestoring(true);
    setClearNote({ ...note, draft: null });
    try {
      const res = await api.sendKeys(paneId, keys, scope);
      if (res.ok) {
        setClearNote(null);
        onSent();
      } else {
        setClearNote((now) => (now === null ? now : { ...now, draft: note.draft }));
        setStatus(describeApiError(res), "error");
      }
    } catch (e) {
      setStatus(describeThrownError(e), "error");
    } finally {
      setRestoring(false);
    }
  }
  // The Clear notice's lifetime. It goes after CLEAR_NOTE_MS, and on another pane. Restore ends, with the
  // notice, once a read after the Clear shows a draft in the box again: the person typed there, or Restore
  // did, so the text the Clear took is no longer what the box lacks.
  useEffect(() => {
    if (clearNote === null) return;
    const left = clearNote.at + CLEAR_NOTE_MS - Date.now();
    const timer = setTimeout(() => setClearNote(null), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [clearNote]);
  useEffect(() => {
    setClearNote((note) => (note === null || note.paneId === paneId ? note : null));
  }, [paneId]);
  const boxComposer = shownSurface.composer;
  useEffect(() => {
    setClearNote((note) => {
      if (note === null) return note;
      if (boxComposer !== "draft") return note.seenEmpty ? note : { ...note, seenEmpty: true };
      return note.seenEmpty && note.draft !== null ? null : note;
    });
  }, [boxComposer, clearNote?.at]);
  // The reason a destructive line is held for a second tap, said at the Send slot (it was a header line,
  // which holds nothing a person must act on, M56 spec 07). Shown only while the confirm is armed.
  const [destructiveNote, setDestructiveNote] = useState<string | null>(null);
  const noEchoRef = useRef<{ prompt: string; typed: boolean } | null>(null);

  /** Raise or clear the password-prompt notice. Raising it also DROPS the stored draft: at that moment
   *  we know the field holds a secret the pane never accepted, and leaving it in a 48h store to be
   *  restored on the next visit is the leak #103 asked about. The in-memory value stays — the operator
   *  can still read it, hand it to Type, or dismiss the notice and carry on. The drop goes through the
   *  one wipe routine with this pane named (lib/wipe.ts, M46 spec 02); its draft half is synchronous,
   *  so the store is empty in this tick. */
  function noticeNoEcho(next: { prompt: string; typed: boolean } | null) {
    noEchoRef.current = next;
    setNoEcho(next);
    if (next !== null) void wipeDevice("password", { scope, paneId });
  }

  // The pane-change effect below is a LIFECYCLE handler, not a reactive computation: it must fire
  // when the addressed pane changes and on nothing else. `noticeNoEcho` is re-created every render,
  // so naming it as a dependency would re-run the effect on every render instead. A latest-value
  // ref says that outright and still calls the current closure.
  const noticeNoEchoRef = useRef(noticeNoEcho);
  noticeNoEchoRef.current = noticeNoEcho;

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // The camera-roll half of the picker. See the two inputs below.
  const photoRef = useRef<HTMLInputElement>(null);
  // The idle cover leaves this composer mounted. Its inert wrapper blocks new DOM input, but
  // cannot revoke keys already waiting in direct mode's sender; the mode must disarm explicitly.
  const idleLocked = useLocked();
  const catchingUp = useCatchingUp();
  const directSuspended = locked || idleLocked || catchingUp;
  const direct = useDirectTyping({
    paneKey: `${scopeId}\0${paneId}`,
    inputRef,
    // The ref, not `input`: the password-prompt handoff clears the draft and arms in one tick.
    replyDraft: () => inputValueRef.current,
    canActivate: () => !(directSuspended || sending || uploading),
    // Field locks and the idle cover both revoke direct mode. A LOST CONNECTION is deliberately
    // not added here: the mode already disarms on a failed batch, the same event observed directly
    // rather than inferred from a timer, whether or not a banner has declared the connection lost.
    suspended: directSuspended,
    sendKeys: pressKeys,
    onActivate: () => {
      sendConfirm.reset();
      setSendRefusal(null);
      noticeNoEcho(null); // the notice's whole job was to get you here
      // The field is a live keyboard from here, not a draft, so an Undo would have nowhere to go.
      endUndoWindow();
    },
    focusInput: focusInputEnd,
    // Identity for the agent-change disarm: the mode belongs to the session
    // that armed it. "shell" when the pane has no agent (agent exits, pane
    // falls back to shell) — a change there disarms with a notice.
    agentKey: agent ?? "shell",
  });
  // The mask belongs to the handoff's armed session only. A refused arm, a Stop or any disarm ends
  // it, so a later Type mode armed by hand shows clear text.
  useEffect(() => {
    if (handoffMask && !direct.active) setHandoffMask(false);
  }, [direct.active, handoffMask]);

  // ── VOICE (ADR 0029) ──────────────────────────────────────────────────────────────────────────
  //
  // `null` unless the bridge published a provider AND this browser can actually record — one
  // predicate in lib/stt.ts, so the button here and the row in Settings can never disagree. Absent
  // is the feature being off: no button at all, not a disabled one.
  const stt = useSttCapability();
  // THE TWO ENGINES (ADR 0096). The microphone exists when the host has a provider, or when this
  // device chose "On this phone" and the phone can run it. It is ENABLED when the host's provider can
  // serve, or the phone engine is the one that will run: a phone-only device has no host provider
  // to be unavailable. The engine is the phone's whenever the device chose it and the browser can run
  // it; the recorder reads that once, as the clip starts. A phone whose copy is gone stays on the
  // phone engine (`paused`): the clip fails there with the reason and offers Send to host as a tap,
  // and never reaches the host by itself (ADR 0096 Decision 12).
  const phoneUse = usePhoneEngineUse();
  const phoneUsable = phoneUse === "phone";
  const micShown = stt !== null || phoneUsable;
  const micAvailable = phoneUsable || stt?.available === true;
  const handsFree = useHandsFree();
  // The microphone is armed state, and it obeys the same rules as "Type into terminal": it dies on a
  // pane switch, on any composer lock, and on a hidden page, and it is never persisted. The clip is
  // DISCARDED on each of those, not finished — see the hook's header for why an orphaned transcript
  // is worse than no transcript.
  const recorder = useSttRecorder({
    enabled: micAvailable && !locked && !direct.active,
    engine: phoneUse === "host" ? "host" : "phone",
    host: stt,
    paneKey: `${scopeId}\0${paneId}`,
    suspended: locked || direct.active,
    onTranscript: acceptTranscript,
    onError: (message) => setStatus(message, "error"),
  });
  // ── THE ORBIT TURNS WHILE THE OPERATOR'S WORK IS IN FLIGHT (lib/busy.ts) ───────────────────────
  //
  // Three intervals, declared where the state already lives, so the Collie mark in the header spins
  // for exactly as long as the work does and not a frame longer. `sending` spans the whole Send
  // Protocol request (the bridge reads, types, checks and presses Enter), which is the interval the
  // operator is actually waiting through; `uploading` spans the attachment POST; the recorder's
  // `transcribing` phase spans the trip to the provider. Each is a boolean this component already
  // renders from, so nothing new is tracked: the mark just reads what the composer already knows.
  //
  // NOT the poll, and not `recorder.busy`: the poll is ambient (lib/busy.ts says why at the counter),
  // and a RECORDING is the operator working, not the app — the voice takeover already says
  // so, in words, and a spinning mark would claim the phone was busy while it waits on a human.
  useBusyWhile(sending);
  useBusyWhile(uploading);
  useBusyWhile(recorder.phase === "transcribing");

  // Whether the round button at the end of the row is the microphone rather than Send. True only on
  // an EMPTY box, which is the one state where Send can do nothing anyway; the first character typed
  // hands the button straight back. `direct.active` keeps it, because there the same button is the
  // "stop typing into the terminal" control and that must not be displaceable.
  // A chip is something to send (ADR 0060), so a box holding only chips shows Send, not the mic.
  // Message mode (M62): "Send as message" from the Send button's long press, and a Reply handed in by
  // the pane's Messages sheet. The draft goes when the bridge took the message, as a reply's does.
  const walky = useWalkyComposer({
    paneId,
    instance,
    scope,
    onTaken: () => {
      clearComposedDraft();
      revalidator.revalidate();
    },
    onChanged: () => revalidator.revalidate(),
  });

  const hasDraft = input.trim() !== "" || attachments.length > 0;
  const micIsPrimary = micShown && !direct.active && !hasDraft;
  // The Send button's hold (M62). Offered only where a message could leave: not on a locked field, not
  // offline, not while Type mode owns the button as its Stop control, and not mid-send.
  const canMessage = hasDraft && !locked && !offline && !direct.active && !sending && !walky.sending;
  // M69: the Steer row of that menu. Only while the turn reads running, only where the bridge says the
  // profile has a steer key, and never for a reply in message mode (a walky message always queues).
  const steerRow = canSteer === true && shownSurface.turn === "running" && walky.aim === null;
  const sendHold = useLongPress(canMessage ? () => setSendMenu(true) : undefined);

  // ── THE VOICE TAKEOVER (design 3.3) ───────────────────────────────────────────────────────────
  //
  // Open for exactly as long as a clip exists: the permission prompt, the recording and the
  // transcription. It is drawn absolutely over this block (below), so opening it moves nothing.
  const takeoverOpen = recorder.busy;
  // The block's bottom padding. Named once because the takeover repeats it on its own column, which
  // is what puts OK on the mic's exact spot. See `composing` on the props above for the why.
  const blockPad = composing ? "pb-2" : "pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)]";
  const blockRef = useRef<HTMLDivElement>(null);
  const openedByKeyboard = useRef(false);
  // When the takeover goes away, focus goes back to the round button at the end of the row (the mic,
  // or Send once a transcript landed), but only if focus was on the takeover or nowhere: a pane
  // switch that moved focus elsewhere is not ours to take back.
  const wasTakeoverOpen = useRef(false);
  useEffect(() => {
    const returning = wasTakeoverOpen.current && !takeoverOpen;
    wasTakeoverOpen.current = takeoverOpen;
    if (!returning) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && !blockRef.current?.contains(active)) return;
    // The controls were `inert` and `invisible` a moment ago, and WebKit does not count them
    // focusable until it has painted them back: the buttons carry `transition-all`, which includes
    // `visibility`, so for the first frame or few after the takeover goes the round button still
    // computes `hidden` there and `focus()` is a silent no-op (measured: about 1 run in 20 in
    // `voice-takeover.spec.ts`, a keyboard user left with focus on the body). So ask each frame
    // until the focus took, for at most a quarter of a second, and stop the moment it took or the
    // operator put focus somewhere of their own.
    let frame = 0;
    let frames = 0;
    const settle = () => {
      const target = blockRef.current?.querySelector<HTMLElement>('[data-slot="composer-primary"]');
      if (!target) return;
      const now = document.activeElement;
      if (now !== null && now !== document.body && !blockRef.current?.contains(now)) return;
      target.focus({ preventScroll: true });
      if (document.activeElement === target || (frames += 1) >= TAKEOVER_FOCUS_FRAMES) return;
      frame = requestAnimationFrame(settle);
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [takeoverOpen]);

  /**
   * What happens to a finished transcript.
   *
   * DEFAULT: it lands in the draft at the caret, and the operator reads it before sending — a
   * transcript is text of unusually low confidence going into a real terminal.
   *
   * HANDS-FREE: it goes out through `send()`, the same Send Protocol request the Send button makes,
   * with the bridge's guard intact (ADR 0029: through the guards, never around them). Three
   * things withdraw it, and all three fall back to inserting rather than refusing:
   *
   *  • **A draft is already in the box.** Merging dictated words onto text the operator typed and
   *    sending the result would send a sentence nobody has read. The two get combined in the box
   *    instead, where the Send button is still theirs to press.
   *  • **A password prompt is on screen** (ADR 0017). Typing behaves the same way there — the pane
   *    gets nothing until the operator acts — and a spoken secret is the last thing to auto-submit.
   *  • **The composer can't send at all** (the field is locked, the pane is offline, or a modal ask
   *    owns the keyboard). `send()` would refuse anyway; inserting keeps the words.
   */
  function acceptTranscript(transcript: string) {
    const draftEmpty = inputValueRef.current.trim() === "" && attachmentsRef.current.length === 0;
    const mayHandsFree =
      handsFree && draftEmpty && noEchoRef.current === null && !locked && !offline && slot !== "answer";
    if (mayHandsFree) {
      void send(transcript, false);
      return;
    }
    insertTranscript(transcript);
  }

  /** Splice a transcript into the draft AT THE CARET (the field is where the operator left it, and
   *  dictating a clause into the middle of a sentence is the whole point of a caret), padded with a
   *  space when it would otherwise weld itself to the word in front of it. */
  function insertTranscript(transcript: string) {
    direct.deactivateSilently();
    const el = inputRef.current;
    const prev = inputValueRef.current;
    const start = el?.selectionStart ?? prev.length;
    const end = el?.selectionEnd ?? prev.length;
    const before = prev.slice(0, start);
    const after = prev.slice(end);
    const inserted = before !== "" && !/\s$/.test(before) ? ` ${transcript}` : transcript;
    updateInput(`${before}${inserted}${after}`);
    const caret = start + inserted.length;
    // Deferred like every other focus in this component: React has to swap the controlled value
    // before a selection range means anything.
    setTimeout(() => {
      const field = inputRef.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(caret, caret);
    }, 0);
  }

  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What we last sent, and when — so we can recognise our OWN reply momentarily echoing on the "❯"
  // line (between the bridge's type and its Enter) and NOT treat it as a stranded draft. A
  // ref, not state: it feeds a render-time derivation but must not itself trigger re-renders.
  const lastSentRef = useRef<{ text: string; at: number } | null>(null);
  // Trailing-edge debounce for post-keypress revalidation: a burst of raw key sends (arrow-key
  // spam) coalesces into a single pane refetch instead of one per press.
  const keyRevalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The pane's harness adapter, resolved HERE (this is where the agent is known) so the neutral
  // draft helpers below stay harness-free: they take the capability, never the grammar. Undefined for
  // any agent without an adapter, which is exactly the "no idea" case those helpers already handle.
  const adapter = adapterFor(agent ?? undefined);

  // Guard against a false stranded-draft: if the detected draft is what we JUST sent, it's our own
  // reply still echoing on the "❯" line before the bridge's Enter, so suppress the preview. Applied
  // to the raw and the stabilised value alike (during the echo both carry our text). Recomputed each
  // render (each poll re-renders), so it
  // lapses on its own once the grace expires or the echo resolves; a genuinely stranded draft (never
  // matches a recent send) is untouched.
  const suppressEcho = (draft: string | null): string | null => {
    if (
      draft !== null &&
      lastSentRef.current !== null &&
      Date.now() - lastSentRef.current.at < SENT_ECHO_GRACE_MS &&
      isSelfEcho(draft, lastSentRef.current.text, adapter?.draftCarriesSend)
    ) {
      return null;
    }
    return draft;
  };
  // effectiveStable gates the preview's APPEARANCE (stabilised value); effectiveRaw is the live line
  // its text tracks.
  const effectiveStable = suppressEcho(terminalDraft);
  const effectiveRaw = suppressEcho(rawTerminalDraft);

  const startMessage = walky.startMessage;
  useImperativeHandle(
    ref,
    () => ({
      focusInput: focusInputImmediately,
      startMessage: (aim) => {
        startMessage(aim);
        focusInputImmediately();
      },
    }),
    [startMessage],
  );

  useEffect(
    () => () => {
      if (sentTimer.current) clearTimeout(sentTimer.current);
      if (lastSentTimerRef.current) clearTimeout(lastSentTimerRef.current);
      if (keyRevalidateTimer.current) clearTimeout(keyRevalidateTimer.current);
      for (const attachment of attachmentsRef.current) revokePreview(attachment);
      // An open Undo window dies with the view, and so do the previews it was holding.
      for (const attachment of clearedDraftRef.current?.attachments ?? []) revokePreview(attachment);
    },
    [],
  );

  // When the mirror delivers fresh output (text changed), the send has been echoed back — clear the
  // pending preview immediately regardless of the 6s fallback timer.
  useEffect(() => {
    setLastSent(null);
    if (lastSentTimerRef.current) {
      clearTimeout(lastSentTimerRef.current);
      lastSentTimerRef.current = null;
    }
  }, [text]);

  // Block a self-update reload while there's unsent work here: real typed text OR an upload in flight.
  // The composer input is phone-owned, so any non-empty value is genuine unsent work. A terminal draft
  // is SAFE on its own — it lives on the "❯" line and its preview re-derives after a reload — so it
  // never holds. When held, the self-updater shows the "tap to update" banner instead and updates once
  // the hold clears (see lib/self-update.ts). Keyed by pane so panes don't clobber each other's hold.
  // An open Undo window from the belt's X holds too: the box looks empty, but the draft it held is
  // still one tap from coming back, and a reload would take that tap away.
  useHoldReload(
    `composer:${paneId}`,
    hasDraft || clearedDraft !== null || direct.active || direct.value !== "" || direct.busy || uploading,
  );

  // Preview appearance latch. A STABLE, non-echo, not-already-handled draft flips the preview on —
  // this is the ONLY gate that waits for the 1.5s stability, so a blip or an in-flight send never
  // flashes it. Deliberately one-directional: once latched, rapid host typing (which keeps blanking
  // the stabilised value) can't turn it back off — the raw-tracking + unlatch effects own the hide
  // side. Skipped when the pane is gone, and while a send is in flight: the staged line then
  // carries our own text (attachments go out as host paths), and even a foreign draft waits until
  // the send completes rather than fighting it for the mirror.
  useEffect(() => {
    if (gone || sending) return;
    if (effectiveStable !== null && normalizeDraft(effectiveStable) !== handledKey) {
      setPreviewLatched(true);
    }
  }, [effectiveStable, handledKey, gone, sending]);

  // Unlatch when the host clears the "❯" line — the draft was submitted or wiped on the host, or our
  // own send echoed back and got suppressed to null. The preview unmounts on the next render. Also
  // forget the handled key: it exists only to stop the JUST-handled text re-latching before the line
  // clears — once the line has actually emptied, a later re-strand of the same text is a fresh draft
  // and must surface again (without this, taking over "continue" once muted every future "continue"
  // in the pane until you navigated away).
  useEffect(() => {
    if (effectiveRaw === null) {
      setPreviewLatched(false);
      setHandledKey(null);
      setPreviewDismissed(false);
    }
  }, [effectiveRaw]);

  // The journal settling an `unknown` send (#511): the sent text has landed as a user turn, so it
  // DID go through — however the person got it submitted. The notice and any offer retire, and the
  // draft goes ONLY while the field still holds exactly what it held at the tap: words typed since
  // are the person's next message, never this send's to clear. No "Sent ✓" and no preview — the
  // phone never saw this send land; it only stops claiming the outcome is unknown. A stranded
  // terminal line still echoing the same text is marked handled, as a verified send marks it, so
  // the "Draft in terminal" preview drops instead of outliving its own submission.
  useEffect(() => {
    if (pendingUnknown === null || chatEntries === undefined) return;
    if (findUnknownSendMatch(pendingUnknown, chatEntries) === undefined) return;
    setPendingUnknown(null);
    setProtocolOffer(null);
    setSendRefusal(null);
    if (
      pendingUnknown.isDraft &&
      inputValueRef.current === pendingUnknown.draftText &&
      composeLine(inputValueRef.current, attachmentsRef.current, isShell) === pendingUnknown.sentText
    ) {
      clearComposedDraftRef.current();
    }
    if (effectiveRaw !== null && normalizeDraft(effectiveRaw) === normalizeDraft(pendingUnknown.sentText)) {
      setHandledKey(normalizeDraft(effectiveRaw));
      setPreviewLatched(false);
    }
  }, [pendingUnknown, chatEntries, effectiveRaw, isShell]);

  // Show the preview while it's latched, the host line still carries a (non-echo) draft, and the user
  // hasn't already handled this exact text. Its displayed text is the LIVE raw line — host typing
  // streams straight into it (display-only; it can never write back into the phone-owned input). There
  // is no dismiss action — this is the ONLY way the preview hides short of the host line itself
  // clearing, since a draft that still normalises to `handledKey` is the one the user just took over
  // or sent, not a fresh one to re-show. Not gated on `locked`: read-only devices get the preview +
  // Take over (a local text copy); only the actual Send stays gated.
  const showPreview =
    !gone &&
    !sending &&
    previewLatched &&
    effectiveRaw !== null &&
    normalizeDraft(effectiveRaw) !== handledKey;

  // The floating notice (ADR 0061). The wrapper passes touches through (`pointer-events-none`) and
  // the notice takes them back, so the mirror under the empty part of the slot still scrolls.
  // `floating` below puts it in the pane view's slot when there is one; otherwise it floats above
  // this composer's own top edge.
  const draftNotice =
    showPreview && !previewDismissed && effectiveRaw !== null ? (
      <div data-slot="terminal-draft-notice" className="pointer-events-none">
        <TerminalDraftPreview
          text={effectiveRaw}
          // No Take over when the line is only the harness's own opaque token (Claude's
          // `[Pasted text #N +M lines]`): pulling that into the composer would send the literal
          // string. The preview keeps showing it — the screen really does say that.
          onTakeOver={adapter?.draftIsOpaque?.(effectiveRaw) ? null : takeOverDraft}
          onDismiss={() => setPreviewDismissed(true)}
        />
      </div>
    ) : null;

  // The offline draft note shares that place, and it holds one notice: when both are due, the
  // terminal draft wins and the note waits (still `shown`) until that notice is gone or dismissed.
  const offlineNote =
    draftNotice === null && draftNote === "shown" && offline ? (
      <div data-slot="offline-draft-note" className="pointer-events-none">
        <OfflineDraftNote onDismiss={() => setDraftNote("spent")} />
      </div>
    ) : null;
  const floatingNotice = draftNotice ?? offlineNote;

  // The sends the bridge holds for this pane (M56 spec 15) float in the same place as ONE card, so a
  // held send moves nothing (ADR 0061, amended 2026-10-18). It is keyed by pane: the card's Show all
  // is per pane and in memory, and a pane switch starts it collapsed. Rendered only while there is a
  // row, so an empty queue leaves nothing in the slot.
  const heldCard =
    heldRows !== undefined && heldRows.length > 0 ? (
      <HeldCard
        key={`${scopeId}|${paneId}`}
        paneId={paneId}
        scope={scope}
        rows={heldRows}
        canAct={isLead(scope) && !locked}
        sending={sending}
        onSend={resendHeld}
        onChanged={onSent}
      />
    ) : null;

  // Report a problem (ADR 0123): after three failed sends in a row on this pane, a card offers the report
  // sheet. It floats with the others, under the held card, so it moves nothing; the cross keeps it quiet
  // until the streak ends. Off on a crew member's pane (the next slice) and when Settings turned it off.
  const reportCard =
    reportOn && reportCount > 0 ? (
      <ReportCard
        count={reportCount}
        onReport={() => openReport({ paneId, scope, requestIds: streakIds(reportKey) })}
        onClose={() => closeTrouble(reportKey)}
      />
    ) : null;

  // The place both float in: a column, the held card on top and the draft or offline notice nearest
  // the belt, with a small gap. Pass-through wrapper (`pointer-events-none`); each card takes touches
  // back. In the pane view's slot the slot does the positioning; alone, the column floats above this
  // composer's own top edge. No `Collapse`: it is absolute, so it holds no space at all.
  // The last Clear's answer floats nearest the belt (ADR 0116, the Clear paragraph): its words, and Restore
  // while the cleared text is kept, the box reads empty and no dialog owns the keys, so the text is never
  // typed into a dialog or onto a draft.
  const restoreOpen =
    clearNote !== null && clearNote.draft !== null && clearNote.seenEmpty && way.keysSendable && shownSurface.composer === "empty" && shownSurface.modal === "none";
  const clearCard =
    clearNote !== null && clearNote.paneId === paneId ? (
      <ClearNotice refusal={clearNote.refusal} onRestore={restoreOpen ? () => void restoreDraft() : null} restoring={restoring} onDismiss={() => setClearNote(null)} />
    ) : null;
  const floating =
    heldCard !== null || reportCard !== null || floatingNotice !== null || clearCard !== null || (floatingHint !== undefined && floatingHint !== null) ? (
      <div
        data-slot="floating-cards"
        className={cn(
          "pointer-events-none flex flex-col gap-1.5",
          draftNoticeSlot ? undefined : "absolute inset-x-3 bottom-full z-20 mb-2",
        )}
      >
        {heldCard}
        {reportCard}
        {floatingNotice}
        {clearCard}
        {floatingHint}
      </div>
    ) : null;

  // Take over: the explicit "I'll handle this on mobile now" action. One-shot COPY of the current raw
  // draft into the composer (set on an empty input, else appended on a new line so mobile-typed work
  // survives), mark that exact text handled (so it can't instantly re-latch the preview — the raw line
  // still holds it until the host clears it), and hide the preview. No keys touch the terminal here,
  // and the phone never sweeps the line: a send onto it meets the bridge's draft offers. If the host
  // keeps typing and produces a DIFFERENT draft afterwards, the preview honestly reappears with the
  // new text.
  function takeOverDraft() {
    if (effectiveRaw === null) return;
    const draft = effectiveRaw;
    direct.deactivateSilently();
    updateInputFrom((prev) => (prev.trim() ? `${prev.trimEnd()}\n${draft}` : draft));
    setHandledKey(normalizeDraft(draft));
    setPreviewLatched(false);
    focusInputEnd();
  }

  // The operator's own palette rows, resolved against the shipped catalog for both the button's
  // visibility test here and the palette's own list below (same call, same arguments).
  const operatorCommands = useOperatorCommands();
  const claudeCommands = useClaudeCommands(drawer === "cmd", agent, paneId, scope, operatorCommands);
  const commands = commandsFor(agent, operatorCommands, claudeCommands);
  const todoList = todos ?? [];
  const todoDone = todoList.filter((item) => item.status === "completed").length;
  const todoLabel =
    todoList.length > 0
      ? translate("composer.controls.tasks", { done: todoDone, total: todoList.length })
      : "";
  // The running subagents: the agents mark on the belt's fixed block, and the Agents sheet it opens
  // (agents-sheet.tsx). The list is a sheet over the page, not a dock in flow, so opening it moves
  // nothing (Altan, 2026-10-19: "we hate layout shifts"). A tap on a row opens the SAME sheet an Agent
  // card in Chat opens (subagent-sheet.tsx), through the context the pane route provides, as a second
  // layer over the list: the list stays open under it, so closing the transcript comes back to it.
  const subagentList = subagents ?? [];
  const agentsLabel =
    subagentList.length > 0 ? translate("composer.controls.agents", { count: subagentList.length }) : "";
  const [agentsOpen, setAgentsOpen] = useState(false);
  const subagentSheet = useContext(SubagentSheetCtx);
  const beltSubagent = useRef<SubagentTarget | null>(null);
  const openSubagent = (subagent: PaneSubagent) => {
    if (subagentSheet === null) return;
    // `agent` is the name `agentLabel` draws; absent, the sheet reads plain "Agent", as a card does.
    const target: SubagentTarget = {
      cardKey: `${BELT_SUBAGENT_KEY}${subagent.agentId}`,
      agent: subagentName(subagent),
      summary: subagent.description,
      agentId: subagent.agentId,
      status: "running",
    };
    beltSubagent.current = target;
    subagentSheet.open(target);
  };
  // Both sheets hear one Escape (each listens on the window), so the list ignores a close while a
  // transcript it opened stands over it: Escape takes the top layer away and leaves the list.
  const transcriptOver = subagentSheet?.activeCardKey?.startsWith(BELT_SUBAGENT_KEY) === true;
  const closeAgents = () => {
    if (!transcriptOver) setAgentsOpen(false);
  };
  // A sheet opened from the belt has no Chat card to tell it the subagent ended. When the subagent
  // leaves the running list, the sheet hears it from here, stops polling and shows the report.
  const runningIds = subagentList.map((s) => s.agentId).join(" ");
  const activeSheetKey = subagentSheet?.activeCardKey ?? null;
  const syncSubagent = subagentSheet?.sync;
  useEffect(() => {
    const target = beltSubagent.current;
    if (target === null || syncSubagent === undefined || activeSheetKey !== target.cardKey) return;
    if (target.agentId !== undefined && runningIds.split(" ").includes(target.agentId)) return;
    syncSubagent({ ...target, status: "done" });
  }, [activeSheetKey, runningIds, syncSubagent]);
  // The suggestions above the box read the agent's command list only (the shipped catalog, or the
  // operator's rows): never the skill and command files the palette finds on disk.
  const commandSuggestions = locked || direct.active || isShell ? [] : suggestCommands(input, commandsFor(agent, operatorCommands));
  // What this collie takes as an attachment, off the same one-shot /api/config read. On a bridge
  // that publishes nothing (older than the field, or the read has not landed) `uploadLimits` answers
  // with the contract that shipped before attachments — images, 10 MB — so the button is never
  // dead and never offers what this host would refuse.
  const limits = uploadLimits(useUploadCapability());
  const accept = acceptAttribute(limits);
  // Whether the attach button ASKS. On a host that takes images and nothing else there is one
  // answer, so it opens the camera roll and no sheet is drawn.
  const asksWhich = offersFiles(limits);
  const [picking, setPicking] = useState(false);
  // The Send button's long-press menu (M62): one row today, "Send as message". Opened by a HOLD, never
  // armed by it: the row is a named choice, and the hold alone sends nothing.
  const [sendMenu, setSendMenu] = useState(false);
  /**
   * THE ATTACH BUTTON'S OWN PRESS ECHO.
   *
   * Every other control on this row acknowledges a tap by changing what is on screen at once: Send
   * empties the box, the mic starts counting, a key press flips its row accent. Attach hands the
   * tap to something that is NOT on screen yet — a sheet 240ms away, or a native picker whose delay
   * belongs to the phone and not to this app — so for that beat the tap looked lost.
   *
   * Two channels, deliberately, and the buzz is the one that matters: it lands under the thumb
   * before any pixel can (`lib/haptics.ts`'s whole argument). The accent tone is the same "your
   * press landed" language `quick-actions.tsx` and the dialog option rows already speak, so this
   * adds no new vocabulary — only a control that was missing it.
   *
   * NOT `useActionEcho`: that hook's phases are about a bridge accepting an action, and there is no
   * bridge here. Opening a picker is fire-and-forget, so the echo is a timer and nothing else.
   */
  const [pressed, setPressed] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    };
  }, []);

  function echoAttachPress() {
    buzz();
    setPressed(true);
    if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => setPressed(false), ATTACH_PRESS_MS);
  }
  // The Keys tray's preset row, resolved the same way from the same one-shot read of /api/config.
  const keyPresets = ctrlPresetsFor(agent, useOperatorKeys());
  // The key board (ADR 0092): the pad the Keys dock draws. A hook, so an edit made in the
  // editor sheet shows in the dock at once.
  const keyBoard = useKeyBoard();
  const [keysEditorOpen, setKeysEditorOpen] = useState(false);
  // Empty on every adapter that refuses nothing, and empty for Herdr's six as far as this tray is
  // concerned — it offers none of the paging/edit keys Herdr rejects, so nothing greys out there.
  const unsupportedKeys = useMuxUnsupportedKeys();

  function focusInputImmediately() {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }

  function focusInputEnd() {
    setTimeout(focusInputImmediately, 0);
  }

  // SENT (M61): on a shell pane, the lines sent through Collie come back from a sheet (the belt's
  // Sent, or the strip's "All") and as suggestions above the box. Both only put a line in the box.
  // Sending it is the person's own tap on Send, which runs the ordinary Send Protocol with a request
  // id of its own.
  const [sentOpen, setSentOpen] = useState(false);
  // Whether the text box has focus: the suggestion strip is there only then, like a keyboard's.
  const [boxFocused, setBoxFocused] = useState(false);
  const suggestionsOn = isShell && sentSuggestionsOf(prefs);
  const suggestions = useSentSuggestions({ enabled: suggestionsOn, scope, cwd });
  function pickSent(line: string) {
    direct.deactivateSilently();
    updateInput(line);
    focusInputEnd();
  }

  // What a confirmed send (`sent` or `effective`) does to this composer: the draft goes, the check
  // mark flashes, the pill says sent, the preview keeps the text.
  // `note` says where the text went: out (`sent`), into the harness's own queue (`queued`), or into the
  // bridge's held row above the box (`held`), which is not a send yet and so leaves no "You sent" preview.
  function afterVerifiedSend(t: string, isDraft: boolean, note: "sent" | "queued" | "held" | "steered" | "queuedInstead" = "sent") {
    // The bridge has a new line now (a shell pane only: the read is off elsewhere).
    suggestions.refresh();
    // Phone-owned input, cleared once the reply is on its way. Via updateInput, so the stored
    // draft goes with it (an empty value removes the key).
    // The chips go with the text: their paths were in the line that just went out.
    if (isDraft) clearComposedDraft();
    // Remember what/when we sent, so the next few polls recognise this text echoing on the "❯"
    // line as our own in-flight reply rather than a stranded draft (suppressEcho above).
    if (note !== "held") lastSentRef.current = { text: t, at: Date.now() };
    // The stranded line was just swept and our text sent, so mark it handled and drop the preview so
    // it can't flash back before the mirror echoes the cleared line.
    if (effectiveRaw !== null) {
      setHandledKey(normalizeDraft(effectiveRaw));
      setPreviewLatched(false);
    }
    // ✓ flash on the send button + status line acknowledge a VERIFIED send (the text was seen in
    // the input box before the submit key went out), so this lands slightly later than the old
    // fire-and-forget ✓ but is now actually true. The "You sent: …" pending preview keeps the
    // typed text visible until the mirror catches up (cleared by the next text update or a 6s
    // safety timeout).
    if (note !== "held") {
      setJustSent(true);
      if (sentTimer.current) clearTimeout(sentTimer.current);
      sentTimer.current = setTimeout(() => setJustSent(false), 1500);
    }
    // A send that went in while the agent worked waits for the turn's end: the status line says so,
    // in the place "Sent" stands, never as a refusal.
    // A steer (M69) has two more words: `steered`, and `queuedInstead` when the harness queued the text
    // the person asked to steer with. A steer never leaves a plain "Sent" behind that says neither.
    setStatus(translate(STATUS_KEY[note]), "success");
    if (note !== "held") {
      const preview = t.length > 60 ? `${t.slice(0, 57)}…` : t;
      setLastSent(preview);
      if (lastSentTimerRef.current) clearTimeout(lastSentTimerRef.current);
      lastSentTimerRef.current = setTimeout(() => setLastSent(null), 6000);
    }
    setSendRefusal(null); // a clean send answers the last refusal
    noticeNoEcho(null); // whatever prompt it described, the pane has moved past it
    onSent(); // you just acted, so snap the mirror back to the live tail to see the result
  }

  // Resolves true only on a send the bridge confirmed (`sent` or `effective`). The quick-reply grid
  // consumes the verdict to drive its own check mark and to decide whether to close its dock, so
  // every early return below has to answer honestly.
  //
  // THE ONE TEXT PATH (M56 spec 06). Every text goes to the bridge as one Send Protocol request: the
  // bridge reads the screen fresh, refuses a dialog, a draft or a screen it cannot read before any key,
  // probes where it must, and answers with a receipt. The phone reads nothing before a send and sends
  // no key of its own: no pre-flight, no type-then-verify, no sweep of a stranded draft (a draft in
  // the box is refused `draft_present` and offered Add, Replace or Cancel). A text that starts with a
  // reserved lead (`/`, `!`, `@`) goes as a `command`, whose popup under the box is expected.
  async function send(value: string, isDraft: boolean, when?: SendWhen): Promise<boolean> {
    // A shell line keeps its leading space or tab, which keeps it out of Sent (M61): the bridge checks
    // the raw text. An agent pane's text is trimmed at both ends, as it always was. The emptiness
    // check and the mode read the fully trimmed text on both, so neither sees a difference.
    const trimmed = value.trim();
    const t = isShell ? value.trimEnd() : trimmed;
    if (!trimmed || locked || sending) return false;
    if (offlineRef.current) {
      setSendRefusal(phoneRefusal(translate("composer.send.reconnect")));
      return false;
    }
    // A modal ask is a parsed fact: its own buttons answer it, and its word stands in the Send slot.
    // A typed text would be refused by the bridge anyway; the phone does not ask (spec 10). A send that
    // comes from elsewhere (a quick reply, a harness command) is told so at the Send slot.
    if (slot === "answer") {
      setSendRefusal(phoneRefusal(translate("composer.status.dialogWaiting"), true));
      return false;
    }
    return sendThroughProtocol(t, isDraft, modeFor(trimmed), null, false, undefined, when);
  }

  // One Send Protocol request (lib/reply-action.ts). The id is kept for a retry of the same intent
  // (mode, rows hash, text) until an answer arrives, so a lost answer never sends twice; an answer
  // ends the intent, and every offer it makes is a new one with a new id. Resolves true only on
  // `sent`, `effective` or a `discarded` the bridge took.
  // `resend` is a resend of an ended held row: the request carries the old id and an empty text, the
  // bridge takes the row's own text, and `shown` (the row's text, maybe masked) is only for the preview.
  async function sendThroughProtocol(t: string, isDraft: boolean, mode: SendMode, rowsHash: string | null, capAck = false, resend?: { oldId: string; shown: string }, when?: SendWhen): Promise<boolean> {
    setSending(true);
    setSendRefusal(null);
    setPendingUnknown(null); // a new send supersedes the last one's open question (#511)
    // What an `unknown` answer would have to be settled against (#511): when this send started,
    // which journal turns already stood, and what the field held. Snapshotted before the request,
    // so a turn landing while it is in flight still counts as this send's.
    const sentAt = Date.now();
    const seenUserUuids = new Set((chatEntriesRef.current ?? []).map((entry) => entry.uuid));
    const draftAtSend = inputValueRef.current;
    // A send ends the belt X's Undo window: the operator has moved on, and an Undo landing after
    // the send would put back a draft the pane has since answered.
    endUndoWindow();
    // The operator has just acted on this pane, so the poller should watch it land, from the tap on.
    stampSend(paneId);
    try {
      const res = await sendText({ paneId, text: t, scope, mode, rowsHash, capAck, resendOf: resend?.oldId, when, held: protocolIntent.current });
      if (res.status === "noAnswer") {
        // No answer: the id stays, so the next tap on the same text asks for the same request.
        protocolIntent.current = res.intent;
        setSendRefusal(phoneRefusal(translate("composer.protocol.retry", { error: res.error })));
        return false;
      }
      protocolIntent.current = null;
      if (res.status === "refused") {
        setSendRefusal(phoneRefusal(res.error));
        return false;
      }
      const { reply, reading } = res;
      // Report a problem (ADR 0123): the answer joins this pane's streak. Plain rules over the outcome and
      // reason (lib/report/trouble.ts); nothing is sent and nothing is retried. This machine's panes only.
      if (reportOn && reply.outcome !== null) {
        noteSend(reportKey, paneId, { requestId: res.requestId, outcome: reply.outcome, reason: reply.reason, cap: reply.cap !== null, at: Date.now() });
      }
      if (reading.clear) {
        setProtocolOffer(null);
        afterVerifiedSend(resend?.shown ?? t, isDraft, verifiedNote(reading.note, when));
        return true;
      }
      // A resend makes no offer: an offer would carry the row's text, which may be masked.
      const offered = reading.offers.length > 0 && resend === undefined;
      setProtocolOffer(offered ? { text: t, isDraft, rowsHash: reply.rowsHash, offers: reading.offers, capAck: reading.cap !== null } : null);
      const refusal = readingRefusal(reading);
      setSendRefusal(
        returnedDraft && reading.note === "draft" ? { ...refusal, sentence: translate("composer.protocol.draftIsReturned") } : refusal,
        reply.surface ?? shownSurface,
        offered,
      );
      // An `unknown` outcome is an open question the journal can still answer (#511): remember the
      // send, so its text landing as a user turn retires this notice and the kept draft. A resend
      // carries no text of its own to recognise, so it is never remembered.
      if (reading.note === "unknown" && resend === undefined) {
        setPendingUnknown({ sentText: t, draftText: draftAtSend, isDraft, at: sentAt, seenUserUuids });
      }
      // A password prompt on the screen the composer already shows (#103): the bridge could not see
      // the text land, because the prompt never echoes it. Say so, drop the stored draft, offer Type.
      // A display read only; the bridge's answer is the verdict.
      const prompt = detectNoEchoPrompt(splitLines(parseAnsi(text)));
      if (prompt !== null) noticeNoEcho({ prompt, typed: reading.note === "typed" || reading.note === "unknown" });
      // The person's next look is the pane: snap the mirror to the live tail, as a send does.
      onSent();
      // A discard the bridge took clears nothing of the draft, but the request went through: a held row's Discard dismisses on it.
      return reading.note === "discarded";
    } finally {
      setSending(false);
    }
  }

  // A tap on an ended held row. Resend: a NEW request (a new id) that names the old one in `resendOf`
  // with an empty text; the bridge sends the row's stored text and mode and drops the old row itself,
  // so the phone never sends the row's text back (it may be masked). Submit and Discard on a row that
  // ended `typed_not_submitted` go the way the offer strip's do (mode `submit` or `discard`, the text
  // the box holds). Never a draft, so the box keeps whatever the person is typing now. True when the
  // bridge took it.
  function resendHeld(row: HeldRow, action: HeldAction): Promise<boolean> {
    if (sending || locked) return Promise.resolve(false);
    if (action === "resend") return sendThroughProtocol("", false, row.mode, null, false, { oldId: row.requestId, shown: row.text });
    return sendThroughProtocol(row.text, false, action, null);
  }

  // A tap on an offer the last answer made: a new request with a new id, or nothing (`cancel`).
  function onProtocolOffer(offer: SendOffer) {
    const held = protocolOffer;
    setProtocolOffer(null);
    setSendRefusal(null);
    if (held === null || sending || locked) return;
    const mode = offerMode(offer, held.text);
    if (mode === null) return;
    // Added to a draft, the text starts after one space, as a person typing on would put it.
    const words = offer === "append" && !/^\s/u.test(held.text) ? ` ${held.text}` : held.text;
    // The commit, Submit and Discard carry the rows hash of the answer the person read: the bridge goes
    // ahead only while the screen still hashes the same. After the cap's notice the commit is the extra
    // confirm: it carries `capAck` (M56 spec 09).
    const seen = offer === "commit" || offer === "submit" || offer === "discard" ? held.rowsHash : null;
    void sendThroughProtocol(words, held.isDraft, mode, seen, offer === "commit" && held.capAck);
  }

  // Gate the composer's Send through the destructive-input confirm: a matching command arms the
  // "Really send?" state instead of sending; the confirming second tap goes through. Non-destructive
  // input sends immediately (and any stray armed state is cleared).
  // `when` is M69's explicit choice from the Send button's menu: `steer` takes the text into the running
  // turn. A destructive line arms "Really send?", and the confirming tap must send what was armed, so
  // `armedWhen` keeps the choice across the two taps (the confirm button calls this with it).
  function onSendClick(when?: SendWhen) {
    // A reply in message mode goes to the other session through the bridge's walky route, and is not
    // typed into this pane by us, so the destructive-command guard (a shell concern) does not apply.
    if (walky.aim !== null) {
      void walky.sendMessage(composeLine(input, attachments));
      return;
    }
    // The line the terminal gets: every chip's marker swapped for its path (ADR 0060). Both the
    // destructive check and the send read THIS, never the draft with its markers in it.
    const line = composeLine(input, attachments, isShell);
    const reason = isDestructiveInput(line);
    if (reason && !sendConfirm.confirm("send")) {
      armedWhen.current = when;
      // On a crew the confirm names the machine as well as the pattern: "rm -r" is a different
      // sentence depending on whose disk it runs on, and this line is the last thing read before the
      // second tap. Solo copy is unchanged, byte for byte.
      setDestructiveNote(
        writeHostLabel
          ? translate("composer.destructive.confirmOnHost", { reason, host: writeHostLabel })
          : translate("composer.destructive.confirm", { reason }),
      );
      return;
    }
    sendConfirm.reset();
    setDestructiveNote(null);
    armedWhen.current = undefined;
    void send(line, true, when);
  }
  const confirmingSend = sendConfirm.pending === "send";
  // A modal ask owns the agent's keyboard: the Send slot and the placeholder say so (spec 10).
  const askOwnsKeys = slot === "answer" && !direct.active;
  // The refusal's reason at the thumb. Not in Type mode, and not beside the password notice, which
  // already says why at this spot. With an ask it stands beside the "Answer the dialog" word: a send
  // that came from a quick reply has no other place to be told.
  const refusalShown = sendRefusal !== null && shownRefusalKey !== hiddenRefusalKey && !direct.active && noEcho === null;
  // The way on, as buttons in the notice: the card, the screen, the Keys dock. Each only where it can do
  // something: the Screen when it is not showing, the Keys dock when it can open and is not open.
  const refusalCard = sendRefusal?.toCard === true && onAnswerDialog !== undefined && dialogCard;
  const refusalScreen = sendRefusal?.screen === true && screen !== undefined && !screen.on;
  const refusalKeys = way.keysOpen && drawer !== "keys";
  // What the field's placeholder says: the facts first (a pane that is gone, a device that may not
  // write, a box out of reach), then Type mode, then the shell line, then (M69) the Steer hint while a
  // turn runs on a harness that can steer, then the ordinary reply line. The placeholder names no other
  // state: the notices, the Screen pill and the Send slot carry those.
  //
  // THE STEER HINT LIVES HERE, NOT IN A ROW OF ITS OWN. It was a line above the box inside a Collapse,
  // so it opened and closed with every turn and moved the belt and the field (Altan, 2026-10-25: a
  // composer hint must not shift the layout). A placeholder takes no height of its own, and it goes
  // when the first character is typed, which is when the operator no longer needs it.
  // The hint is ONE short sentence so it never wraps at placeholder:text-xs; a wrapped placeholder grows a
  // `field-sizing-content` field.
  const steerWords =
    way.state !== "gone" && way.state !== "readOnly" && way.state !== "unreachable" && !direct.active && !isShell && steerRow;
  // A box the bridge proved stale (2026-10-25: the screen shows an input box that did not take keys)
  // says so in the same place, before the Steer hint: a send probes the box first, so the person knows
  // why a send may come back refused.
  const staleWords = way.state !== "gone" && way.state !== "readOnly" && way.state !== "unreachable" && !direct.active && !isShell && surface.staleFrame === true;
  const placeholderWords =
    way.state === "gone"
      ? translate("composer.placeholder.gone")
      : way.state === "readOnly"
        ? translate("composer.placeholder.readOnly")
        : way.state === "unreachable"
          ? unreachableWords
          : direct.active
            ? translate("composer.placeholder.direct")
            : isShell
              ? translate("composer.placeholder.shell")
              : staleWords
                ? translate("composer.stale.hint")
                : steerWords
                  ? translate("composer.steer.hint")
                  : translate("composer.placeholder.reply");

  // Coalesce revalidations from a burst of key presses, LEADING edge first: the first press in a
  // burst refetches immediately, and only presses that arrive inside the window collapse into one
  // trailing refetch. It used to be trailing-only, which meant a lone press — the common case — sat
  // out the full window before its fetch even *started*, and if that fetch then beat the TUI's
  // repaint you waited a whole 1.5s poll to see anything. Arrow-key spam still coalesces exactly as
  // before: presses 2..n only ever schedule the one trailing refetch.
  function scheduleKeyRevalidate() {
    if (keyRevalidateTimer.current === null) {
      revalidator.revalidate(); // leading edge
      // Cooldown only — it fires nothing itself; a press landing before it expires replaces it with
      // the trailing refetch below.
      keyRevalidateTimer.current = setTimeout(() => {
        keyRevalidateTimer.current = null;
      }, KEY_REVALIDATE_MS);
      return;
    }
    clearTimeout(keyRevalidateTimer.current);
    keyRevalidateTimer.current = setTimeout(() => {
      keyRevalidateTimer.current = null;
      revalidator.revalidate(); // trailing edge — one refetch for the whole burst
    }, KEY_REVALIDATE_MS);
  }

  // Raw key send (nav tray). Resolves the bridge's verdict so the pressed button can echo it — the
  // mirror is still the source of truth for what the key DID, but it can be ~2s behind, and this
  // path used to be silent on success, so a press looked like it went nowhere. Errors still go to
  // the status channel; the echo just falls back to idle.
  async function pressKeys(k: string[]): Promise<boolean> {
    // Only a pane that is gone, a device that may not write, or a multiplexer with no key to send stops
    // the pad (lib/way-out.ts): a box out of reach, a refused send and a stale read never do.
    if (!way.keysOpen) return false;
    if (offlineRef.current) {
      setStatus(translate("composer.send.reconnect"), "error");
      return false;
    }
    // Every raw key reaches the pane through here — the Keys dock (NavTray's `onSend`), the direct
    // typing mode (useDirectTyping's `sendKeys`) and the prompt buttons that hand keys to the tray.
    // No stamp here: `api.sendKeys` starts the poll burst for every key written.
    try {
      const res = await api.sendKeys(paneId, k, scope);
      if (!res.ok) {
        setStatus(describeApiError(res), "error");
        return false;
      }
      scheduleKeyRevalidate();
      return true;
    } catch (e) {
      setStatus(describeThrownError(e), "error");
      return false;
    }
  }

  // Insert "/cmd " into the composer (arg-taking commands) and focus it. Appends to any draft already
  // typed (with a separating space) rather than clobbering it; an empty draft just gets set.
  function insertCommand(value: string) {
    direct.deactivateSilently();
    updateInputFrom((prev) => (prev.trim() ? `${prev.trimEnd()} ${value}` : value));
    focusInputEnd();
  }
  function selectSuggestion(command: AgentCommand) {
    direct.deactivateSilently();
    updateInput(`${command.command} `);
    focusInputEnd();
  }

  // Upload an attachment; on success it becomes a chip above the field, and its marker lands in the
  // draft where the caret stood (ADR 0060). Shared by the file picker and clipboard paste.
  //
  // The two local refusals below are an ECONOMY, never a gate: the bridge asks the same two
  // questions again on arrival, and its answer is the one that counts (it can read the bytes, which
  // is the only way to catch a binary wearing a `.md` name). Spending a phone's uplink on 40 MB to
  // be told 10 is the limit is the thing worth not doing.
  async function uploadFile(file: File) {
    if (locked) return;
    const refusal = rejectAttachment(file, limits);
    if (refusal === "tooLarge") {
      setStatus(translate("composer.upload.tooLarge", { max: limitMb(limits) }), "error");
      return;
    }
    if (refusal === "badType") {
      setStatus(translate("composer.upload.badType", { name: file.name }), "error");
      return;
    }
    setUploading(true);
    try {
      const res = await api.uploadFile(paneId, file, scope);
      if (res.ok) {
        direct.deactivateSilently();
        addAttachment(file, res.path);
        setStatus(translate("composer.upload.success"), "success");
      } else {
        setStatus(describeApiError(res), "error");
      }
    } catch (err) {
      setStatus(describeThrownError(err), "error");
    } finally {
      setUploading(false);
    }
  }

  /**
   * A finished upload joins the draft: a chip with the next number, and its marker at the caret.
   *
   * The caret is the field's own while it has focus (the attach button keeps focus on the field by
   * refusing its own `pointerdown`), else the last one `caretRef` saw, else the end. After the
   * insert the caret stands past the marker, so a multi-photo pick lays its markers down in pick
   * order, each after the one before.
   */
  function addAttachment(file: File, path: string) {
    const n = nextMarkerNumber(inputValueRef.current, nextAttachmentRef.current);
    nextAttachmentRef.current = n + 1;
    const kind = attachmentKind(file, limits);
    const attachment: ComposerAttachment = { n, path, name: file.name, kind };
    if (kind === "image") {
      const previewUrl = makePreview(file);
      if (previewUrl !== undefined) attachment.previewUrl = previewUrl;
    }
    const field = inputRef.current;
    const caret =
      field !== null && document.activeElement === field ? field.selectionStart : caretRef.current;
    const placed = insertMarker(inputValueRef.current, caret, markerFor(attachment));
    attachmentsRef.current = [...attachmentsRef.current, attachment];
    setAttachments(attachmentsRef.current);
    caretRef.current = placed.caret;
    updateInput(placed.text);
    focusInputAt(placed.caret);
  }

  /** The chip's x: the chip goes, and so does its marker (with one space beside it). Deleting the
   *  marker by hand instead keeps the chip, which then shows it will go in front (`inFront`), and
   *  Send puts its path there (`composeLine`). */
  function removeAttachment(attachment: ComposerAttachment) {
    revokePreview(attachment);
    attachmentsRef.current = attachmentsRef.current.filter((a) => a.n !== attachment.n);
    setAttachments(attachmentsRef.current);
    caretRef.current = null;
    updateInput(removeMarker(inputValueRef.current, markerFor(attachment)));
  }

  function addPasteAttachment(pastedText: string) {
    const n = nextMarkerNumber(inputValueRef.current, nextAttachmentRef.current);
    nextAttachmentRef.current = n + 1;
    const attachment: ComposerAttachment = {
      n,
      path: pastedText,
      name: pastePreviewName(pastedText),
      kind: "paste",
    };
    const field = inputRef.current;
    const start =
      field !== null && document.activeElement === field ? field.selectionStart : caretRef.current;
    const end =
      field !== null && document.activeElement === field ? field.selectionEnd : start;
    const placed = insertMarker(inputValueRef.current, start, markerFor(attachment), end);
    attachmentsRef.current = [...attachmentsRef.current, attachment];
    setAttachments(attachmentsRef.current);
    caretRef.current = placed.caret;
    updateInput(placed.text);
    focusInputAt(placed.caret);
  }

  function updatePasteAttachment(n: number, nextContent: string) {
    attachmentsRef.current = attachmentsRef.current.map((a) =>
      a.n === n && a.kind === "paste"
        ? { ...a, path: nextContent, name: pastePreviewName(nextContent) }
        : a,
    );
    setAttachments(attachmentsRef.current);
    persistDraft();
  }

  function expandPasteAttachment(n: number) {
    const target = attachmentsRef.current.find((a) => a.n === n && a.kind === "paste");
    if (target === undefined) return;
    setEditingPaste(null);
    attachmentsRef.current = attachmentsRef.current.filter((a) => a.n !== n);
    setAttachments(attachmentsRef.current);
    const expanded = expandAttachmentInText(inputValueRef.current, target);
    caretRef.current = expanded.length;
    updateInput(expanded);
    focusInputEnd();
  }

  /** After a verified send: the text, the chips and their previews all go, and numbering restarts. */
  function clearComposedDraft() {
    for (const attachment of attachmentsRef.current) revokePreview(attachment);
    attachmentsRef.current = [];
    setAttachments([]);
    caretRef.current = null;
    updateInput("");
  }

  /**
   * THE BELT'S X (M40 spec 04, issue #291): the text, the chips and the stored draft go, and nothing
   * is sent to the pane. It is the phone's own draft and only that; the agent's input box keeps its
   * own ways (the Keys tray, and the bridge's Replace offer on a send).
   *
   * What went is held for Undo, previews and all, which is the one difference from
   * `clearComposedDraft`: those previews are released when the window ends without an Undo, not
   * here. Armed send confirms go too, because the draft they were about is gone.
   */
  function clearByHand() {
    if (sending) return;
    const field = inputRef.current;
    const held: ClearedDraft = {
      text: inputValueRef.current,
      attachments: attachmentsRef.current,
      next: nextAttachmentRef.current,
      caret: field !== null && document.activeElement === field ? field.selectionStart : caretRef.current,
    };
    endUndoWindow();
    sendConfirm.reset();
    attachmentsRef.current = [];
    setAttachments([]);
    caretRef.current = null;
    // Through the write-through, so the stored entry goes in the same tick (lib/drafts.ts drops the
    // key for an empty draft), and it restarts the chip numbering as a send does.
    updateInput("");
    clearedDraftRef.current = held;
    setClearedDraft(held);
  }

  /** Undo: the text, the chips with their previews, the chip numbering and the stored draft come
   *  back as they were, through the same write-through as a keystroke. Under a recognised password
   *  prompt that write-through stores nothing (ADR 0017), so Undo stores nothing either. */
  function undoClear() {
    const held = clearedDraftRef.current;
    if (held === null) return;
    clearedDraftRef.current = null;
    setClearedDraft(null);
    attachmentsRef.current = held.attachments;
    setAttachments(held.attachments);
    nextAttachmentRef.current = held.next;
    caretRef.current = held.caret;
    updateInput(held.text);
    // The caret goes back where it stood, but only into a field that still has focus: focusing it
    // here would raise a keyboard the operator had put away. Deferred, as every caret move in this
    // component is, so React has swapped the value first.
    const caret = held.caret ?? held.text.length;
    setTimeout(() => {
      const el = inputRef.current;
      if (el !== null && document.activeElement === el) el.setSelectionRange(caret, caret);
    }, 0);
  }

  /** End the Undo window, if one is open: the slot shows the X again when the box holds a draft and
   *  empties when it does not, and the held chips' previews are released. */
  function endUndoWindow() {
    const held = clearedDraftRef.current;
    if (held === null) return;
    clearedDraftRef.current = null;
    setClearedDraft(null);
    for (const attachment of held.attachments) revokePreview(attachment);
  }

  // The pane-change effect ends the window on its way out and must not name a per-render function
  // as a dependency, so it calls the current one through this ref (the noticeNoEchoRef pattern).
  const endUndoWindowRef = useRef(endUndoWindow);
  endUndoWindowRef.current = endUndoWindow;

  /** What the belt's clear slot shows: Undo while a window is open, the X while the box holds a
   *  draft, nothing otherwise. The X is inert, never withdrawn, while a send is in flight (its Undo
   *  could put back a message that is on its way) and while Type is armed (the field is a live
   *  keyboard then, not a draft). Not gated on `locked`: the draft is this phone's own, so a
   *  read-only device or a gone pane may still empty its box, as Display is not gated either. */
  function clearSlot() {
    if (clearedDraft !== null) {
      return {
        mode: "undo" as const,
        label: translate("composer.controls.undoClear"),
        onClick: undoClear,
        onOtherPress: endUndoWindow,
      };
    }
    if (!hasDraft) return undefined;
    return {
      mode: "clear" as const,
      label: translate("composer.controls.clear"),
      onClick: clearByHand,
      inert: sending || direct.active,
    };
  }

  function focusInputAt(caret: number) {
    setTimeout(() => {
      const field = inputRef.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(caret, caret);
    }, 0);
  }

  /** Remember the caret whenever the field reports one, so a marker can land there later. */
  function rememberCaret(e: { currentTarget: HTMLTextAreaElement }) {
    caretRef.current = e.currentTarget.selectionStart;
  }

  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-picking the same file(s)
    for (const file of files) {
      await uploadFile(file);
    }
  }

  // Paste a file straight from the clipboard (e.g. a screenshot) the same way the picker does.
  //
  // A PLAIN TEXT PASTE STILL FALLS THROUGH UNTOUCHED, and that stays true now that text files are
  // attachable: the branch turns on `item.kind === "file"`, so pasted PROSE is prose and only a
  // pasted FILE becomes an upload. Copying a `.md` in a file manager produces the second; selecting
  // its contents in an editor produces the first, and neither has become the other.
  function onPasteFile(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (locked || direct.active) return;
    const items = e.clipboardData?.items ?? [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (!file) continue;
      if (rejectAttachment(file, limits) === "badType") continue;
      e.preventDefault();
      void uploadFile(file);
      return;
    }
    const pastedText = e.clipboardData?.getData?.("text/plain") ?? "";
    if (!isCollapsiblePaste(pastedText)) return;
    e.preventDefault();
    addPasteAttachment(pastedText);
  }

  const activePaste =
    editingPaste !== null && editingPaste.paneId === paneId && editingPaste.scopeId === scopeId
      ? attachments.find((a) => a.n === editingPaste.n && a.kind === "paste")
      : undefined;

  // Collie's own pills, as the belt below draws them, kept so that a large screen's belt tap in another
  // column can run one by id once this composer mounts for that pane (ADR 0120, lib/belt-intent.ts).
  const beltPills = useRef<readonly GeneralAction[]>([]);
  const keepBelt = (pills: GeneralAction[]): GeneralAction[] => {
    beltPills.current = pills;
    return pills;
  };
  const beltTap = useRef({ locked, send, stop: stopOffered ? stopTurn : null, changesPill, agents: subagentList.length > 0 });
  beltTap.current = { locked, send, stop: stopOffered ? stopTurn : null, changesPill, agents: subagentList.length > 0 };
  // The tap moved the focus here and left its act, which runs once, through the same handler and gates
  // as a tap on this belt. A pill this belt does not draw, or draws disabled, does nothing.
  useEffect(() => {
    const intent = takeBeltIntent(paneScopeKey(scope, paneId));
    if (intent === null) return;
    const tap = beltTap.current;
    if (intent.kind === "action") {
      const pill = beltPills.current.find((a) => a.id === intent.id);
      if (pill !== undefined && pill.disabled !== true) pill.onSelect();
    } else if (intent.kind === "run") {
      if (!tap.locked) void tap.send(intent.text, false);
    } else if (intent.kind === "changes") {
      tap.changesPill?.onClick();
    } else if (intent.kind === "agents") {
      if (tap.agents) setAgentsOpen(true);
    } else if (tap.stop !== null) {
      void tap.stop();
    }
  }, [scope, paneId]);

  return (
    <>
      <div
        ref={blockRef}
        className={cn(
          // `relative` anchors the floating draft notice when no slot was handed in (ADR 0061).
          "relative bg-chrome px-3",
          blockPad,
          // THE COMPOSER, KEPT LAID OUT UNDER THE VOICE TAKEOVER. `invisible` hides the real controls
          // and `inert` takes them out of focus, taps and the screen-reader tree, and both leave the
          // box in flow, so the block keeps exactly the height it had. The takeover is drawn over it
          // as a sibling, `absolute inset-0` in the chrome block that holds both
          // (components/voice-takeover.tsx). That is the whole of the zero-shift argument.
          takeoverOpen && "invisible",
        )}
        inert={takeoverOpen}
      >
        {/* Pending-send preview: visible from send until the mirror echoes back (or 6s). Shows the
            user what landed so they don't double-tap while waiting for the terminal to update.
            IT STAYS IN THE FOOTER, AND IT IS NOT A PILL. The "sent" ping already IS one — send()
            publishes `composer.status.sent` on the same line, and the top pills carry it. What is
            left here is the other half, and it is a VERIFICATION surface: the ✓ says the text was
            seen in the input box before the submit key went out (see send()), and this holds the
            words themselves on screen until the mirror echoes them back, so the operator can check
            what landed instead of tapping Send a second time. That is a CONDITION with a real
            duration — the echo gap — and the gap regularly outlives a pill's 2.5s. A pill would also
            truncate to a line of chrome, which is the one thing this must not do. */}
        <Collapse open={lastSent !== null}>
          <div className="mb-2 flex items-center gap-1.5 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 shrink-0 animate-spin" />
            <span className="truncate">
              <span className="font-medium">{translate("composer.sentPreview.label")}</span> {lastSent}
            </span>
          </div>
        </Collapse>

        {/* File input stays mounted here (not inside the keyboard-only key row) so the picker
            callback survives the keyboard collapsing. Attach fires it from the reply-input row
            below (always visible, not gated behind the keyboard-open quick keys); structural commands
            (New tab/space, Kill) and Stop (Esc, in the Keys dock) live elsewhere. */}
        {/* TWO inputs, because a phone's picker cannot be asked both questions at once. The
            camera roll is offered only when EVERY entry in `accept` maps to a gallery, so the
            extension list that makes a `.md` pickable is the very thing that hid the gallery on
            both Android and iOS — the attach button opened the file browser and nothing else.
            `PHOTO_ACCEPT` is the first input's whole answer; the second keeps the full list. Which
            one fires is the sheet's question, and both land in the same `onPickFile`. */}
        <input ref={photoRef} data-testid="attach-photos" type="file" accept={PHOTO_ACCEPT} multiple hidden onChange={onPickFile} />
        <input ref={fileRef} data-testid="attach-files" type="file" accept={accept} hidden onChange={onPickFile} />

        {/* Keys / Quick / Display dock — a single in-flow site ABOVE the Controls row (so the toggle
            you tapped stays put and the panel grows over the mirror, not the input). Whichever of the
            mutually exclusive drawers is active renders here via the shared ComposerDock chrome. Keys
            mounts the NavTray (unmounts on close, so tab/queue reset each open); Quick mounts the two
            one-tap reply grids; Display mounts the labelled mirror prefs. Agent stays a covering
            BottomSheet below (it's a palette, not a pad). */}
        {drawer === "keys" && (
          <ComposerDock
            title={translate("composer.controls.keys")}
            onEdit={() => setKeysEditorOpen(true)}
            onClose={closeDrawer}
          >
            <NavTray
              // The chords THIS multiplexer refuses (M10/06). A key is not a capability: the Keys
              // door is `sendKeys` (the lock above), and this is the list of holes behind it, so a
              // refused chord greys its own button instead of being discovered by a failed send.
              unsupportedKeys={unsupportedKeys}
              // A dock key moves or ends the pane's line behind Type mode's field (use-direct-typing.ts,
              // the line-end rule). In Type mode it queues behind the field's unsent text on the hook's
              // own sender, so it can never overtake it; outside Type mode it goes out through pressKeys.
              onSend={(keys) => direct.sendPaneKeys(keys)}
              presets={keyPresets}
              board={keyBoard}
              clearBox={{ available: clearOffered, onClear: clearBox }}
              onQueueChange={setQueuedKeys}
              disabled={!way.keysSendable}
            />
          </ComposerDock>
        )}
        <KeyBoardEditor open={keysEditorOpen} onClose={() => setKeysEditorOpen(false)} unsupportedKeys={unsupportedKeys} />
        {drawer === "quick" && (
          <ComposerDock title={translate("composer.controls.quick")} onClose={closeDrawer}>
            <QuickActionsContent
              onSend={(t) => send(t, false)}
              onClose={closeDrawer}
              agent={agent}
              isShell={isShell}
              disabled={locked || offline || sending}
            />
          </ComposerDock>
        )}
        {drawer === "todos" && todoList.length > 0 && (
          <ComposerDock title={todoLabel} onClose={closeDrawer}>
            <ul className="mt-2 divide-y divide-border border-t border-border">
              {todoList.map((item) => {
                const dotStatus =
                  item.status === "completed" ? "done" : item.status === "in_progress" ? "working" : "idle";
                return (
                  <li
                    key={item.id}
                    className={cn(
                      "flex items-start gap-2.5 px-3 py-2 text-sm leading-snug",
                      item.status === "in_progress" && "bg-status-working/8",
                      item.status === "completed" && "text-muted-foreground",
                    )}
                  >
                    <StatusDot
                      status={dotStatus}
                      surface={item.status === "in_progress" ? "bg-status-working/8" : "bg-background"}
                      className="mt-1"
                    />
                    <span className="min-w-0 flex-1 break-words">{item.text}</span>
                  </li>
                );
              })}
            </ul>
          </ComposerDock>
        )}
        {/* The one action row: Keys · Quick · Agent · ⚙ (Agent only when the pane's agent has
            commands). Display prefs used to sit on a second, permanent icon-only "View" row above
            this one; folding them behind the ⚙ gives the mirror that row back. The gear is icon-only
            and NOT flex-1 — it's a settings affordance, not a peer of the three action toggles, and
            keeping it to one square (44px, its tap target and nothing more) leaves the labelled
            buttons the rest of a 390px phone. */}
        {/* THE STATUS BAND IS GONE, AND THIS IS WHERE IT STOOD.

            It was 14px, roomy-only, bounded by a hairline on both edges, and it read as one
            sentence: the machine every button below writes to, then what that machine's pane was
            doing. Altan, on the phone, after the belt landed: "we should address the small status
            line with the server and status, the server is still necessary somewhere, but the status
            is unnecessary at this place."

            SO THE TWO RUNS WENT DIFFERENT WAYS. The machine moved ONE row down, onto the actions
            belt — and then UP, into the pane header, under the cache reading, once the belt's right
            end was needed for the Switch pill (agent-chat.tsx draws it, actions-row.tsx says why).
            It is a `variant="tag"` either way: the 10px uppercase caption was sized for this band
            and reads as a word that fell off something anywhere else.

            THE STATUS WORD WAS DELETED, NOT MOVED, AND THAT NEEDED ONE CHECK FIRST. The word was
            here because a 10px dot encodes this range in HUE ALONE and the range does not survive
            it: on the app's own `--status-*` tokens a deuteranope reads blocked / working / done as
            one colour in light theme, and "needs you" against "done" collapses in both
            (status-badge.tsx holds the measurement). Deleting a coloured word is therefore only
            safe while the state is still readable without colour SOMEWHERE. It is: the pane
            header's agent tile badges a StatusDot that is NAMED — `label={statusLabel(...)}`, the
            one named dot in the app — so a screen reader still gets "needs you" from the header,
            and a shell pane's tile carries an `sr-only` "shell" for the same reason
            (agent-chat.tsx says both at the line). The dashboard states it in words as well. No
            visible word was added anywhere to pay for this one; that was the point of removing it.

            WHAT THE REMOVAL BOUGHT, MEASURED AT 390px: 22px off the stack — the band's own 14px
            (1 + 12 + 1) plus the 8px `mt-2` that separated it from the buttons. The belt's top
            margin absorbed that decision: see `mt-1.5` on the roomy ActionsRow below, which is the
            air between the dock/handle above and the belt now that there is nothing between them.

            The dock still takes NO top padding: its top rule and fill live on the chrome block in
            `agent-chat.tsx`, because the swipe handle stands on that same ground and the boundary
            against the terminal is drawn once, above everything the thumb operates. */}
        {/* ── THE ACTIONS ROW ──────────────────────────────────────────────────────────────────
            One row, two segments: Collie's own controls, then the running harness's own commands in
            the harness's own colour. It replaced the Controls row and the separate harness bar,
            which were two rows of a phone's glass answering one question. The row itself is
            actions-row.tsx; everything below is only what each action DOES.
  */}
        {aboveBelt}
        <ActionsRow
          general={keepBelt([
              // Keys and Quick are TOGGLES for the in-flow dock above (not overlays): tap to
              // open, tap again to close. `expanded` ties each to the dock; the "on" tint marks
              // it pressed while open. Both share the single-valued `drawer`, so opening one
              // closes the other.
              {
                id: "keys",
                icon: Keyboard,
                label: translate("composer.controls.keys"),
                on: drawer === "keys",
                expanded: drawer === "keys",
                disabled: !way.keysOpen,
                onSelect: () => requestDrawer(drawer === "keys" ? null : "keys"),
              },
              // THE SCREEN, ONE TAP AWAY IN EVERY STATE (M56 spec 07): the terminal's own rows with no
              // cards over them. It is not gated on the box, the turn or the link: reading the rows is
              // how a person decides what to do about a dialog Collie could not read. It does not close
              // the Keys dock, so the rows and the pad can be open together.
              ...(screen === undefined || gone
                ? []
                : [
                    {
                      id: "screen",
                      icon: Monitor,
                      label: translate("composer.controls.screenAria"),
                      word: translate("composer.controls.screen"),
                      on: screen.on,
                      pressed: screen.on,
                      onSelect: screen.onToggle,
                    },
                  ]),
              // "Type into terminal" lives HERE, beside Keys, rather than on the Send button.
              // It is the same problem split in half: Keys exists because the phone keyboard
              // cannot send Esc/Tab/arrows/chords, this exists because it cannot send bare
              // printable letters — so someone who wants to press `b` looks in this row first.
              // It is also used in bursts (a picker, a y/n prompt) and then not for days, which
              // is the wrong shape for a permanent fixture on the app's most-used control: a
              // split Send button cost a third of the primary action's width every day to serve
              // a mode used on a few of them.
              // Unlike its neighbours this toggles state instead of opening a dock — the armed
              // strip above the input is what makes that visible. Arming is still an explicit
              // NAMED choice, which is what keeps an accidental touch from quietly wiring the
              // keyboard to a live terminal; see use-direct-typing.ts for the rest.
              {
                id: "type",
                icon: Terminal,
                // Announced in full, drawn short: the pill has one word of room beside its glyph,
                // and "Type into terminal" is the name a reader must still hear.
                label: translate("composer.controls.typeAria"),
                word: translate("composer.controls.type"),
                on: direct.active,
                pressed: direct.active,
                disabled: locked || sending,
                onSelect: () => {
                  if (direct.active) {
                    direct.deactivate();
                    return;
                  }
                  // Close whatever dock is open first: the mode needs the phone keyboard, and a
                  // dock holding half the viewport is the thing in its way. Routed through
                  // requestDrawer so a staged key queue still gets its discard confirm
                  // (ADR 0005).
                  requestDrawer(null);
                  direct.activate();
                },
              },
              {
                id: "quick",
                icon: Zap,
                label: translate("composer.controls.quick"),
                on: drawer === "quick",
                expanded: drawer === "quick",
                disabled: locked,
                onSelect: () => requestDrawer(drawer === "quick" ? null : "quick"),
              },
              // Sent (M61): the shell lines sent through Collie, on a shell pane only. The bridge's own
              // `kind` decides that (`isShell`); no list of harness names lives in the web.
              ...(isShell
                ? [
                    {
                      id: "sent",
                      icon: ListEnd,
                      label: translate("sent.button"),
                      disabled: locked,
                      onSelect: () => setSentOpen(true),
                    },
                  ]
                : []),
              // Withdrawn rather than greyed when this pane has no commands at all: there is no
              // palette to open, which is a different thing from one this device may not use.
              ...(commands.length > 0
                ? [
                    {
                      id: "agent",
                      icon: Slash,
                      label: translate("composer.controls.agent"),
                      disabled: locked,
                      onSelect: () => requestDrawer("cmd"),
                    },
                  ]
                : []),
              ...(todoList.length > 0
                ? [
                    {
                      id: "todos",
                      icon: ListTodo,
                      label: todoLabel,
                      on: drawer === "todos",
                      expanded: drawer === "todos",
                      onSelect: () => requestDrawer(drawer === "todos" ? null : "todos"),
                    },
                  ]
                : []),
              // Display prefs. Not gated on `locked`: wrap/font/raw-terminal are local view
              // state, so a read-only device or a gone pane can still make its mirror readable.
              {
                id: "display",
                icon: Settings2,
                label: translate("composer.controls.displayAria"),
                word: translate("composer.controls.display"),
                on: display.open,
                expanded: display.open,
                // Close whatever dock is open first. The sheet covers the composer, so leaving a
                // Keys tray open under it would only be discovered on dismissal.
                onSelect: () => {
                  requestDrawer(null);
                  display.onToggle();
                },
              },
          ])}
          agent={agent}
          mine={operatorCommands}
          onRun={(command) => send(command, false)}
          disabled={locked}
          // Stop, for a pane the bridge has a key for (M68 spec 02): live while the turn runs, dimmed in
          // place otherwise; a link that is down greys it.
          stop={stopOffered ? { onStop: stopTurn, paneId, running: surface.turn === "running" } : undefined}
          // The pane switcher: a Switch pill pinned at this belt's right end, above Send, and the
          // belt itself as the drag surface behind it. The pane decides whether there is one
          // (agent-chat.tsx); this row draws the pill, wires the drag, and costs no height.
          handle={pullHandle}
          changes={changesPill}
          // The running subagents: a small mark with their count in the pinned block, right of the X
          // and left of Files, only while the count is above zero. A tap opens the Agents sheet.
          agents={
            subagentList.length > 0
              ? {
                  count: subagentList.length,
                  label: agentsLabel,
                  expanded: agentsOpen,
                  onClick: () => setAgentsOpen(true),
                }
              : undefined
          }
          // The output, zoomed: a pill directly left of the Switch mark (actions-row.tsx's `zoom`).
          zoom={zoomPill}
          hand={hand}
          // The X on the pinned block while the box holds a draft, then Undo in its place until
          // the next act (M40 spec 04). See `clearSlot` for when it shows.
          clear={clearSlot()}
        />
        {/* ── THE FOOTER'S NOTICE STRIPS, SORTED BY KIND (DESIGN.md §1, §2) ─────────────────────
            Every strip below arrives and leaves through `Collapse`, which is the only sanctioned way
            an in-flow surface appears at all. Before this they were bare conditionals, so each one
            TELEPORTED the composer up by its own height the moment its condition flipped — reported
            from the outside as "a notification in the footer pushed content up".
            WHAT BELONGS HERE AND WHAT BELONGS IN THE TOP PILLS. An EVENT — a transient confirmation
            with no controls — belongs in the pills (lib/status, `setStatus`), where it costs the
            layout nothing and dismisses itself. A CONDITION belongs here, at the surface it is about,
            for as long as it is true. Sorted that way, every strip in this footer is a condition and
            each one carries its own controls: the password notice (Use Type / ✕), the two armed-mode strips (Stop / ✕), and the draft-too-long line, which
            lasts as long as the text does and would re-fire on every keystroke as a pill. The one
            genuine event in this region — "sent" — is ALREADY a pill (`composer.status.sent`); what
            stays here under that name is the verification half, and the strip itself says why. */}
        {/* The terminal-draft notice is NOT one of these strips any more (ADR 0061). It floats over
            the mirror's bottom edge, out of this flow, so a draft stranding or clearing on the host
            never moves the belt or the field. The offline draft note left this flow for the same
            reason and shares that place, one notice at a time, and so does the held-send card
            (amended 2026-10-18), above the notice. See `floating` above; it renders here. */}
        {draftNoticeSlot ? createPortal(floating, draftNoticeSlot) : floating}
        {/* The Send Protocol's offers (M56 spec 05), at the thumb: Add / Replace / Cancel on a draft,
            Submit / Discard on text that was typed and not sent, and the second tap on a screen
            Collie cannot read. Each is a new request; the ✕ drops the strip and sends nothing. */}
        <Collapse open={protocolOffer !== null}>
          {protocolOffer !== null && (
            <SendOfferStrip
              offers={protocolOffer.offers}
              disabled={sending || locked}
              onOffer={onProtocolOffer}
              // The ✕ drops the strip and hides the notice over it: a notice that still says "tap Type
              // here" with no Type here to tap is a sentence about a button that is gone.
              onDismiss={() => {
                setProtocolOffer(null);
                hideRefusal();
              }}
              capConfirm={protocolOffer.capAck}
            />
          )}
        </Collapse>
        {/* The password-prompt notice (#103). Sits here, in the same in-flow slot as the other
            strips, because that is where the eye already is when a send is refused — and it is a
            NOTICE beside the unchanged two-tap Send ("Type here"), never a replacement for it. */}
        <Collapse open={noEcho !== null && !direct.active}>
          {noEcho !== null && !direct.active && (
            <NoEchoNotice
              prompt={noEcho.prompt}
              typed={noEcho.typed}
              // Withdrawn, not disabled, when the mode can't be armed at all: a gone pane, a
              // read-only device, the idle pause. Offering a control that would refuse is worse
              // than offering none.
              onUseType={
                locked
                  ? null
                  : () => {
                      // The draft is a password we know the pane never accepted, and it is already
                      // in localStorage. Clear it BEFORE arming — both because leaving a secret in a
                      // 48h store is the leak this issue asked about, and because `activate` refuses
                      // while any draft is present, which would make the offered remedy fail on the
                      // spot.
                      clearComposedDraft();
                      requestDrawer(null);
                      setHandoffMask(true);
                      direct.activate();
                    }
              }
              onDismiss={() => noticeNoEcho(null)}
            />
          )}
        </Collapse>
        {/* THE ARMED-MODE SLOT — "Type into terminal" is a mode this composer holds open, said in
            words where the eye already looks. It is a CONDITION with its own control (Stop), so it
            belongs here and not in the top pills, which carry no controls at all. It shared this
            slot with the microphone's strip until the voice takeover replaced that strip; the
            microphone's armed state is the takeover now, drawn over the block and not in this flow. */}
        <Collapse open={direct.active}>
          {/* Armed indicator for direct typing, deliberately NOT only on the button and textarea —
              see the component. */}
          {direct.active && <DirectTypingStrip onStop={() => direct.deactivate()} />}
        </Collapse>
        {/* WHERE A MESSAGE IS GOING AND WHAT BECAME OF THE LAST ONE (M62). The aim stands while a reply is
            in the box; the note stands until it is dismissed. Both are conditions with a control. */}
        <Collapse open={walky.aim !== null}>
          {walky.aim !== null && <WalkyAimStrip aim={walky.aim} onCancel={walky.clearAim} />}
        </Collapse>
        <Collapse open={walky.note !== null}>
          {walky.note !== null && <WalkyNoteStrip note={walky.note} onDismiss={walky.dismissNote} onCancel={walky.cancelFollowed === null ? null : () => void walky.cancelFollowed?.()} />}
        </Collapse>
        {/* MESSAGES HELD FOR THIS PANE (M62 spec 03): a draft in the box holds a message up to an hour, and
            the owner of the box should know. One line, a tap opens the Messages sheet with its Drop. */}
        <Collapse open={walky.held > 0 && onOpenMessages !== undefined}>
          {walky.held > 0 && onOpenMessages !== undefined && <WalkyHeldStrip count={walky.held} onOpen={onOpenMessages} />}
        </Collapse>
        {/* A draft too large for the disk tier (lib/drafts.ts). It survives a pane switch — the
            memory tier holds it whole — but not the app closing, and that difference is invisible
            without saying so: the old behaviour silently restored an OLDER, SHORTER draft instead.
            Derived at render rather than pushed through setStatus, because this is a CONDITION that
            lasts as long as the text does, and a status auto-clears in 2.5s and would re-fire on
            every keystroke. Self-clearing: trim the draft or send it and the row is simply gone. */}
        <Collapse open={!direct.active && !fitsDraftStore(input, attachments)}>
          <p className="px-1 pb-1 text-xs leading-snug text-muted-foreground">
            {translate("composer.draft.tooLong")}
          </p>
        </Collapse>
        {/* WHAT BECAME OF THE SEND, AT THE THUMB (DESIGN.md §11, a contextual notice; M56 specs 06 and
            07). The bridge's verdict and what it saw on the screen, with the bridge's own words under
            it when it gave any. It is the ONLY place the outcome of a send is told: the header holds
            "Sent" and nothing a person must act on, because a phone has scrolled the header off or put
            it under the keyboard by the time Send is tapped (the m51-10 field case). The way on is a
            button beside the words, each only where it can do something: to the card when an ask or an
            overlay Collie cannot read is on the screen, to the raw rows when the next move is reading
            them, and to the Keys dock in every outcome, so no refusal leaves a session that only the
            desk can free. */}
        <Collapse open={refusalShown}>
          {sendRefusal !== null && (
            <SendRefusalNotice
              refusal={sendRefusal}
              onDismiss={hideRefusal}
              action={
                refusalCard || refusalScreen || refusalKeys ? (
                  <span className="flex flex-wrap justify-end gap-1">
                    {refusalCard && (
                      <Button variant="ghost" size="sm" className={NOTICE_ACTION} onClick={() => onAnswerDialog?.()}>
                        {translate("composer.send.dialogFirst")}
                      </Button>
                    )}
                    {refusalScreen && (
                      <Button variant="ghost" size="sm" className={NOTICE_ACTION} onClick={() => screen?.onToggle()}>
                        {translate("composer.controls.screen")}
                      </Button>
                    )}
                    {refusalKeys && (
                      <Button variant="ghost" size="sm" className={NOTICE_ACTION} onClick={() => requestDrawer("keys")}>
                        {translate("composer.protocol.openKeys")}
                      </Button>
                    )}
                  </span>
                ) : undefined
              }
            />
          )}
        </Collapse>
        {/* Why a destructive line waits for a second tap: said here, beside the "Really send?" word, and
            only while that word is armed. It was a header line, and the header holds nothing a person must
            act on (M56 spec 07). */}
        <Collapse open={confirmingSend && destructiveNote !== null && !direct.active}>
          {destructiveNote !== null && (
            <Notice tone="danger" variant="box" className="mb-2" icon={<TriangleAlert />}>
              <span data-slot="composer-destructive">{destructiveNote}</span>
            </Notice>
          )}
        </Collapse>
        {/* A draft that holds the bridge's mask. The operator copied a masked line off the mirror and
            pasted it here, and the pane would receive the dots, not the secret. A CONDITION for as
            long as the text stays, like the line above, so it is derived at render and clears when
            the dots are deleted or the draft is sent. A caution and never a block: a `••••` can be
            meant (a password placeholder in a README), and lib/draft-match.ts accepts it as a mask
            slot on purpose when it reads the pane back. */}
        <Collapse
          open={
            !direct.active &&
            (holdsMask(input) || attachments.some((a) => a.kind === "paste" && holdsMask(a.path)))
          }
        >
          <p className="px-1 pb-1 text-xs leading-snug text-muted-foreground">
            {translate("composer.draft.holdsMask")}
          </p>
        </Collapse>
        {/* ── ONE BOX, ONE ROW: THE FIELD, ATTACH, THE PRIMARY ACTION ──────────────────────
            The field, the attach control and Send used to be three shapes on one line: a
            bordered field with a button tucked into its bottom-right corner, and a round primary
            action floating beside it. They are one bordered container now, ported by hand from the
            prompt-input pattern (ADR 0057). For one round the box also carried a toolbar row under
            the field; on a phone that was a second row of height on an EMPTY composer, so the two
            buttons came back inline (ADR 0057, amended 2026-09-22).

            ATTACH STANDS AT THE RIGHT, NEXT TO THE PRIMARY ACTION, AS IT DID BEFORE THIS FILE
            MADE IT ONE BOX. It sat at the box's left edge for one round; Altan asked for it back
            beside Send, so the row reads field, attach, primary action (ADR 0057, amended again
            2026-09-22).

            THE ROW. `flex items-end gap-1 p-1`: the field (`flex-1 min-w-0`), attach, the primary
            action. `items-end` pins both buttons to the bottom edge while a long draft grows the
            field upward to its cap, which is where a thumb already is. `p-1` is 4px, exactly the
            reach of `TOOLBAR_TAP_TARGET`, so an empty box is 36 + 8 = 44px inside its border.

            THE FRAME IS HERE AND NOWHERE ELSE, AND THERE IS ONE. The border is unconditional and
            only its colour moves on focus, so the box never resizes under the caret (DESIGN.md §2),
            and `focus-within:ring-1` doubles it to a 2px line as a box-shadow, which costs no
            layout. It WAS an outline two pixels outside the border as well, and a ring-coloured
            border plus an offset outline drew two frames around one field. Do not bring an
            `outline-offset-*` back: one frame is the focus mark, and it is still a visible one.

            No wrapper padding above the box any more. It was `pt-1`, there only to keep the old
            outline's 4px reach off the belt; the ring reaches 1px, and the belt's own `mb-1`
            clears that.

            `relative` is the anchor `AnchoredMenu` positions against, so the attach picker opens
            above the whole box, right-aligned against it — which now sits close to the attach
            button itself, one button-width and a gap in from the box's own right edge
            (ui/anchored-menu.tsx carries that measurement). The menu is still a child of the box
            rather than of the button: it is absolutely positioned, so it takes no place in the row,
            and anchoring it to the box is what keeps it lined up above the box's own right edge
            regardless of which control stands nearest that edge.

            THE BELT IS NOT PART OF THIS BOX. Keys / Type / Quick / Agent / Display stay above it
            (actions-row.tsx). They open docks that fill half the viewport; the box holds the two
            controls that act on the draft in front of you, and nothing else moves in.

            The machine this write lands on is NOT in here, and must not move in. It was, for one
            round, docked at the field's right edge, and it cost 60px of typing width on a crew,
            out of the widest part of the composer. It answers the same question from the belt
            above, which is equally at the write surface and costs the draft nothing. */}
        {/* THE SUGGESTION STRIP, directly above the box: one row, one look, one source per pane.
            A shell pane offers lines sent before (M61), only while the box has focus and the Settings
            switch is on; not with "Type into terminal" armed (the box is not where the words go), a
            dialog card up, a locked composer or a chip in the box. An agent pane offers its own
            commands for a typed `/` or `$` token (#475), whatever that switch says; a tap fills and
            never sends. */}
        {isShell ? (
          suggestionsOn && (
            <SuggestionStrip
              open={boxFocused && !direct.active && !dialogCard && !locked && attachments.length === 0}
              typed={input}
              source={{ kind: "sent", lines: suggestions.lines, onPick: pickSent, onAll: () => setSentOpen(true) }}
            />
          )
        ) : (
          <SuggestionStrip
            open={commandSuggestions.length > 0}
            typed={input}
            source={{ kind: "commands", commands: commandSuggestions, onPick: selectSuggestion }}
          />
        )}
        <div
          data-slot="composer-box"
          className={cn(
            "relative flex items-end gap-1 rounded-xl border border-input bg-background p-1 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring",
            // `hand="left"`: the whole row runs mirrored, so Send stands on the box's left edge, then
            // Attach, then the field. The DOM order is untouched, so the tab and reading order are
            // too. With chips, `flex-wrap` still stacks the chip strip ABOVE the row.
            hand === "left" && "flex-row-reverse",
            // Chips take a line of their own ABOVE the row (ADR 0060). `flex-wrap` plus a
            // full-basis strip does that without re-parenting the field, so the textarea is never
            // remounted (and never loses its caret) when the first chip arrives. With no chips the
            // class is absent and the box is exactly the one row it was.
            attachments.length > 0 && "flex-wrap",
            // A composer nobody may write to says so as a surface, not just as a placeholder:
            // the fill recedes and both buttons in the box are disabled anyway.
            locked && "bg-muted/40",
            // Armed "Type into terminal". The tint was on the field while the field wore the
            // frame; it follows the frame.
            direct.active && "border-primary focus-within:border-primary focus-within:ring-primary",
          )}
        >
          {attachments.length > 0 && (
            // The strip scrolls sideways when the chips outrun the box; `pt-1 px-1` is room for
            // the corner badge and the x, which stand 4px outside each chip.
            <ul
              aria-label={translate("composer.attach.listAria")}
              className="flex w-full basis-full gap-2 overflow-x-auto px-1 pt-1 pb-0.5"
            >
              {attachments.map((attachment) => (
                <AttachmentChip
                  key={attachment.n}
                  attachment={attachment}
                  onRemove={() => removeAttachment(attachment)}
                  onSelect={
                    attachment.kind === "paste"
                      ? () => setEditingPaste({ paneId, scopeId, n: attachment.n })
                      : undefined
                  }
                  disabled={sending}
                  inFront={markerMissing(input, attachment)}
                />
              ))}
            </ul>
          )}
          <ChatInput
            ref={inputRef}
            value={direct.active ? direct.value : input}
            onChange={
              direct.active
                ? direct.onChange
                : (e) => {
                    rememberCaret(e);
                    updateInput(e.target.value);
                    noteOfflineKeystroke(e.target.value);
                  }
            }
            onSelect={direct.active ? undefined : rememberCaret}
            onFocus={() => setBoxFocused(true)}
            onBlur={(e) => {
              setBoxFocused(false);
              if (!direct.active) rememberCaret(e);
            }}
            onCompositionStart={direct.active ? direct.onCompositionStart : undefined}
            onCompositionEnd={direct.active ? direct.onCompositionEnd : undefined}
            onKeyDown={
              direct.active
                ? direct.onKeyDown
                : (e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      onSendClick();
                    }
                  }
            }
            onPaste={onPasteFile}
            placeholder={placeholderWords}
            // A shell line is a command, not prose, so a shell pane (and direct typing, which sends
            // keys to any pane) turns the keyboard's correction and spell check off. Android keyboards
            // (Gboard, SwiftKey, Samsung) otherwise capitalize the first letter despite the field's
            // `autoCapitalize="none"` (issue 465). An agent pane keeps the keyboard's defaults.
            autoCorrect={direct.active || isShell ? "off" : undefined}
            spellCheck={direct.active || isShell ? false : undefined}
            className={cn(
              // `flex-1 min-w-0`: the field takes whatever width the two buttons beside it leave,
              // and `min-w-0` is what lets it go NARROWER than its content asks. A flex item's
              // automatic minimum width is its min-content width, and `field-sizing-content` turns
              // that into a laid-out one, so without it a long host path (typed or pasted; an upload
              // puts only its short marker here since ADR 0060) would widen the field and push the
              // primary action off the right edge (`wrap-anywhere` in chat-input.tsx
              // stops the same thing at the source; the two are independent and both stay).
              //
              // `py-1.5 min-h-9 pl-2` centre ONE line of the draft against the 36px buttons on the
              // same row, and claim no more: an empty composer is one button row tall. `min-h-9` is
              // that one row, not a second one (the field is `box-border`, so the padding is inside
              // it), and it keeps a smaller draft size from leaving the text a few pixels low.
              //
              // `pl-2`, AND ONLY ON THE LEFT. The field is the box's first child now, sitting
              // directly against the box's own `p-1`, so without an inset of its own the text would
              // start 4px from the border — the box's padding alone, with nothing of the field's to
              // add to it. Attach used to stand there and supplied that room as its own width; now
              // that it has moved beside Send, the field pays for the left margin itself instead.
              //
              // NO `pr-*`, AND NOTHING MAY ADD ONE. It was `pr-11`, the 44px strip the attach button
              // needed while it was tucked into the field's corner. The buttons are siblings of the
              // field now, so nothing inside the field needs a strip kept clear for either of them —
              // the field's right side takes no padding of its own, and the box's `gap-1` to attach
              // is what keeps the text off it.
              "min-w-0 flex-1 min-h-9 pl-2 py-1.5",
              // The Steer hint is longer than the reply words, so it is drawn smaller. The FIELD'S HEIGHT
              // does not change with it: `text-base` gives the field a unitless line-height, so the
              // placeholder's line box can only shrink (12px x 1.33 against 14-16px x 1.5), and the empty
              // field is already held at `min-h-9` above (at most 16px x 1.5 + 12px of padding = 36px).
              (staleWords || steerWords) && "placeholder:text-xs",
              // Mirrored, the field's right side stands against the box's border, so it takes the
              // inset the left used to take from Attach.
              hand === "left" && "pr-2",
              // Dots only for the handoff from a password prompt. Type mode keeps the line in the
              // field until Enter (issue 534), so there the field would hold the secret in clear.
              // A Type mode the operator armed by hand shows clear text, as every release before
              // did, so a command can be read back while it is typed.
              direct.active && handoffMask && "[-webkit-text-security:disc]",
              // The draft is terminal-bound text, so the field wears the TERMINAL face — the same
              // family the mirror above it renders in, not the app's chrome face. `font-mono` is
              // the mirror's own default; the style below follows the operator's mirror-family
              // choice (Settings → Terminal font), exactly as the mirror itself does.
              //
              // THE SIZE IS ITS OWN SETTING (Settings → Terminal font → Draft text), and it is not
              // the mirror's number: the mirror is output you scan, the draft is a sentence you are
              // writing. It used to be pinned to the primitive's 16px — not as a choice, but because
              // a sub-16px focused input makes iOS Safari zoom the whole page and never zoom back.
              // That fact is now handled where it belongs, as a floor inside `applyDraftFontSize`,
              // so every other browser gets the smaller default the operator asked for.
              "font-mono",
            )}
            // Built above, where the two halves and their reasons sit together.
            style={draftStyle}
            disabled={locked}
            rows={1}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              TOOLBAR_TAP_TARGET,
              "size-9 rounded-full text-muted-foreground",
              // The press echo, in the tone this app already uses for "your press landed" —
              // `variant="default"`, which is what a tapped quick reply and a busy dialog option
              // both flip to. It was `bg-accent` first, and that was a token chosen by name
              // rather than by looking: in the dark theme `accent` resolves to oklch(0.269),
              // which is the SAME value as `muted` and sits 0.06 of lightness above the card it
              // is drawn on. Measured through a real tap, it faded in over 180ms, held for 40,
              // and faded out — a flash nobody could see on a phone. `primary` is oklch(0.922).
              //
              // `duration-0` on the way IN, and the base duration on the way out. A press has to
              // answer immediately or it is not answering the press; the release is the part that
              // wants easing. Removing both classes in one commit is what lets the exit animate.
              // Lit for the press, and then for as long as the menu it opened is standing: the
              // menu is anchored above rather than over the button precisely so this can be seen,
              // and a trigger that went dark under its own open menu would waste that.
              (pressed || picking) && "scale-95 bg-primary text-primary-foreground duration-0",
            )}
            disabled={uploading || locked || direct.active}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              echoAttachPress();
              if (asksWhich) setPicking(true);
              else photoRef.current?.click();
            }}
            aria-label={translate("composer.attach.aria")}
            aria-haspopup="dialog"
            aria-expanded={asksWhich ? picking : undefined}
          >
            {uploading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Paperclip className="size-4" />
            )}
          </Button>
          {/* The picker, anchored to the BOX so it opens above the whole shape rather than over
              the button that opened it (ui/anchored-menu.tsx carries the measurement, and the
              box's own `relative` is the anchor). It is not anchored to the attach button itself
              even now that attach stands near the box's own right edge: the panel is `right-0
              min-w-44` against its anchor, and the gap between attach and that edge is NOT fixed —
              the primary action beside it is a size-9 icon square most of the time but widens into
              a text button ("Answer the dialog" / "Really send?") when its slot holds a word, which
              would slide the menu sideways if it followed the button instead of the box. Anchoring
              to the box keeps the picker's own right edge pinned to the box's right edge no matter
              which shape the primary action is wearing.
              Two rows, no confirm, each one opens a native picker, which is its own decision
              point. The menu closes BEFORE the click so it is not left standing behind the
              system UI, and the click still counts as the user gesture the browser requires
              because both happen in this one handler. */}
          <AnchoredMenu
            open={picking}
            onClose={() => setPicking(false)}
            label={translate("composer.attach.title")}
            // Attach stands near the box's LEFT edge under `hand="left"`; the panel follows it.
            className={hand === "left" ? "right-auto left-0" : undefined}
          >
            <ActionRow
              icon={<Image aria-hidden="true" className="size-4 shrink-0" />}
              label={translate("composer.attach.photos")}
              onClick={() => {
                setPicking(false);
                photoRef.current?.click();
              }}
            />
            <ActionRow
              icon={<FileText aria-hidden="true" className="size-4 shrink-0" />}
              label={translate("composer.attach.files")}
              onClick={() => {
                setPicking(false);
                fileRef.current?.click();
              }}
            />
          </AnchoredMenu>
          {/* The Send button's long-press menu, anchored the same way as the attach picker (see above).
              One row, a named choice: the text goes to this pane as a walky talky message from the
              operator through the bridge's own route, which logs it, types it when the screen allows
              and answers a receipt. The menu closes before the send, so the outcome strip is what shows. */}
          <AnchoredMenu
            open={sendMenu}
            onClose={() => setSendMenu(false)}
            label={translate("walky.composer.menu")}
            className={hand === "left" ? "right-auto left-0" : undefined}
          >
            {steerRow && (
              <ActionRow
                icon={<Navigation aria-hidden="true" className="size-4 shrink-0" />}
                label={translate("composer.steer.row")}
                onClick={() => {
                  setSendMenu(false);
                  onSendClick("steer");
                }}
              />
            )}
            <ActionRow
              icon={<WalkyIcon aria-hidden="true" className="size-4 shrink-0" />}
              label={translate("walky.composer.sendAsMessage")}
              onClick={() => {
                setSendMenu(false);
                void walky.sendMessage(composeLine(input, attachments));
              }}
            />
          </AnchoredMenu>
          {askOwnsKeys && hasDraft ? (
            // A modal ask owns the agent's keyboard, so the refusal is shown HERE, in the Send slot,
            // and never in the header: on a phone that line is scrolled off or under
            // the keyboard when Send is tapped (field case 2026-10-15, ADR 0009). The word replaces
            // Send only once there is a draft to refuse; an empty box keeps its microphone. The tap is a way TO the card (scroll, focus its first
            // button), never a send. Same shape as the two confirm words below but a muted variant,
            // because this is a state to read, not a deliberate override to arm.
            <Button
              variant="secondary"
              className={cn(TOOLBAR_TAP_TARGET, "h-9 shrink-0 rounded-md px-3 text-sm font-semibold")}
              onClick={() => onAnswerDialog?.()}
              aria-label={translate("composer.send.dialogFirst")}
            >
              {translate("composer.send.dialogFirst")}
            </Button>
          ) : !direct.active && confirmingSend ? (
            <Button
              variant="destructive"
              className={cn(TOOLBAR_TAP_TARGET, "h-9 shrink-0 rounded-md px-3 text-sm font-semibold")}
              onClick={() => onSendClick(armedWhen.current)}
              disabled={locked || offline || !hasDraft || sending}
              title={offline ? translate("composer.send.reconnect") : undefined}
              aria-label={offline ? translate("composer.send.reconnect") : translate("composer.send.reallySend")}
            >
              {translate("composer.send.reallySend")}
            </Button>
          ) : micIsPrimary ? (
            // THE MICROPHONE IS THE PRIMARY ACTION WHILE THE BOX IS EMPTY, and becomes Send the
            // moment there is anything to send. It used to be a second, permanent control tucked
            // inside the field beside the attach button — deliberately, to avoid a split primary
            // action. The v1 beta said that reads the workflow wrong: you either dictate a message
            // or you type one, and nobody dictates into the middle of a draft. So the field paid
            // 36px of its width, on every render, for a control that is only ever wanted on an empty
            // box. An empty box has no Send either (`send` refuses a blank value), so this branch
            // takes over a button that could do nothing anyway — it replaces no capability.
            <Button
              data-slot="composer-primary"
              size="icon"
              variant={recorder.busy ? "destructive" : "default"}
              className={cn(TOOLBAR_TAP_TARGET, "size-9 shrink-0 rounded-full")}
              disabled={!micAvailable || locked || offline || sending || recorder.phase === "transcribing"}
              aria-pressed={recorder.busy}
              // The bridge's own words when it cannot serve — the operator's next move is on the
              // host, so the button says what is wrong rather than just refusing.
              aria-label={
                !micAvailable
                  ? (stt?.reason ?? translate("composer.mic.unavailable"))
                  : recorder.phase === "recording"
                    ? translate("composer.mic.stopAria")
                    : translate("composer.mic.recordAria")
              }
              title={micAvailable ? undefined : stt?.reason}
              onPointerDown={(e) => e.preventDefault()}
              onClick={(e) => {
                // `detail` is 0 for a click the keyboard made: the takeover then shows its focus mark.
                openedByKeyboard.current = e.detail === 0;
                if (recorder.phase === "recording") recorder.stopAndSend();
                else recorder.start();
              }}
            >
              {recorder.phase === "transcribing" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : recorder.phase === "recording" ? (
                <Square className="size-4 fill-current" />
              ) : (
                <Mic className="size-4" />
              )}
            </Button>
          ) : (
            <Button
              data-slot="composer-primary"
              size="icon"
              {...sendHold}
              className={cn(TOOLBAR_TAP_TARGET, "size-9 shrink-0 select-none rounded-full [-webkit-touch-callout:none]")}
              onClick={direct.active ? () => direct.deactivate() : () => onSendClick()}
              disabled={locked || sending || (offline && !direct.active)}
              title={offline && !direct.active ? translate("composer.send.reconnect") : undefined}
              aria-label={
                direct.active
                  ? translate("composer.send.stopTypingAria")
                  : offline
                    ? translate("composer.send.reconnect")
                    : translate("composer.send.sendAria")
              }
              aria-pressed={direct.active}
            >
              {direct.active ? (
                <Keyboard className="size-4" />
              ) : sending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : justSent ? (
                <Check className="size-4" />
              ) : (
                <Send className="size-4" />
              )}
            </Button>
          )}
        </div>
      </div>

      {/* THE VOICE TAKEOVER (design 3.3): over the whole chrome block, in its own box, from the mic's
          tap until the transcript lands or the clip is thrown away. A sibling of the composer above,
          positioned against the `relative` chrome block that holds both (agent-chat.tsx).
          See components/voice-takeover.tsx. */}
      {recorder.phase !== "idle" && (
        <VoiceTakeover
          phase={recorder.phase}
          elapsed={recorder.elapsedLabel}
          source={recorder.meter}
          hand={hand}
          padClassName={blockPad}
          keyboardOpened={openedByKeyboard.current}
          sends={handsFree && !hasDraft && noEcho === null}
          engine={recorder.engine}
          failure={recorder.failure}
          onSendToHost={recorder.canSendToHost ? recorder.sendToHost : null}
          onStop={recorder.stopAndSend}
          onDiscard={recorder.discard}
        />
      )}

      {/* The running subagents, over the page: the agents mark opens it, and nothing in flow moves. */}
      <AgentsSheet
        open={agentsOpen && subagentList.length > 0}
        onClose={closeAgents}
        title={agentsLabel}
        subagents={subagentList}
        onOpen={openSubagent}
      />

      {isShell && <SentSheet open={sentOpen} onClose={() => setSentOpen(false)} cwd={cwd} scope={scope} onPick={pickSent} />}

      {/* Slash-command palette */}
      <CommandPalette
        open={drawer === "cmd"}
        onClose={closeDrawer}
        agent={agent}
        paneId={paneId}
        scope={scope}
        mine={operatorCommands}
        found={claudeCommands}
        onInsert={insertCommand}
        onSubmit={(t) => send(t, false)}
      />
      {activePaste !== undefined && (
        <BottomSheet
          open
          onClose={() => setEditingPaste(null)}
          title={translate("composer.paste.sheetTitle", { n: activePaste.n })}
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {translatePlural("composer.paste.chipStats", pasteLineCount(activePaste.path), {
                  chars: activePaste.path.length,
                })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => expandPasteAttachment(activePaste.n)}
              >
                {translate("composer.paste.expandToInput")}
              </Button>
            </div>
            <textarea
              aria-label={translate("composer.paste.editAria", { n: activePaste.n })}
              value={activePaste.path}
              onChange={(e) => updatePasteAttachment(activePaste.n, e.target.value)}
              rows={10}
              className="max-h-[45dvh] w-full resize-y rounded-md border border-input bg-background p-2.5 font-mono text-base leading-relaxed text-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            />
          </div>
        </BottomSheet>
      )}
    </>
  );
});
