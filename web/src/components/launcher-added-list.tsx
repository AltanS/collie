import { Lock } from "lucide-react";
import { useState } from "react";

import { AgentIcon } from "@/components/agent-icon";
import { NoPromptsBadge } from "@/components/no-prompts-badge";
import { Button } from "@/components/ui/button";
import { OneOf } from "@/components/ui/one-of";
import { SectionLabel } from "@/components/ui/section-label";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { describeApiError } from "@/lib/api-error-message";
import { removeAddedLauncher, renameAddedLauncher } from "@/lib/api";
import { t } from "@/lib/i18n";
import { mutate } from "@/lib/mutate";
import type { Scope } from "@/lib/scope";
import { setStatus } from "@/lib/status";
import type { LauncherItem } from "@/lib/types";

/** The rows to list: every one a phone added, then the operator's own rows (locked). */
export function listedRows(items: readonly LauncherItem[] | null) {
  const rows = (items ?? []).filter((i) => i.command !== undefined);
  return {
    added: rows.filter((i) => i.source === "added"),
    operator: rows.filter((i) => i.source === "operator"),
  };
}

const LINK =
  "inline-flex min-h-11 items-center px-2 text-xs underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";

/**
 * "Added on this machine" (ADR 0094): every row a phone added there, each with Rename and Remove, and
 * below them the operator's own rows from `launchers.toml`, with a lock and no actions (a phone
 * never edits that file). Rename swaps the label for a field in the SAME box (a `OneOf`), so the row
 * does not change height; Remove asks first, in a sheet. Both are the silent kind of write
 * (lib/ack-manifest.ts): a refusal is said on the status line, and the list is read again either way.
 */
export function LauncherAddedList({
  items,
  scope,
  machine,
  onChanged,
}: {
  items: readonly LauncherItem[] | null;
  scope: Scope;
  /** ALREADY TRANSLATED. The machine's name, or "this machine". */
  machine: string;
  /** Read the list again: a row was renamed or removed. */
  onChanged: () => void;
}) {
  useLocale();
  const { added, operator } = listedRows(items);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [removing, setRemoving] = useState<LauncherItem | null>(null);
  const [busy, setBusy] = useState(false);

  async function saveName() {
    if (renaming === null || busy) return;
    const label = renaming.text.trim();
    if (label === "") return;
    setBusy(true);
    const out = await mutate(() => renameAddedLauncher(renaming.id, label, scope));
    setBusy(false);
    if (out.ok && !out.value.ok) setStatus(describeApiError(out.value), "error");
    if (out.ok && out.value.ok) setRenaming(null);
    onChanged();
  }

  async function confirmRemove() {
    const id = removing?.id;
    if (id === undefined || busy) return;
    setBusy(true);
    const out = await mutate(() => removeAddedLauncher(id, scope));
    setBusy(false);
    setRemoving(null);
    if (out.ok) onChanged();
  }

  return (
    <section aria-labelledby="launcher-added-title" className="flex flex-col gap-2">
      <SectionLabel placement="above" id="launcher-added-title">
        {t("launcherAdd.manage.title", { machine })}
      </SectionLabel>
      {added.length === 0 && operator.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("launcherAdd.manage.empty")}</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {added.map((row) => {
          const editing = renaming !== null && renaming.id === row.id;
          return (
            <li key={row.key} data-testid="launcher-added-row" className="flex flex-col rounded-md border border-border px-3 py-2">
              <OneOf
                active={editing ? "edit" : "view"}
                className="justify-items-stretch"
                options={[
                  {
                    key: "view",
                    node: <RowText row={row} by />,
                  },
                  {
                    key: "edit",
                    node: editing ? (
                      <div className="flex items-center">
                        <input
                          value={renaming.text}
                          maxLength={60}
                          aria-label={t("launcherAdd.manage.renameAria", { label: row.label })}
                          onChange={(e) => setRenaming({ id: renaming.id, text: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void saveName();
                          }}
                          className="h-11 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        />
                      </div>
                    ) : null,
                  },
                ]}
              />
              <div className="flex items-center justify-end">
                {editing ? (
                  <>
                    <button type="button" className={LINK} onClick={() => setRenaming(null)}>
                      {t("dialog.cancel")}
                    </button>
                    <button
                      type="button"
                      className={LINK}
                      disabled={busy || renaming.text.trim() === ""}
                      onClick={() => void saveName()}
                    >
                      {t("launcherAdd.manage.save")}
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className={LINK} onClick={() => setRenaming({ id: row.id ?? "", text: row.label })}>
                      {t("launcherAdd.manage.rename")}
                    </button>
                    <button type="button" className={LINK} onClick={() => setRemoving(row)}>
                      {t("launcherAdd.manage.remove")}
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
        {operator.map((row) => (
          <li key={row.key} data-testid="launcher-operator-row" className="flex items-start gap-2 rounded-md border border-border px-3 py-2">
            <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <RowText row={row} />
              <p className="text-[11px] leading-tight text-muted-foreground">{t("launcherAdd.manage.operator")}</p>
            </div>
          </li>
        ))}
      </ul>

      <BottomSheet
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={t("launcherAdd.remove.title", { label: removing?.label ?? "" })}
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm">{t("launcherAdd.remove.body")}</p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="h-11 flex-1" onClick={() => setRemoving(null)}>
              {t("dialog.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-11 flex-1"
              disabled={busy}
              onClick={() => void confirmRemove()}
            >
              {t("launcherAdd.manage.remove")}
            </Button>
          </div>
        </div>
      </BottomSheet>
    </section>
  );
}

/** A row's label, line, who added it, and the badge: the same four things wherever it is listed. */
function RowText({ row, by = false }: { row: LauncherItem; by?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-2">
        {row.harness !== undefined ? <AgentIcon agent={row.harness} className="size-4 shrink-0 rounded-sm" /> : null}
        <span className="min-w-0 truncate text-sm font-medium">{row.label}</span>
        {row.noPrompts ? <NoPromptsBadge className="shrink-0" /> : null}
      </div>
      <span className="break-all font-mono text-[11px] leading-snug text-muted-foreground">{row.command}</span>
      {by && row.addedBy !== undefined ? (
        <span className="text-[11px] leading-tight text-muted-foreground">{t("launcherAdd.manage.by", { device: row.addedBy })}</span>
      ) : null}
    </div>
  );
}
