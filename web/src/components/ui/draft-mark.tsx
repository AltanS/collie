import { Icon } from "@/components/icons/icon";
import { useHasDraft } from "@/hooks/use-has-draft";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";
import { cn } from "@/lib/utils";

/**
 * THE DRAFT MARK: a small muted pencil on the row of a pane that holds an unsent draft on this device (the
 * words or chips a person typed into Collie's composer and did not send, lib/drafts.ts). It is the one mark
 * every list of panes draws: the dashboard's rows, the sidebar, the Switch pane sheet and the Actions palette.
 *
 * It is quiet on purpose: the muted ink, the size of the unseen mark's box, no colour, no count, no motion.
 * It is not an alert, and it never takes the blocked red. `off` is the row of the pane that is on screen,
 * where the person sees the composer itself. `reserve` keeps the slot, drawn invisible, as `UnseenMark` does,
 * so a name truncates at one width whether the mark is there or not and nothing shifts when it comes or goes
 * (DESIGN.md section 2). The words are for a screen reader only while the mark is drawn.
 */
export function DraftMark({
  scope,
  paneId,
  off = false,
  reserve = false,
  className,
}: {
  /** The pane's own address, the one its composer saves under. Absent: the lead's primary session. */
  scope?: Scope | undefined;
  paneId: string;
  off?: boolean;
  reserve?: boolean;
  className?: string;
}) {
  useLocale();
  const has = useHasDraft(scope, paneId);
  const on = has && !off;
  if (!on && !reserve) return null;
  return (
    <Icon
      name="pane-draft"
      data-slot="draft-mark"
      data-on={on ? "true" : "false"}
      role={on ? "img" : undefined}
      aria-label={on ? t("pane.draftMark") : undefined}
      aria-hidden={on ? undefined : true}
      className={cn("size-3 shrink-0 self-center text-muted-foreground", !on && "invisible", className)}
    />
  );
}
