import { useEffect, useState } from "react";
import { CornerDownLeft, Pencil } from "lucide-react";

import { cn } from "@/lib/utils";
import { SearchField } from "@/components/ui/search-field";
import { BottomSheet } from "@/components/ui/sheet";
import { AgentIcon } from "@/components/agent-icon";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { commandsFor, type AgentCommand } from "@/lib/agent-commands";
import { fetchClaudeCommands, type ClaudeCommand } from "@/lib/api";
import { canonicalAgent, rowsFor } from "@/lib/operator-scope";
import type { Scope } from "@/lib/scope";
import type { OperatorCommand } from "@/lib/types";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  agent: string | undefined | null;
  /** The pane the palette types into; its machine is asked which skills Claude Code would load there. */
  paneId?: string;
  scope?: Scope;
  /** The operator's own rows (`commands.toml`); they replace the catalog on panes they address. */
  mine?: readonly OperatorCommand[];
  /** On-disk skills already read for this pane by the composer. */
  found?: readonly ClaudeCommand[];
  /** Insert "/cmd " into the composer for the user to complete (arg-taking commands). */
  onInsert: (text: string) => void;
  /** Send "/cmd" immediately and submit (no-arg commands). */
  onSubmit: (text: string) => void;
}

/**
 * Reads the skills and commands the pane's agent would load off disk whenever `active` turns on
 * and no operator `commands.toml` rows replace the palette for this pane (ADR 0018).
 */
export function useClaudeCommands(
  active: boolean,
  agent: string | undefined | null,
  paneId: string | undefined,
  scope?: Scope,
  mine: readonly OperatorCommand[] = [],
): readonly ClaudeCommand[] {
  const [state, setState] = useState<{ key: string; rows: readonly ClaudeCommand[] }>({
    key: "",
    rows: [],
  });
  const family = canonicalAgent(agent?.toLowerCase().trim() ?? "");
  // A pane with no agent (a plain shell) has nothing to load; every agent pane asks, and the bridge
  // answers an empty list for one it has no loader for.
  const readsFound = family !== "";
  const hasOperatorRows = rowsFor(mine, agent, (row) => row.command).length > 0;
  const host = scope?.host ?? "";
  const session = scope?.session ?? "";
  const targetKey = `${host}\0${session}\0${paneId ?? ""}\0${family}`;

  // Asked on every open, because a skill installed a minute ago should be there; a failed read
  // (an older bridge, a crew member) clears any stale rows from an earlier open and keeps the catalog.
  useEffect(() => {
    if (!active || !readsFound || hasOperatorRows || paneId === undefined) return;
    const ac = new AbortController();
    const requestScope: Scope = {};
    if (host !== "") requestScope.host = host;
    if (session !== "") requestScope.session = session;
    const run = async () => {
      try {
        const rows = await fetchClaudeCommands(paneId, requestScope, ac.signal);
        if (!ac.signal.aborted) setState({ key: targetKey, rows });
      } catch {
        if (!ac.signal.aborted) setState({ key: targetKey, rows: [] });
      }
    };
    void run();
    return () => ac.abort();
  }, [active, readsFound, hasOperatorRows, paneId, host, session, targetKey]);

  return !hasOperatorRows && state.key === targetKey ? state.rows : [];
}

export function CommandPalette({
  open,
  onClose,
  agent,
  paneId,
  scope,
  mine,
  found: foundProp,
  onInsert,
  onSubmit,
}: CommandPaletteProps) {
  useLocale();
  const fetched = useClaudeCommands(open && foundProp === undefined, agent, paneId, scope, mine);
  const all = commandsFor(agent, mine, foundProp ?? fetched);
  const [query, setQuery] = useState("");
  const { pending, confirm, reset } = usePendingConfirm();

  // Reset transient state whenever the sheet (re)opens or switches pane.
  useEffect(() => {
    if (open) {
      setQuery("");
      reset();
    }
  }, [open, paneId, reset]);

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
    if (c.dangerous && !confirm(c.command)) return; // first tap arms the confirm
    reset();
    onSubmit(c.command);
    onClose();
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={t("commands.title")} className="max-h-[85dvh]">
      {agent && (
        <div className="mb-3 flex items-center gap-2">
          <AgentIcon agent={agent} className="size-6" />
          <span className="text-sm font-medium">{agent}</span>
        </div>
      )}
      <SearchField
        className="mb-3"
        value={query}
        onChange={setQuery}
        placeholder={t("commands.search.placeholder", { count: all.length })}
      />

      {!q && (
        <p className="mb-2 text-[11px] label-caps text-muted-foreground">
          {t("commands.common.hint", { count: all.length })}
        </p>
      )}

      <div className="flex flex-col gap-1">
        {list.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("commands.empty", { query })}
          </p>
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
                <span className="shrink-0 text-xs font-medium text-destructive">{t("commands.confirm")}</span>
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
