import { Server } from "lucide-react";

import { cn } from "@/lib/utils";
import { hostName, serverFor } from "@/lib/hosts";
import { usePack } from "@/components/pack-provider";

interface HostChipProps {
  /** The machine this row/sheet/send is about. Undefined = nothing to say (and nothing renders). */
  host: string | undefined;
  /** Override the roster's reachability (the switcher renders its own rows). */
  reachable?: boolean;
  /** Extra emphasis for the write surfaces — a touch larger, with the "on" preposition. */
  variant?: "tag" | "target";
  className?: string;
}

// The one place that answers "which machine is this?", and the one place that decides whether the
// question is even worth asking.
//
// ── THE HIDE RULE LIVES HERE, NOT IN THE CALLERS ─────────────────────────────
// Renders `null` when the pack is a single machine — i.e. for every install that exists today —
// which is why callers may mount it unconditionally. If each caller had to ask "am I on a pack?"
// first, a solo install would eventually grow a stray chip and, far worse, a pack install would
// eventually drop one at the surface that mattered.
//
// ── AND WHY IT IS NEVER THE SESSION SWITCHER'S TWIN ──────────────────────────
// Two lookalike pills, one changing machines and one changing sessions, is a mis-tap waiting to
// happen (milestone constraint). So this is deliberately NOT a control: no tap target, no chevron, a
// server glyph rather than the switcher's layers, and it is a plain text node — a host name comes
// from the operator's `join` label and is rendered as text, never markup, like every other
// user-supplied string that reaches this UI.
export function HostChip({ host, reachable, variant = "tag", className }: HostChipProps) {
  const { servers, multi } = usePack();
  // No pack, or nothing to name: the whole dimension is invisible.
  if (!multi || host === undefined) return null;

  const name = hostName(servers, host) ?? host;
  // An unlisted host (a member that departed while you were looking at it) is not assumed healthy —
  // it renders as itself, unreachable, rather than being dropped or quietly relabelled.
  const live = reachable ?? serverFor(servers, host)?.reachable ?? false;
  const target = variant === "target";

  return (
    <span
      // The name is decorative repetition for a screen reader if it were bare text, so the whole
      // chip carries one label that says what it MEANS.
      aria-label={`${target ? "Sends to host" : "Host"}: ${name}${live ? "" : " (unreachable)"}`}
      className={cn(
        "inline-flex max-w-[8rem] shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 font-medium",
        target ? "text-[11px]" : "text-[10px]",
        live
          ? "border-border bg-muted/60 text-muted-foreground"
          : // Unreachable is a STATE, not a disappearance (PACK_PROTOCOL.md §10.2) — it stays legible,
            // dashed rather than dimmed, so a blocked agent on a down machine is never greyed away.
            "border-dashed border-status-blocked/50 bg-status-blocked/10 text-status-blocked",
        className,
      )}
    >
      <Server className="size-3 shrink-0" aria-hidden />
      {target && (
        <span className="shrink-0 text-muted-foreground/70" aria-hidden>
          on
        </span>
      )}
      <span className="truncate" aria-hidden>
        {name}
      </span>
    </span>
  );
}
