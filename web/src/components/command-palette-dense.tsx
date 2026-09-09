import { Pencil } from "lucide-react";

import { cn } from "@/lib/utils";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { commandsFor, type AgentCommand } from "@/lib/agent-commands";
import { quickRepliesFor } from "@/lib/quick-replies";
import type { OperatorCommand, OperatorQuickReplyRow } from "@/lib/types";

export interface CommandPaletteDenseProps {
  onClose: () => void;
  agent: string | undefined | null;
  /** A bare shell gets y/n replies, never agent phrases (lib/quick-replies). */
  isShell: boolean;
  /** The operator's own rows (`commands.toml`); they replace the catalog on panes they address. */
  mine?: readonly OperatorCommand[];
  /** The operator's own reply groups (`quick-replies.toml`); same replace rule, same panes. */
  mineReplies?: readonly OperatorQuickReplyRow[];
  /** Insert "/cmd " into the composer for the user to complete (arg-taking commands). */
  onInsert: (text: string) => void;
  /** Send "/cmd" immediately and submit (no-arg commands). */
  onSubmit: (text: string) => void;
}

// One chip shape for the command flow. Replies stay visually apart (solid fill, own header)
// while commands run outlined beneath with none. Module-level so it is not a fresh component
// type each render (which would remount the flow).
function CommandChip({
  c,
  isPending,
  onPick,
}: {
  c: AgentCommand;
  isPending: boolean;
  onPick: (c: AgentCommand) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(c)}
      aria-label={isPending ? `Tap again to confirm ${c.command}` : undefined}
      className={cn(
        "flex h-11 shrink-0 items-center gap-1.5 rounded-lg border px-3 font-mono text-sm font-semibold transition-transform active:scale-[0.97]",
        // A pending dangerous confirm has no room for words on a chip — the red fill IS the
        // question, and the second tap answers it. Same two-tap behind it as ever.
        isPending
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-input text-foreground",
      )}
    >
      {c.command}
      {c.takesArg && !isPending && (
        <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}
export function CommandPaletteDense({
  onClose,
  agent,
  isShell,
  mine,
  mineReplies,
  onInsert,
  onSubmit,
}: CommandPaletteDenseProps) {
  const { pending, confirm, reset } = usePendingConfirm();

  // No search, no filter: the catalogs lead with their common rows, so the full list reads
  // common-first and the sheet scrolls the rest. Fifty rows of scroll worst case (Claude).
  const list = commandsFor(agent, mine);

  // One-tap replies as chips above the commands — a reply carries no description worth a row,
  // so it gets a pill, not a PaletteRow. The operator's own groups replace the shipped ones
  // per pane under the same rule as commands (ADR 0018).
  const replies: readonly string[] = quickRepliesFor(agent, isShell, mineReplies ?? []).flatMap(
    (g) => g.items,
  );

  function pickReply(item: string) {
    // Replies never take args and are never dangerous — straight submit, like pick's fast path.
    onSubmit(item);
    onClose();
  }

  function pick(c: AgentCommand) {
    if (c.takesArg) {
      onInsert(`${c.command} `);
      onClose();
      return;
    }
    if (c.dangerous && !confirm(c.command)) return; // first tap arms the confirm
    reset();
    onSubmit(c.command);
    onClose();
  }

  return (
    <>
      {replies.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {replies.map((item, i) => (
            <button
              key={`reply:${i}`}
              type="button"
              onClick={() => pickReply(item)}
              className="h-11 shrink-0 rounded-lg bg-muted px-4 font-mono text-sm font-semibold text-foreground transition-transform active:scale-[0.97]"
            >
              {item}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {list.map((c) => (
          <CommandChip key={c.command} c={c} isPending={pending === c.command} onPick={pick} />
        ))}
      </div>
    </>
  );
}
