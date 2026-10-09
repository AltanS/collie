import { useCallback, useState } from "react";

import { useCrew } from "@/components/crew-provider";
import { NoPromptsSheet, type NoPromptsAsk } from "@/components/no-prompts-sheet";
import { leadHost } from "@/lib/hosts";
import { needsNoPromptsConfirm, rememberNoPromptsConfirm } from "@/lib/no-prompts";

/** One start that may need the confirm first. */
export interface GuardedStart {
  /** The row or item being started: `noPrompts` and the line it types. */
  item: { noPrompts?: boolean; command?: string };
  /**
   * The machine the start lands on, as the confirm is keyed: `""` for the lead or a solo install,
   * the member's id otherwise (lib/no-prompts.ts).
   */
  machine: string;
  /** The folder, as the person reads it. */
  folder: string;
  /** What the start does once it is allowed. */
  go: () => void;
}

/**
 * THE ONE PLACE A "NO PROMPTS" START IS GUARDED (ADR 0094). Every way to start a launcher goes
 * through `guard`: the New page's Start and its Again row, the dashboard's Launch strip, and the
 * switcher sheet's Launch section. A start whose item does not skip prompts, or that this device
 * already confirmed on this machine for this line, runs at once. Otherwise the "Start without
 * prompts?" sheet opens, and nothing runs until Start is tapped. Cancel runs nothing and remembers
 * nothing.
 *
 * Render `sheet` once, anywhere that is not inside a transformed ancestor (a BottomSheet is `fixed`).
 */
export function useNoPromptsGuard() {
  const { servers } = useCrew();
  const [pending, setPending] = useState<GuardedStart | null>(null);
  const lead = leadHost(servers);

  const guard = useCallback(
    (asked: GuardedStart) => {
      // The lead is `""` however a caller names it (`?h=<its id>` or no `?h=`), so one machine has
      // one confirm.
      const start = asked.machine !== "" && asked.machine === lead ? { ...asked, machine: "" } : asked;
      if (needsNoPromptsConfirm(start.item, start.machine)) setPending(start);
      else start.go();
    },
    [lead],
  );

  const named = servers.find((s) => s.id === (pending?.machine || lead));
  let ask: NoPromptsAsk | null = null;
  if (pending !== null) {
    ask = { command: pending.item.command ?? "", folder: pending.folder };
    if (named !== undefined) ask.machine = named.name || named.id;
  }

  const sheet = (
    <NoPromptsSheet
      ask={ask}
      onCancel={() => setPending(null)}
      onStart={() => {
        if (pending === null) return;
        // Kept before the start, so a start that is refused or lost does not ask a second time.
        if (pending.item.command !== undefined) rememberNoPromptsConfirm(pending.machine, pending.item.command);
        setPending(null);
        pending.go();
      }}
    />
  );
  return { guard, sheet };
}
