import type { ReactNode } from "react";
import { Icon } from "@/components/icons/icon";
import type { IconKey } from "@/components/icons/keys";

/**
 * One navigation row: icon, title, a one-line caption and a chevron. The Settings index draws every
 * row with it, and so does the System page for a row that opens a page below it. A caller that
 * stands in a card of its own wraps it in `Card` with `gap-0 py-0`.
 */
export function SettingsNavRow({
  icon,
  title,
  caption,
  onOpen,
}: {
  icon: IconKey;
  title: string;
  caption: ReactNode;
  onOpen: () => void;
}) {
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 p-4 text-left active:bg-muted/60">
      <Icon name={icon} className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        <p className="truncate text-sm text-muted-foreground">{caption}</p>
      </div>
      <Icon name="row-go" aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
    </button>
  );
}
