// The Agent palette: the running harness's slash commands in a bottom sheet, with search. Port of
// web/src/components/command-palette.tsx.
//
// The first screen shows the `common` commands; typing searches the whole catalog (web's lib/
// agent-commands). The operator's own rows (`commands.toml`, from the config store) REPLACE the
// shipped catalog on a pane they address (ADR 0018); `commandsFor` applies that rule.
//
// THE PALETTE WRITES NOTHING ITSELF. A tap hands the command text to `onRun`, or, for a command that
// takes an argument, to `onInsert` so the caller can put "/cmd " in the draft for the operator to
// finish. The caller owns the send path (writeRefusal, bridgeWrite, noteSend), so one gate guards it.
//
// The search box is uncontrolled: the sheet unmounts its content on close, so a reopened palette
// starts with an empty box and `query` is reset on the opening render to match. A dangerous command
// (and an operator row marked `confirm`) arms on the first tap and runs on the second within 3 s.
import { on, type Handle } from "remix/component";
import { CornerDownLeft, Pencil, Search } from "lucide";

import { commandsFor, type AgentCommand } from "@web/lib/agent-commands";
import { t } from "@web/lib/i18n";
import { cn } from "@web/lib/utils";

import { config } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { createPendingConfirm, realTimers } from "../../lib/keys-tray";
import { scheduleUpdate, useStore } from "../../lib/store";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import { BottomSheet } from "../../ui/sheet";
import { AgentIcon } from "../home/agent-icon";

export interface AgentPaletteProps {
  open: boolean;
  onClose: () => void;
  /** The pane's agent. Undefined or "" has no catalog, unless an unscoped operator row applies. */
  agent: string | undefined;
  /** The pane takes no write: every row is greyed in place. */
  disabled: boolean;
  /** Types the command and submits it (a command that takes no argument). */
  onRun: (command: string) => void;
  /** A command that takes an argument: put "/cmd " in the draft for the operator to complete. When the
   *  caller passes none, such a row runs bare through `onRun` instead. */
  onInsert?: (text: string) => void;
}

/** The rows for a query: the whole catalog filtered across command and description, or the `common`
 *  ones while the box is empty. */
export function filterCommands(all: readonly AgentCommand[], query: string): readonly AgentCommand[] {
  const q = query.trim().toLowerCase();
  if (q === "") return all.filter((c) => c.common);
  return all.filter((c) => c.command.toLowerCase().includes(q) || c.description.toLowerCase().includes(q));
}

export function AgentPalette(handle: Handle<AgentPaletteProps>) {
  useLocale(handle);
  const cfg = useStore(handle, config);
  const confirm = createPendingConfirm(realTimers, () => scheduleUpdate(handle));
  handle.signal.addEventListener("abort", () => confirm.dispose(), { once: true });
  let query = "";
  let wasOpen = false;

  const pick = (c: AgentCommand): void => {
    const { onClose, onRun, onInsert } = handle.props;
    if (c.takesArg) {
      if (onInsert) onInsert(`${c.command} `);
      else onRun(c.command);
      onClose();
      return;
    }
    if (c.dangerous && !confirm.confirm(c.command)) return; // the first tap arms
    confirm.reset();
    onRun(c.command);
    onClose();
  };

  return () => {
    const { open, onClose, agent, disabled } = handle.props;
    if (open && !wasOpen) {
      query = "";
      confirm.reset();
    }
    wasOpen = open;
    const all = commandsFor(agent || undefined, cfg().data?.operatorCommands);
    const q = query.trim();
    const list = filterCommands(all, query);
    return (
      <BottomSheet open={open} onClose={onClose} title={t("commands.title")} class="max-h-[85dvh]">
        {agent ? (
          <div class="mb-3 flex items-center gap-2">
            <AgentIcon agent={agent} class="size-6" />
            <span class="text-sm font-medium">{agent}</span>
          </div>
        ) : null}
        <div class="relative mb-3">
          <Icon icon={Search} class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            inputMode="search"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
            data-testid="palette-search"
            placeholder={t("commands.search.placeholder", { count: all.length })}
            aria-label={t("commands.title")}
            // 16px text (`text-base`) so iOS does not zoom the page on focus.
            class="h-11 w-full rounded-md border border-input bg-transparent pl-9 pr-3 text-base placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            mix={on("input", (event) => {
              query = event.currentTarget.value;
              void handle.update();
            })}
          />
        </div>
        <Collapse open={q === ""}>
          <p class="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            {t("commands.common.hint", { count: all.length })}
          </p>
        </Collapse>
        <div class="flex flex-col gap-1">
          <Collapse open={list.length === 0}>
            <p class="py-8 text-center text-sm text-muted-foreground">{t("commands.empty", { query })}</p>
          </Collapse>
          {list.map((c) => {
            const pending = confirm.pending === c.command;
            return (
              <button
                key={c.command}
                type="button"
                disabled={disabled}
                data-testid={`palette-row-${c.command}`}
                mix={on("click", () => pick(c))}
                class={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors active:scale-[0.99] disabled:opacity-50",
                  pending ? "bg-destructive/10" : "hover:bg-accent",
                )}
              >
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5">
                    <span class={cn("font-mono text-sm font-semibold", c.dangerous ? "text-destructive" : "text-foreground")}>{c.command}</span>
                    {c.takesArg ? <span class="font-mono text-[11px] text-muted-foreground">{c.argHint}</span> : null}
                  </div>
                  <p class="truncate text-xs text-muted-foreground">{c.description}</p>
                </div>
                {pending ? (
                  <span class="shrink-0 text-xs font-medium text-destructive">{t("commands.confirm")}</span>
                ) : (
                  <Icon icon={c.takesArg ? Pencil : CornerDownLeft} class="size-4 shrink-0 text-muted-foreground" />
                )}
              </button>
            );
          })}
        </div>
      </BottomSheet>
    );
  };
}
