// The card dock (ADR 0059): the one lifted dialog card, below the body and above the composer, the
// same bottom edge for every card kind. Ports of web/src/components/card-dock.tsx and the block
// components it draws. Presentational: a card never touches the network, it calls the handler it was
// given (routes/pane/answer.ts) and shows a spinner on the pressed control until that settles.
import { on, type Handle, type RemixNode } from "remix/component";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, LoaderCircle, MessageSquarePlus } from "lucide";

import type { PromptOption } from "@web/lib/blocks";
import { MENU_DOWN_KEYS, MENU_LEFT_KEYS, MENU_RIGHT_KEYS, MENU_UP_KEYS } from "@web/lib/harness/menu-hints";
import { t } from "@web/lib/i18n";
import { FEEDBACK_MAX_LENGTH } from "@web/lib/prompt-action";
import { cn } from "@web/lib/utils";

import { toRows } from "../../screen/rows";
import { Screen } from "../../screen/screen";
import { Icon } from "../../ui/icon";
import { OptionButton, OptionCaption, PromptPanel } from "../../ui/prompt-panel";
import type { DialogCard, KeysOnlyCard, MenuCard, PromptCard, UnreadCard } from "./cards";

/** The handlers a card calls. Each resolves true when its keys went out. */
export interface CardActions {
  option: (option: PromptOption) => Promise<boolean>;
  feedback: (text: string) => Promise<boolean>;
  menu: (keys: string[], nav: boolean) => Promise<boolean>;
  unread: () => Promise<boolean>;
}

function spinner(size = "size-3.5"): RemixNode {
  return <Icon icon={LoaderCircle} class={cn(size, "shrink-0 animate-spin text-muted-foreground")} label={t("dialog.sendingAria")} />;
}

// ── prompt-select ────────────────────────────────────────────────────────────────────────────────

function PromptSelectCard(handle: Handle<{ card: PromptCard; disabled: boolean; actions: CardActions }>) {
  let sending: string | null = null;
  let editorOpen = false;
  let draft = "";

  const press = async (id: string, run: () => Promise<boolean>): Promise<boolean> => {
    if (handle.props.disabled || sending !== null) return false;
    sending = id;
    void handle.update();
    try {
      return await run();
    } finally {
      sending = null;
      void handle.update();
    }
  };

  return () => {
    const { card, disabled, actions } = handle.props;
    const feedback = card.block.prompt.feedback;
    const focused = feedback?.focused ?? false;
    const locked = disabled || sending !== null || focused;
    const planChange = feedback !== undefined && feedback.purpose !== "free-text";
    let feedbackNode: RemixNode = null;
    if (feedback !== undefined && sending === "feedback") {
      feedbackNode = (
        <div class="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {spinner()}
          {t("prompt.feedback.planChange.sending")}
        </div>
      );
    } else if (feedback !== undefined && focused) {
      feedbackNode = (
        <div class="rounded-lg border border-dashed border-status-working/50 px-3 py-2 text-xs text-status-working">
          {planChange ? t("prompt.feedback.planChange.focused") : t("prompt.feedback.freeText.focused")}
          {feedback.text ? <span class="font-content text-muted-foreground"> ({feedback.text})</span> : null}
        </div>
      );
    } else if (feedback !== undefined && feedback.text !== "") {
      feedbackNode = (
        <div class="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-foreground/90">
          <Icon icon={MessageSquarePlus} class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1">
            {planChange ? t("prompt.feedback.planChange.typedPrefix") : t("prompt.feedback.freeText.typedPrefix")}
            <span class="font-content">{feedback.text}</span>
          </span>
        </div>
      );
    } else if (planChange && editorOpen) {
      feedbackNode = (
        <div class="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
          <label for={`feedback-${handle.id}`} class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Icon icon={MessageSquarePlus} class="size-3.5 shrink-0" />
            {t("prompt.feedback.planChange.editorLabel")}
          </label>
          <textarea
            id={`feedback-${handle.id}`}
            rows={3}
            maxLength={FEEDBACK_MAX_LENGTH}
            aria-label={t("prompt.feedback.planChange.textAria")}
            placeholder={t("prompt.feedback.planChange.placeholder")}
            value={draft}
            class="w-full resize-none rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            mix={on("input", (event) => {
              draft = event.currentTarget.value;
              void handle.update();
            })}
          />
          <p class="text-[11px] leading-snug text-muted-foreground">{t("prompt.feedback.planChange.help")}</p>
          <div class="flex items-center justify-end gap-1.5">
            <button
              type="button"
              class="rounded-md px-2.5 py-1.5 text-xs text-muted-foreground active:bg-muted"
              mix={on("click", () => {
                editorOpen = false;
                void handle.update();
              })}
            >
              {t("prompt.feedback.cancel")}
            </button>
            <button
              type="button"
              disabled={locked || draft.trim() === ""}
              class="flex items-center gap-1.5 rounded-md border border-primary/60 bg-primary/15 px-2.5 py-1.5 text-xs font-medium text-foreground active:bg-primary/25 disabled:opacity-60"
              mix={on("click", async () => {
                const text = draft.trim();
                if (text === "") return;
                if (await press("feedback", () => actions.feedback(text))) {
                  editorOpen = false;
                  void handle.update();
                }
              })}
            >
              {t("prompt.feedback.planChange.send")}
            </button>
          </div>
        </div>
      );
    } else if (planChange) {
      feedbackNode = (
        <button
          type="button"
          disabled={locked}
          class="flex w-full items-center gap-2 rounded-lg border border-dashed border-border/60 px-3 py-1.5 text-left text-xs text-muted-foreground active:bg-muted disabled:opacity-60"
          mix={on("click", () => {
            draft = "";
            editorOpen = true;
            void handle.update();
          })}
        >
          <Icon icon={MessageSquarePlus} class="size-3.5 shrink-0" />
          {t("prompt.feedback.planChange.offer")}
        </button>
      );
    }
    return (
      <PromptPanel ariaLabel={card.question} raw={toRows(card.block.lines)}>
        <OptionCaption>{card.caption}</OptionCaption>
        <div class="flex flex-col gap-1">
          {card.options.map((row, index) => {
            const id = `opt-${String(index)}`;
            const busy = sending === id;
            return (
              <OptionButton
                key={id}
                testId="dialog-option"
                tone={busy ? "busy" : "default"}
                badge={row.badge}
                label={row.label}
                description={row.description}
                disabled={locked}
                trailing={busy ? spinner("mt-0.5 size-4") : null}
                onPress={() => void press(id, () => actions.option(row.option))}
              />
            );
          })}
        </div>
        {feedbackNode}
      </PromptPanel>
    );
  };
}

// ── generic menu ─────────────────────────────────────────────────────────────────────────────────

function MenuDialogCard(handle: Handle<{ card: MenuCard; disabled: boolean; actions: CardActions }>) {
  let sending: string | null = null;
  const press = async (id: string, keys: string[], nav: boolean): Promise<void> => {
    if (handle.props.disabled || sending !== null) return;
    sending = id;
    void handle.update();
    try {
      await handle.props.actions.menu(keys, nav);
    } finally {
      sending = null;
      void handle.update();
    }
  };
  return () => {
    const { card, disabled } = handle.props;
    const { menu, lines } = card.block;
    const locked = disabled || sending !== null;
    const leftRight = menu.nav.leftRight;
    const scale = leftRight?.values ?? [];
    const current = leftRight === undefined ? -1 : scale.indexOf(leftRight.label);
    const stepKeys = (target: number): string[] => {
      const key = target > current ? MENU_RIGHT_KEYS[0]! : MENU_LEFT_KEYS[0]!;
      return Array.from({ length: Math.abs(target - current) }, () => key);
    };
    const navButton = (id: string, label: string, keys: string[], icon: RemixNode) => (
      <button
        key={id}
        type="button"
        aria-label={label}
        disabled={locked}
        class="flex h-9 flex-1 items-center justify-center rounded-lg border border-border bg-secondary text-muted-foreground shadow-sm active:border-primary/50 active:bg-primary/5 disabled:opacity-60"
        mix={on("click", () => void press(id, keys, true))}
      >
        {sending === id ? spinner() : icon}
      </button>
    );
    const rows = toRows(lines);
    return (
      <PromptPanel ariaLabel={menu.title} raw={rows} rawMode={card.readsBody ? "reveal" : "declutter"}>
        <OptionCaption>{card.caption}</OptionCaption>
        {!card.readsBody && <Screen rows={rows} inset />}
        {(menu.nav.upDown || (leftRight !== undefined && !card.readsBody)) && (
          <div class="flex items-center gap-1.5">
            {menu.nav.upDown && navButton("up", t("dialog.menu.moveUp"), MENU_UP_KEYS, <Icon icon={ArrowUp} class="size-4" />)}
            {menu.nav.upDown &&
              navButton("down", t("dialog.menu.moveDown"), MENU_DOWN_KEYS, <Icon icon={ArrowDown} class="size-4" />)}
            {leftRight !== undefined && !card.readsBody && (
              <div class="flex min-w-0 flex-1 items-center gap-1.5">
                {navButton(
                  "left",
                  t("dialog.menu.leftAria", { verb: leftRight.verb, label: leftRight.label }),
                  MENU_LEFT_KEYS,
                  <Icon icon={ArrowLeft} class="size-4" />,
                )}
                <span class="min-w-0 flex-1 truncate text-center font-mono text-[11px] text-muted-foreground">
                  {leftRight.label}
                </span>
                {navButton(
                  "right",
                  t("dialog.menu.rightAria", { verb: leftRight.verb, label: leftRight.label }),
                  MENU_RIGHT_KEYS,
                  <Icon icon={ArrowRight} class="size-4" />,
                )}
              </div>
            )}
          </div>
        )}
        {card.readsBody && leftRight !== undefined && (
          <div class="flex flex-wrap gap-1.5">
            {scale.map((value, i) => {
              const isCurrent = i === current;
              return (
                <button
                  key={value}
                  type="button"
                  aria-current={isCurrent ? "true" : undefined}
                  aria-label={
                    isCurrent
                      ? t("dialog.menu.levelCurrentAria", { label: value })
                      : t("dialog.menu.levelAria", { verb: leftRight.verb, label: value })
                  }
                  disabled={locked || isCurrent}
                  class={cn(
                    "flex min-h-11 min-w-11 grow items-center justify-center rounded-lg border px-3 text-center font-mono text-xs",
                    isCurrent
                      ? "border-primary/60 bg-primary/15 text-foreground"
                      : "border-border bg-secondary text-muted-foreground active:bg-primary/5",
                    locked && "opacity-60",
                  )}
                  mix={on("click", () => void press(`level-${String(i)}`, stepKeys(i), true))}
                >
                  {value}
                </button>
              );
            })}
          </div>
        )}
        <div class="flex flex-col gap-1">
          {[...menu.actions.filter((a) => !a.cancel), ...menu.actions.filter((a) => a.cancel)].map((action, i) => {
            const id = `action-${String(i)}`;
            return (
              <button
                key={id}
                type="button"
                disabled={locked}
                class={cn(
                  "font-content flex w-full items-center justify-center gap-2 rounded-lg border disabled:opacity-60",
                  action.cancel
                    ? "border-border px-3 py-1.5 text-xs text-muted-foreground active:bg-muted"
                    : "border-primary/60 bg-primary/15 px-3 py-2 text-sm font-medium text-foreground active:bg-primary/25",
                )}
                mix={on("click", () => void press(id, action.keys, false))}
              >
                {sending === id ? spinner() : null}
                {action.label}
              </button>
            );
          })}
        </div>
      </PromptPanel>
    );
  };
}

// ── unread dialog ────────────────────────────────────────────────────────────────────────────────

/** How long the first tap stays armed before the second one must come (unread-dialog-block.tsx). */
const ARM_MS = 4000;
const NAMES_A_DISMISS = /\besc\s+dismiss\b/i;

function UnreadDialogCard(handle: Handle<{ card: UnreadCard; disabled: boolean; actions: CardActions }>) {
  let sending = false;
  let armedFor: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  handle.signal.addEventListener("abort", () => clearTimeout(timer));
  return () => {
    const { card, disabled } = handle.props;
    const rows = toRows(card.block.lines);
    // The arm is for THIS screen: a different screen under the same card needs a fresh first tap.
    const identity = `${card.block.cancel.key}\n${rows.map((r) => r.sig).join("\n")}`;
    const armed = armedFor === identity && !disabled;
    const dismissWording = rows.some((r) => NAMES_A_DISMISS.test(r.spans.map((s) => s.text).join("")));
    const armedLabel = dismissWording
      ? t("unreadDialog.confirmDismiss")
      : t("unreadDialog.confirmKey", { key: card.keyName });
    return (
      <PromptPanel ariaLabel={card.caption} raw={rows} rawMode="declutter">
        <OptionCaption>{card.caption}</OptionCaption>
        <button
          type="button"
          data-testid="unread-dialog-key"
          disabled={disabled || sending}
          aria-busy={sending}
          class={cn(
            "font-content flex min-h-11 w-full items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium text-foreground disabled:opacity-60",
            sending || armed ? "border-primary bg-primary/25" : "border-primary/60 bg-primary/15 active:bg-primary/25",
          )}
          mix={on("click", async () => {
            if (handle.props.disabled || sending) return;
            clearTimeout(timer);
            if (!armed) {
              armedFor = identity;
              timer = setTimeout(() => {
                armedFor = null;
                void handle.update();
              }, ARM_MS);
              void handle.update();
              return;
            }
            armedFor = null;
            sending = true;
            void handle.update();
            try {
              await handle.props.actions.unread();
            } finally {
              sending = false;
              void handle.update();
            }
          })}
        >
          {armed ? armedLabel : card.keyName}
        </button>
        <span role="status" class="sr-only">
          {armed ? armedLabel : ""}
        </span>
        <Screen rows={rows} inset />
      </PromptPanel>
    );
  };
}

// ── wizard, multi-select, preview-select: the region, answered from the Keys row ─────────────────

function KeysOnlyDialogCard(handle: Handle<{ card: KeysOnlyCard }>) {
  return () => {
    const { card } = handle.props;
    return (
      <PromptPanel ariaLabel={card.caption}>
        <OptionCaption>{card.caption}</OptionCaption>
        <Screen rows={toRows(card.block.lines)} inset />
      </PromptPanel>
    );
  };
}

// ── the dock ─────────────────────────────────────────────────────────────────────────────────────

export interface CardDockProps {
  card: DialogCard;
  disabled: boolean;
  actions: CardActions;
}

export function CardDock(handle: Handle<CardDockProps>) {
  return () => {
    const { card, disabled, actions } = handle.props;
    // Keyed by kind: the same dialog re-rendered by a poll keeps its card (and its Terminal choice);
    // a different kind is a fresh card.
    let body: RemixNode;
    switch (card.kind) {
      case "prompt-select":
        body = <PromptSelectCard key="prompt-select" card={card} disabled={disabled} actions={actions} />;
        break;
      case "menu":
        body = <MenuDialogCard key="menu" card={card} disabled={disabled} actions={actions} />;
        break;
      case "unread-dialog":
        body = <UnreadDialogCard key="unread-dialog" card={card} disabled={disabled} actions={actions} />;
        break;
      case "keys-only":
        body = <KeysOnlyDialogCard key="keys-only" card={card} />;
        break;
    }
    return (
      <div data-slot="card-dock" data-card={card.kind} class="max-h-[55dvh] shrink-0 overflow-y-auto border-t border-rule px-2">
        {body}
      </div>
    );
  };
}
