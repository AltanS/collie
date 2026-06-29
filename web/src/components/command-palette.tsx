import { useEffect, useRef, useState } from "react";
import { CornerDownLeft, Pencil, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { BottomSheet } from "@/components/ui/sheet";
import { commandsFor, type AgentCommand } from "@/lib/agent-commands";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  agent: string | undefined | null;
  /** Insert "/cmd " into the composer for the user to complete (arg-taking commands). */
  onInsert: (text: string) => void;
  /** Send "/cmd" immediately and submit (no-arg commands). */
  onSubmit: (text: string) => void;
}

export function CommandPalette({ open, onClose, agent, onInsert, onSubmit }: CommandPaletteProps) {
  const all = commandsFor(agent);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  // Reset transient state whenever the sheet (re)opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setPending(null);
    }
  }, [open]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const q = query.trim().toLowerCase();
  const list = q
    ? all.filter(
        (c) =>
          c.command.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
      )
    : all.filter((c) => c.common);

  function pick(c: AgentCommand) {
    if (c.takesArg) {
      onInsert(`${c.command} `);
      onClose();
      return;
    }
    if (c.dangerous && pending !== c.command) {
      setPending(c.command);
      if (timer.current) clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setPending(null), 3000);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setPending(null);
    onSubmit(c.command);
    onClose();
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Agent commands" className="max-h-[85dvh]">
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          inputMode="search"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${all.length} commands…`}
          className="h-11 w-full rounded-md border border-input bg-transparent pl-9 pr-3 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>

      {!q && (
        <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
          Common · type to search all {all.length}
        </p>
      )}

      <div className="flex flex-col gap-1">
        {list.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">No commands match “{query}”.</p>
        )}
        {list.map((c) => {
          const isPending = pending === c.command;
          return (
            <button
              key={c.command}
              type="button"
              onClick={() => pick(c)}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors active:scale-[0.99]",
                isPending ? "bg-destructive/10" : "hover:bg-accent",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "font-mono text-sm font-semibold",
                      c.dangerous ? "text-destructive" : "text-foreground",
                    )}
                  >
                    {c.command}
                  </span>
                  {c.takesArg && (
                    <span className="font-mono text-[11px] text-muted-foreground">{c.argHint}</span>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">{c.description}</p>
              </div>
              {isPending ? (
                <span className="shrink-0 text-xs font-medium text-destructive">Confirm?</span>
              ) : c.takesArg ? (
                <Pencil className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <CornerDownLeft className="size-4 shrink-0 text-muted-foreground" />
              )}
            </button>
          );
        })}
      </div>
    </BottomSheet>
  );
}
