import { useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ListGroup } from "@/components/ui/list-group";
import { Modal } from "@/components/ui/modal";
import { SectionLabel } from "@/components/ui/section-label";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { mintRequestId } from "@/lib/worktree-name";

// THE "REMOVE" SECTION of a trick's details page (ADR 0168), its last, after "Read the code": one row with a short
// line and a destructive button, in the page's box look. The one place in the app that removes a trick: not the
// trick's own page, not a row of the list.
//
//   * OFF: "Delete this trick from this machine." and "Remove trick", which opens the confirm: a decision that blocks
//     until it is answered, so the app's modal over a scrim (ui/modal.tsx, ADR 0167), not a sheet. The focus starts
//     on Cancel, so an Enter carried over from the button never confirms; Escape and the scrim close it, except
//     while the write flies. "Remove trick" in the confirm calls the write once.
//   * ON: the button is disabled and the line says to switch the trick off first. The bridge refuses a trick that
//     is on anyway; this only says so before the tap.
//   * A refusal or an error stays on the page and says the reason in the row. Success is the route's: it leaves for
//     the list and says "Removed <name>." there.
//   * ONE REQUEST ID PER ASK (ADR 0168). The id is minted when the confirm opens and sent with its Remove trick. A
//     definite answer (a refusal) ends it: the bridge keeps that answer under the id for good, so the next opening
//     mints a new one. A lost answer (no answer, or the bridge's own failure) keeps it, so the next confirm sends the
//     same id and the bridge answers what it did, never "there is no such trick" after a remove that went through.

/** A remove that did not go through: the words for the row, and whether its answer was lost. */
export interface RemoveProblem {
  line: string;
  /** No answer came (or the bridge failed): the same request id goes with the next confirm. */
  lost: boolean;
}

export interface TrickRemoveSectionProps {
  name: string;
  on: boolean;
  canWrite: boolean;
  /** The write, with the ask's request id: null when the trick was removed, else what to show in the row. */
  onRemove: (rid: string) => Promise<RemoveProblem | null>;
}

export function TrickRemoveSection({ name, on, canWrite, onRemove }: TrickRemoveSectionProps) {
  useLocale();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  // One write per confirm, also when a second tap lands before the first answer.
  const flying = useRef(false);
  // The request id of this ask: kept across a lost answer, dropped after a definite one.
  const rid = useRef<string | null>(null);

  async function confirm(): Promise<void> {
    if (flying.current) return;
    flying.current = true;
    setBusy(true);
    try {
      rid.current ??= mintRequestId();
      const why = await onRemove(rid.current);
      if (why === null || !why.lost) rid.current = null;
      setAsking(false);
      setProblem(why?.line ?? null);
    } finally {
      flying.current = false;
      setBusy(false);
    }
  }

  const line = problem ?? (on ? t("settings.tricks.remove.onLine") : t("settings.tricks.remove.line"));
  return (
    <section data-section="remove" className="pt-6">
      <SectionLabel className="mb-2 block">{t("settings.tricks.remove.label")}</SectionLabel>
      <ListGroup>
        <div data-slot="trick-remove" className="flex min-h-11 items-center justify-between gap-4 px-3.5 py-2">
          <p data-line="remove" data-problem={problem === null ? undefined : true} role={problem === null ? undefined : "alert"} className="min-w-0 flex-1 text-sm break-words text-muted-foreground">
            {line}
          </p>
          <Button
            type="button"
            variant="destructive"
            data-slot="trick-remove-open"
            className="h-11 shrink-0"
            disabled={on || !canWrite || busy}
            onClick={() => {
              setProblem(null);
              rid.current ??= mintRequestId();
              setAsking(true);
            }}
          >
            {t("settings.tricks.remove.button")}
          </Button>
        </div>
      </ListGroup>
      {asking ? (
        <Modal placement="center" onClose={() => !busy && setAsking(false)} labelledBy={titleId} initialFocus={cancel} slot="trick-remove-modal" className="w-[min(100vw_-_1.5rem,26rem)]">
          <div data-slot="trick-remove-confirm" className="flex flex-col gap-3 p-4">
            <h2 id={titleId} className="text-sm font-semibold">
              {t("settings.tricks.remove.title", { name })}
            </h2>
            <p className="text-sm">{t("settings.tricks.remove.body")}</p>
            <div className="flex gap-2">
              <Button ref={cancel} type="button" variant="outline" data-slot="trick-remove-cancel" className="h-11 flex-1" disabled={busy} onClick={() => setAsking(false)}>
                {t("dialog.cancel")}
              </Button>
              <Button type="button" variant="destructive" data-slot="trick-remove-confirm-button" className="h-11 flex-1" disabled={busy} aria-busy={busy || undefined} onClick={() => void confirm()}>
                {t("settings.tricks.remove.button")}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
