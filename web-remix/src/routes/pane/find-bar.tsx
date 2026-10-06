// The find bar, drawn in the header's row while find is open (the override claim's trailing slot;
// the override's own back arrow closes it). Port of web/src/components/find-bar.tsx. The input is
// uncontrolled: it owns its value and reports each change to the find store (lib/find.ts). The step
// buttons are the shared ghost icon Button, as web's are, so they wear its press (`active:scale-[0.98]`).
import { on, ref, type Handle } from "remix/component";
import { ChevronDown, ChevronUp, Search } from "lucide";

import { t } from "@web/lib/i18n";

import type { Find } from "../../lib/find";
import { useLocale } from "../../lib/i18n-store";
import { useStore } from "../../lib/store";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";

export function FindBar(handle: Handle<{ find: Find; subject?: string }>) {
  useLocale(handle);
  const read = useStore(handle, handle.props.find.state);
  return () => {
    const { find } = handle.props;
    const { query, count, current } = read();
    const subject = handle.props.subject ?? t("find.subject.output");
    const label = query === "" ? "" : count > 0 ? `${String(current + 1)}/${String(count)}` : "0/0";
    return (
      <div data-testid="find-bar" class="flex min-w-0 flex-[6] items-center gap-1.5">
        <Icon icon={Search} class="pointer-events-none size-4 shrink-0 text-muted-foreground" />
        <input
          type="text"
          inputMode="search"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-testid="find-input"
          placeholder={t("find.placeholder", { subject })}
          aria-label={t("find.aria", { subject })}
          class="h-9 min-w-0 flex-1 bg-transparent text-base placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          mix={[
            ref((node: HTMLInputElement) => {
              node.value = find.state.get().query;
              queueMicrotask(() => node.focus());
            }),
            on("input", (event) => find.setQuery(event.currentTarget.value)),
            on("keydown", (event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (event.shiftKey) find.prev();
                else find.next();
              } else if (event.key === "Escape") {
                event.preventDefault();
                find.close();
              }
            }),
          ]}
        />
        <span data-testid="find-count" class="shrink-0 px-1 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          {label}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("find.prevAria")}
          disabled={count === 0}
          class="size-9 shrink-0 text-muted-foreground"
          mix={on("click", () => find.prev())}
        >
          <Icon icon={ChevronUp} class="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("find.nextAria")}
          disabled={count === 0}
          class="size-9 shrink-0 text-muted-foreground"
          mix={on("click", () => find.next())}
        >
          <Icon icon={ChevronDown} class="size-4" />
        </Button>
      </div>
    );
  };
}
