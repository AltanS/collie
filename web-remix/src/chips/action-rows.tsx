import { on, ref, type Handle, type RemixNode } from "remix/component";
import { ChevronLeft, LoaderCircle } from "lucide";

import { t } from "@web/lib/i18n";
import { cn } from "@web/lib/utils";

import { useLocale } from "../lib/i18n-store";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

// Port of web/src/components/action-sheet-rows.tsx: the rows the pane and tab action sheets share, so
// the two sheets cannot drift in shape. A row is a 44 px button; the destructive row arms on the first
// tap (its label becomes the confirm) and runs on the second; the rename view is a sub-screen.

export function ActionRow(handle: Handle<{ icon: RemixNode; label: string; hint?: string; onClick: () => void; testId?: string }>) {
  return () => {
    const { icon, label, hint, testId } = handle.props;
    return (
      <button
        type="button"
        data-testid={testId}
        class="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-accent active:bg-muted"
        mix={on("click", () => handle.props.onClick())}
      >
        {icon}
        {hint === undefined ? (
          label
        ) : (
          <span class="min-w-0">
            <span class="block">{label}</span>
            <span class="block text-xs font-normal leading-snug text-muted-foreground">{hint}</span>
          </span>
        )}
      </button>
    );
  };
}

export interface DestructiveActionRowProps {
  icon: RemixNode;
  label: string;
  confirmLabel: string;
  closingLabel: string;
  armed: boolean;
  closing: boolean;
  onClick: () => void;
  testId?: string;
}

export function DestructiveActionRow(handle: Handle<DestructiveActionRowProps>) {
  return () => {
    const { icon, label, confirmLabel, closingLabel, armed, closing, testId } = handle.props;
    return (
      <button
        type="button"
        data-testid={testId}
        data-armed={armed ? "" : undefined}
        disabled={closing}
        class={cn(
          "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors disabled:opacity-60",
          armed ? "bg-destructive text-destructive-foreground" : "text-destructive hover:bg-destructive/10 active:bg-destructive/15",
        )}
        mix={on("click", () => handle.props.onClick())}
      >
        {closing ? <Icon icon={LoaderCircle} class="size-4 shrink-0 animate-spin" /> : icon}
        {closing ? closingLabel : armed ? confirmLabel : label}
      </button>
    );
  };
}

export interface RenameViewProps {
  /** The value the field starts with when the view opens. */
  initial: string;
  /** Called with the field's current text. */
  onSave: (value: string) => void;
  onBack: () => void;
  saving: boolean;
  /** Whether an empty (trimmed) value may be saved: a pane label clears, a tab label may not. */
  allowEmpty: boolean;
  placeholder: string;
}

/**
 * The rename sub-screen. The field is UNCONTROLLED (REMIX3.md, "Forms"): it is filled and focused
 * once when it mounts, and read on save. Enter saves.
 */
export function RenameView(handle: Handle<RenameViewProps>) {
  useLocale(handle);
  let field: HTMLInputElement | null = null;
  let empty = handle.props.initial.trim() === "";
  const save = (): void => {
    const value = field?.value ?? "";
    if (!handle.props.allowEmpty && value.trim() === "") return;
    handle.props.onSave(value);
  };
  return () => {
    const { saving, allowEmpty, placeholder } = handle.props;
    return (
      <div class="flex flex-col gap-3" data-testid="rename-view">
        <button
          type="button"
          class="flex items-center gap-1 self-start rounded-md py-1 pr-2 text-xs font-medium text-muted-foreground transition-colors active:bg-muted"
          mix={on("click", () => handle.props.onBack())}
        >
          <Icon icon={ChevronLeft} class="size-3.5" />
          {t("actionSheet.back")}
        </button>
        <label class="flex flex-col gap-1">
          <span class="text-xs font-medium text-muted-foreground">{t("actionSheet.label")}</span>
          <input
            placeholder={placeholder}
            data-testid="rename-input"
            class="h-11 rounded-lg border border-border bg-background px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            mix={[
              ref((node: HTMLInputElement) => {
                field = node;
                node.value = handle.props.initial;
                node.focus();
              }),
              on("input", (event) => {
                const now = event.currentTarget.value.trim() === "";
                if (now === empty) return;
                empty = now;
                void handle.update();
              }),
              on("keydown", (event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                save();
              }),
            ]}
          />
        </label>
        <Button class="h-11" disabled={saving || (!allowEmpty && empty)} mix={on("click", save)}>
          {saving ? <Icon icon={LoaderCircle} class="size-4 animate-spin" /> : t("actionSheet.save")}
        </Button>
      </div>
    );
  };
}

/**
 * Two-tap confirm (web/src/hooks/use-pending-confirm.ts): the first tap arms `id` for 3 s, the second
 * within that window confirms. One per sheet instance, made in setup; `onChange` re-renders the owner.
 */
export function pendingConfirm(onChange: () => void, signal: AbortSignal, timeoutMs = 3000) {
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return {
    pending: () => pending,
    reset(): void {
      clearTimeout(timer);
      pending = null;
    },
    /** True when this tap confirms; false when it only armed. */
    confirm(id: string): boolean {
      clearTimeout(timer);
      if (pending === id) {
        pending = null;
        return true;
      }
      pending = id;
      timer = setTimeout(() => {
        pending = null;
        onChange();
      }, timeoutMs);
      return false;
    },
  };
}
