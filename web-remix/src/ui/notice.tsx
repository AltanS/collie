import { on, type Handle, type RemixNode } from "remix/component";
import { X } from "lucide";

import { cn } from "@web/lib/utils";

import { Icon } from "./icon";

// Port of web/src/components/ui/notice.tsx: one inline notice, strip or box, in one of five tones.
// The React original types the four interaction combinations as a union; here they are optional
// props with the same rules: `onActivate` makes the whole notice a button, `onDismiss` needs
// `dismissLabel`.
export type NoticeTone = "info" | "caution" | "danger" | "success" | "neutral";
export type NoticeVariant = "strip" | "box";
export type NoticeAnnounce = "alert" | "status" | "none";

const TONE = {
  info: { surface: "border-status-info/40 bg-status-info/15", accent: "text-status-info" },
  caution: { surface: "border-status-working/40 bg-status-working/15", accent: "text-status-working" },
  danger: { surface: "border-status-blocked/40 bg-status-blocked/15", accent: "text-status-blocked" },
  success: { surface: "border-status-done/40 bg-status-done/15", accent: "text-status-done" },
  neutral: { surface: "border-border bg-muted/40", accent: "text-muted-foreground" },
} satisfies Record<NoticeTone, { surface: string; accent: string }>;

export const NOTICE_ACTION_TAP = "relative before:absolute before:inset-x-0 before:-inset-y-[11px] before:content-['']";
export const NOTICE_ACTION = `h-6 gap-1 px-2 text-xs ${NOTICE_ACTION_TAP}`;

const STRIP = "flex min-h-[33px] w-full items-center gap-2 border-b px-4 py-1 text-xs text-foreground";
const BOX = "flex min-h-[42px] items-start gap-2 rounded-sm border px-4 py-2 text-xs font-medium";

export interface NoticeProps {
  tone: NoticeTone;
  variant: NoticeVariant;
  announce?: NoticeAnnounce;
  icon?: RemixNode;
  children?: RemixNode;
  class?: string;
  onActivate?: () => void;
  action?: RemixNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}

export function Notice(handle: Handle<NoticeProps>) {
  const bodyId = `notice-${handle.id}`;
  return () => {
    const { tone, variant, announce = "none", icon, children, onActivate, action, onDismiss, dismissLabel } = handle.props;
    const { surface, accent } = TONE[tone];
    const strip = variant === "strip";
    const role = announce === "none" ? undefined : announce;
    const body = strip ? (
      <span role={role} id={onActivate ? bodyId : undefined} class="min-w-0 flex-1 truncate font-medium">
        {children}
      </span>
    ) : (
      <div role={role} id={onActivate ? bodyId : undefined} class="flex min-h-6 min-w-0 flex-1 flex-col justify-center">
        {children}
      </div>
    );
    return (
      <div data-slot="notice" class={cn(strip ? STRIP : BOX, surface, !strip && accent, onActivate && "relative", handle.props.class)}>
        {onActivate ? (
          <button
            type="button"
            aria-labelledby={bodyId}
            mix={on("click", () => handle.props.onActivate?.())}
            class="absolute inset-x-0 -inset-y-[5.5px] rounded-[inherit] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        ) : null}
        {icon ? (
          <span aria-hidden="true" class={cn("flex shrink-0 [&>svg]:size-3.5", strip ? cn("items-center", accent) : "mt-[5px]")}>
            {icon}
          </span>
        ) : null}
        {body}
        {action || onDismiss ? (
          <div class="relative flex shrink-0 items-center gap-1">
            {action}
            {onDismiss ? (
              <button
                type="button"
                aria-label={dismissLabel}
                mix={on("click", () => handle.props.onDismiss?.())}
                class={cn(
                  "flex size-6 items-center justify-center rounded-sm opacity-70 hover:opacity-100",
                  NOTICE_ACTION_TAP,
                  "before:-inset-x-[11px]",
                )}
              >
                <Icon icon={X} class="size-3.5" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };
}
