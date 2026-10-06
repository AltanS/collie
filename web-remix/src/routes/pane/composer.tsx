// The composer (ADR 0057): ONE bordered box holding the draft on top and a toolbar row along the
// bottom, the focus mark on the box. Port of the write half of web/src/components/composer.tsx and
// the first row of its Keys tray (web/src/components/nav-tray.tsx).
//
// Behaviour kept from the React composer, in the order a send meets it:
//   - Enter and Shift+Enter put a newline in the draft; Ctrl+Enter or Cmd+Enter sends, as does the
//     Send button (composer/keys.ts). The draft is saved per pane as it is typed (web's drafts.ts).
//   - A dialog with the keyboard refuses the send ("answer it first"). An unread dialog arms the
//     deliberate override instead: the second tap types anyway (ADR 0053).
//   - A destructive line ("rm -rf", a force push) needs a second tap within 3 s.
//   - The reply goes through web's `sendGuardedReply`: type, verify the words reached the box, then
//     submit. A `blocked` pre-flight keeps the draft and arms "Type anyway?".
//   - The whole box is disabled, with the reason as its placeholder, while the pane takes no write
//     (gone, unpaired, read-only device, or a multiplexer without typeText/sendKeys).
import { on, ref, type Handle } from "remix/component";
import { Keyboard, LoaderCircle, SendHorizontal } from "lucide";

import { isDestructiveInput } from "@web/lib/destructive";
import { clearDraft, fitsDraftStore, loadDraft, saveDraft } from "@web/lib/drafts";
import { t } from "@web/lib/i18n";
import type { Scope } from "@web/lib/scope";
import { cn } from "@web/lib/utils";

import { composerKeyIntent, keysFor, SPECIAL_KEYS, specialKeyAllowed, specialKeyLabel } from "../../composer/keys";
import { Icon } from "../../ui/icon";
import { pressKeys, sendTypedReply, type WriteTarget } from "./answer";
import type { WriteGate } from "./data";
import { setPaneStatus } from "./status";

/** How long an armed second tap waits (web's `usePendingConfirm`). */
const CONFIRM_MS = 3000;

export interface ComposerProps {
  paneId: string;
  scope: Scope;
  gate: WriteGate;
  /** A lifted dialog has the keyboard (web's `dialogPresent`). */
  dialogOwns: boolean;
  /** …and it is the unread card, whose refusal arms the override (ADR 0053). */
  dialogUnread: boolean;
  /** The unread card's key, as its chip reads, for the override's sentence. */
  unreadKey: string;
  /** The multiplexer's refused keys (`/api/config` → `mux.unsupportedKeys`). */
  unsupportedKeys: readonly string[];
  /** Built at call time, so a send uses the screen as it is now. */
  target: () => WriteTarget;
}

type Armed = "none" | "force" | "destructive";

export function Composer(handle: Handle<ComposerProps>) {
  const { paneId, scope } = handle.props;
  let text = loadDraft(scope, paneId) ?? "";
  let sending = false;
  let keysOpen = false;
  let armed: Armed = "none";
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let field: HTMLTextAreaElement | undefined;
  handle.signal.addEventListener("abort", () => clearTimeout(armTimer));

  const arm = (next: Armed, ttl: number | null): void => {
    clearTimeout(armTimer);
    armed = next;
    if (ttl !== null) {
      armTimer = setTimeout(() => {
        armed = "none";
        void handle.update();
      }, ttl);
    }
    void handle.update();
  };

  const keep = (next: string): void => {
    text = next;
    if (!fitsDraftStore(next)) setPaneStatus(t("composer.draft.tooLong"), "info");
    saveDraft(scope, paneId, next);
  };

  const send = async (): Promise<void> => {
    const { gate, dialogOwns, dialogUnread, unreadKey } = handle.props;
    if (text.trim() === "" || gate.locked || sending) return;
    const force = armed === "force";
    if (dialogOwns && !force) {
      if (dialogUnread) {
        setPaneStatus(t("composer.status.unreadDialog", { key: unreadKey }), "warn");
        arm("force", CONFIRM_MS);
      } else {
        setPaneStatus(t("composer.status.dialogWaiting"), "warn");
      }
      return;
    }
    const reason = isDestructiveInput(text);
    if (reason !== null && armed !== "destructive" && !force) {
      setPaneStatus(t("composer.destructive.confirm", { reason }), "warn");
      arm("destructive", CONFIRM_MS);
      return;
    }
    arm("none", null);
    sending = true;
    void handle.update();
    const sent = text;
    try {
      const outcome = await sendTypedReply(handle.props.target(), sent, force);
      if (outcome.status === "sent") {
        if (text === sent) {
          text = "";
          if (field) field.value = "";
        }
        clearDraft(scope, paneId);
        setPaneStatus(t("composer.status.sent"), "success");
      } else if (outcome.status === "blocked") {
        setPaneStatus(t("composer.status.tapAgainToType", { error: outcome.error }), "warn");
        arm("force", CONFIRM_MS);
      } else {
        setPaneStatus(outcome.error, "error");
      }
    } finally {
      sending = false;
      void handle.update();
    }
  };

  return () => {
    const { gate, unsupportedKeys } = handle.props;
    const locked = gate.locked;
    const sendLabel =
      armed === "force" ? t("composer.send.typeAnyway") : armed === "destructive" ? t("composer.send.reallySend") : null;
    return (
      <div data-slot="composer" class="shrink-0 border-t border-rule bg-background px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {keysOpen && (
          <div data-testid="keys-row" role="group" aria-label={t("composer.controls.keys")} class="mb-2 flex flex-wrap gap-1.5">
            {SPECIAL_KEYS.map((key) => (
              <button
                key={key.id}
                type="button"
                data-testid={`key-${key.id}`}
                aria-label={key.aria}
                disabled={locked || !specialKeyAllowed(key, unsupportedKeys)}
                class="flex h-9 min-w-11 items-center justify-center rounded-md border border-border bg-secondary px-2 font-mono text-xs text-foreground active:bg-primary/10 disabled:opacity-50"
                mix={on("click", () => void pressKeys(handle.props.target(), keysFor(key)))}
              >
                {specialKeyLabel(key)}
              </button>
            ))}
          </div>
        )}
        <div class="rounded-xl border border-input bg-background focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
          <textarea
            data-slot="chat-input"
            aria-label={gate.placeholder}
            placeholder={gate.placeholder}
            disabled={locked}
            value={text}
            rows={1}
            autoCapitalize="none"
            enterkeyhint="enter"
            class="block max-h-[min(10rem,30dvh)] min-h-11 w-full resize-none bg-transparent px-3 py-2.5 text-sm [field-sizing:content] wrap-anywhere outline-none placeholder:truncate placeholder:text-muted-foreground disabled:opacity-60"
            mix={[
              ref((node: HTMLTextAreaElement) => {
                field = node;
              }),
              on("input", (event) => {
                keep(event.currentTarget.value);
                if (armed !== "none") arm("none", null);
                else void handle.update();
              }),
              on("keydown", (event) => {
                if (composerKeyIntent(event) !== "send") return;
                event.preventDefault();
                void send();
              }),
            ]}
          />
          <div class="flex items-center justify-between gap-2 px-1.5 pb-1.5">
            <button
              type="button"
              aria-pressed={keysOpen}
              data-testid="keys-toggle"
              class={cn(
                "flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground active:bg-muted",
                keysOpen && "bg-muted text-foreground",
              )}
              mix={on("click", () => {
                keysOpen = !keysOpen;
                void handle.update();
              })}
            >
              <Icon icon={Keyboard} class="size-4" />
              {t("composer.controls.keys")}
            </button>
            <button
              type="button"
              data-testid="composer-send"
              aria-label={sendLabel ?? t("composer.send.sendAria")}
              disabled={locked || sending || text.trim() === ""}
              class={cn(
                "flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-lg px-2.5 text-sm font-medium disabled:opacity-50",
                sendLabel === null ? "bg-primary text-primary-foreground" : "bg-status-working text-background",
              )}
              mix={on("click", () => {
                void send();
                field?.focus({ preventScroll: true });
              })}
            >
              {sending ? (
                <Icon icon={LoaderCircle} class="size-4 animate-spin" />
              ) : sendLabel !== null ? (
                sendLabel
              ) : (
                <Icon icon={SendHorizontal} class="size-4" />
              )}
            </button>
          </div>
        </div>
      </div>
    );
  };
}
