// The find bar of the History view (web/src/components/find-bar.tsx). It takes over the whole header row, as
// web's does: the route claims the header with an `override` whose `trailing` slot draws this bar, and the
// bar grows past the override's own h1 (`flex-[1000_1_0%]` against the h1's `flex-1`), which keeps its
// text for screen readers and loses its width to the field. Enter is next, Shift+Enter previous, Escape closes. The count reads "2/9", or a
// zero when nothing matches, and the arrows are inert then.
import { on, ref, type Handle } from "remix/component";
import { ChevronDown, ChevronUp, Search, X } from "lucide";

import { t } from "@web/lib/i18n";

import { useLocale } from "../../lib/i18n-store";
import { Icon } from "../../ui/icon";

export interface FindBarProps {
  query: string;
  count: number;
  /** Zero-based position among the matches. */
  current: number;
  subject: string;
  onQueryChange: (query: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

const ICON_BUTTON =
  "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors active:bg-muted/60 disabled:opacity-40";

export function FindBar(handle: Handle<FindBarProps>) {
  useLocale(handle);
  return () => {
    const { query, count, current, subject } = handle.props;
    return (
      <div role="search" data-testid="find-bar" class="flex min-w-0 flex-[1000_1_0%] items-center gap-1">
        <Icon icon={Search} class="size-4 shrink-0 text-muted-foreground" />
        <input
          type="search"
          value={query}
          placeholder={t("find.placeholder", { subject })}
          aria-label={t("find.aria", { subject })}
          class="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          mix={[
            // Open means typing: focus once, when the row mounts.
            ref((node: HTMLInputElement) => node.focus()),
            on("input", (event) => handle.props.onQueryChange(event.currentTarget.value)),
            on("keydown", (event) => {
              if (event.key === "Escape") handle.props.onClose();
              else if (event.key === "Enter") {
                event.preventDefault();
                if (event.shiftKey) handle.props.onPrev();
                else handle.props.onNext();
              }
            }),
          ]}
        />
        {query.trim() === "" ? null : (
          <span class="shrink-0 text-xs text-muted-foreground tabular-nums" data-testid="find-count">
            {count === 0 ? "0" : `${String(current + 1)}/${String(count)}`}
          </span>
        )}
        <button type="button" aria-label={t("find.prevAria")} disabled={count === 0} class={ICON_BUTTON} mix={on("click", () => handle.props.onPrev())}>
          <Icon icon={ChevronUp} class="size-4" />
        </button>
        <button type="button" aria-label={t("find.nextAria")} disabled={count === 0} class={ICON_BUTTON} mix={on("click", () => handle.props.onNext())}>
          <Icon icon={ChevronDown} class="size-4" />
        </button>
        <button type="button" aria-label={t("find.closeAria")} class={ICON_BUTTON} mix={on("click", () => handle.props.onClose())}>
          <Icon icon={X} class="size-4" />
        </button>
      </div>
    );
  };
}
