import { on, type Handle, type RemixNode } from "remix/component";

import { t } from "@web/lib/i18n";
import { TRIAGE_STATUS, type TriageKey } from "@web/lib/triage";
import { statusLabel } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { LONG_PRESS_EVENT, longPress } from "../lib/gestures";
import { STRIP_TAP_TARGET } from "./labelled-strip";
import { StatusDot } from "./status-dot";
import { UnseenMark } from "./unseen-mark";

// Port of web/src/components/ui/chip.tsx: the pill shared by the space and tab strips. Same classes,
// same states (active, ring, dimmed), the leading status dot, and the long-press path.
export interface ChipProps {
  label: string;
  glyph?: RemixNode;
  ariaLabel?: string;
  active: boolean;
  ring?: boolean;
  status?: TriageKey | null;
  dimmed?: boolean;
  onClick: () => void;
  onLongPress?: () => void;
  onTapActive?: () => void;
}

export function Chip(handle: Handle<ChipProps>) {
  const descriptionId = `chip-${handle.id}`;
  // The shell kit's hold (lib/gestures.ts): `data-holding` and the fill from 150 ms, the event at
  // 450 ms, the click that ends a hold swallowed. Off when the chip has no long-press action.
  return () => {
    const { label, glyph, ariaLabel, active, ring, status, dimmed, onLongPress } = handle.props;
    const named = ariaLabel !== undefined;
    const statusWords =
      !named || !status ? null : status === "ready" ? t("home.row.unseen") : statusLabel(TRIAGE_STATUS[status]);
    return (
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        aria-label={ariaLabel}
        aria-describedby={statusWords === null ? undefined : descriptionId}
        mix={[
          on("click", () => {
            if (handle.props.active && handle.props.onTapActive) {
              handle.props.onTapActive();
              return;
            }
            handle.props.onClick();
          }),
          longPress({ disabled: onLongPress === undefined }),
          on(LONG_PRESS_EVENT, () => handle.props.onLongPress?.()),
        ]}
        class={cn(
          STRIP_TAP_TARGET,
          "flex min-w-11 shrink-0 select-none items-center justify-center gap-1.5 [-webkit-touch-callout:none] whitespace-nowrap rounded-md border border-transparent px-3 py-1.5 text-sm font-medium transition-colors active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70",
          ring && !active && "border-primary/40",
          dimmed && !active && "bg-transparent border-dashed border-border text-muted-foreground/60 line-through",
        )}
      >
        {glyph}
        {status === "ready" && <UnseenMark size="sm" />}
        {status && status !== "ready" && (
          <>
            <StatusDot status={TRIAGE_STATUS[status]} surface={active ? "bg-primary" : "bg-muted"} class="size-2" />
            {!named && <span class="sr-only">{statusLabel(TRIAGE_STATUS[status])}</span>}
          </>
        )}
        {label}
        {dimmed && !named && <span class="sr-only">{t("home.workspace.hidden")}</span>}
        {statusWords !== null && (
          <span id={descriptionId} class="sr-only">
            {statusWords}
          </span>
        )}
      </button>
    );
  };
}
