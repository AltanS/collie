import { on, type Handle, type RemixNode } from "remix/component";
import { CircleDot, LoaderCircle, Pin, Plus } from "lucide";

import { t } from "@web/lib/i18n";
import type { Scope } from "@web/lib/scope";
import { cn } from "@web/lib/utils";

import { capability } from "../../chips/capability";
import { currentCrew, hostWriteBlock } from "../../chips/crew";
import { useLocale } from "../../lib/i18n-store";
import { ORDER_SEGMENTS, ORDERS, type PaneOrder } from "../../lib/pane-order";
import { retirePinHint } from "../../lib/pins";
import { setStatus } from "../../lib/status";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import { Notice } from "../../ui/notice";

// The dashboard's list controls, ported from web/src/components: needs-you-switch.tsx (with
// ui/toggle-button.tsx), pane-order-toggle.tsx, pin-hint.tsx and workspace-new-tab.tsx (with
// ui/add-button.tsx). Each is a 44 px target, and none moves anything around it when its state
// changes (DESIGN.md §2).

/** Needs you (ADR 0085): the filter that keeps only what needs you. The counts above cover everything. */
export function NeedsYouSwitch(handle: Handle<{ on: boolean; onChange: (on: boolean) => void }>) {
  useLocale(handle);
  return () => {
    const pressed = handle.props.on;
    return (
      <button
        type="button"
        data-slot="toggle-button"
        data-testid="needs-you-switch"
        aria-pressed={pressed}
        aria-label={t("home.needsYouOnly")}
        mix={on("click", () => handle.props.onChange(!handle.props.on))}
        class={cn(
          "relative flex size-11 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          pressed ? "bg-primary/10 text-primary ring-1 ring-inset ring-primary/40" : "text-muted-foreground active:bg-muted",
        )}
      >
        <span aria-hidden="true" class="flex shrink-0">
          <Icon icon={CircleDot} class="size-4 shrink-0" />
        </span>
      </button>
    );
  };
}

/** Place, activity or cache order, three compact 44 px segments (ADR 0071). */
export function PaneOrderToggle(handle: Handle<{ order: PaneOrder; onChange: (order: PaneOrder) => void }>) {
  useLocale(handle);
  return () => {
    const { order } = handle.props;
    return (
      <div role="radiogroup" aria-label={t("paneOrder.aria")} data-testid="pane-order-toggle" class="flex shrink-0 gap-1">
        {ORDERS.map((value) => {
          const { label, icon } = ORDER_SEGMENTS[value];
          const selected = value === order;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              data-order={value}
              aria-checked={selected}
              aria-label={t(label)}
              mix={on("click", () => handle.props.onChange(value))}
              class={cn(
                "flex size-11 min-h-11 shrink-0 items-center justify-center rounded-md text-sm font-medium transition-colors",
                selected ? "bg-muted text-foreground" : "text-muted-foreground active:bg-muted",
              )}
            >
              <Icon icon={icon} class="size-4 shrink-0" />
            </button>
          );
        })}
      </div>
    );
  };
}

/**
 * The pin hint (M38/02): in the place the Pinned group takes, while nothing is pinned. Dismissed or
 * retired by the first pin, it never comes back on this device (`collie:pin-hint:v1`).
 */
export function PinHint(handle: Handle<{ open: boolean; onFocusLeaves?: () => void }>) {
  useLocale(handle);
  let box: HTMLElement | null = null;
  return () => (
    <Collapse open={handle.props.open} class="-mt-5">
      {handle.props.open ? (
        <div
          class="pt-5"
          data-testid="pin-hint"
          mix={on("focusin", (event) => {
            box = event.currentTarget;
          })}
        >
          <Notice
            tone="neutral"
            variant="box"
            icon={<Icon icon={Pin} class="size-4 shrink-0" />}
            dismissLabel={t("home.pinHint.dismiss")}
            onDismiss={() => {
              const hadFocus = box?.contains(document.activeElement) ?? false;
              retirePinHint();
              if (hadFocus) handle.props.onFocusLeaves?.();
            }}
          >
            {/* Both sentences, and CSS picks by the pointer: the bridge renders this on Bun (S1), where
                there is no pointer to ask, and the hydrating browser must find the same markup. */}
            <span class="pointer-fine:hidden">{t("home.pinHint.hold")}</span>
            <span class="hidden pointer-fine:inline">{t("home.pinHint.rightClick")}</span>
          </Notice>
        </div>
      ) : null}
    </Collapse>
  );
}

/** The 28 px dashed "+" with a 46 px reach (web/'s AddButton at `sm` and HEADING_ADD_REACH). */
export const HEADING_ADD_REACH = "relative before:absolute before:-inset-[9px] before:content-['']";

export function AddButton(handle: Handle<{ label: string; onClick: () => void; busy?: boolean; class?: string; testId?: string }>) {
  return () => {
    const { label, busy = false, testId } = handle.props;
    return (
      <button
        type="button"
        data-testid={testId}
        disabled={busy}
        aria-label={label}
        aria-busy={busy}
        mix={on("click", () => handle.props.onClick())}
        class={cn(
          HEADING_ADD_REACH,
          "flex size-7 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:bg-accent active:scale-95 disabled:opacity-100",
          handle.props.class,
        )}
      >
        {busy ? <Icon icon={LoaderCircle} class="size-4 animate-spin" /> : <Icon icon={Plus} class="size-4" />}
      </button>
    );
  };
}

/**
 * The "+" at the end of a strong workspace heading (M40/03): a new tab in that workspace. Hidden when
 * the multiplexer cannot create a tab; a quiet machine answers in the status line.
 */
export function WorkspaceNewTab(
  handle: Handle<{ workspaceId: string; label: string; at: Scope; host: string | undefined; busy: boolean; onNewTab: (workspaceId: string, at: Scope) => void }>,
) {
  useLocale(handle);
  return (): RemixNode => {
    const { label, busy } = handle.props;
    if (!capability("createTab").capable) return null;
    return (
      <AddButton
        testId="workspace-new-tab"
        class="ml-1"
        label={t("home.group.newTab", { name: label })}
        busy={busy}
        onClick={() => {
          const block = hostWriteBlock(currentCrew(), handle.props.host);
          if (block !== undefined) {
            setStatus(block, "error");
            return;
          }
          handle.props.onNewTab(handle.props.workspaceId, handle.props.at);
        }}
      />
    );
  };
}
