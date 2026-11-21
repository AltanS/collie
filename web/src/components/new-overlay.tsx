import { useEffect, useId, useRef } from "react";
import { useLocation } from "react-router";

import { OverlayTitleId } from "@/components/new-overlay-body";
import { MODAL_PANEL_LOOK, MODAL_SCRIM } from "@/components/ui/modal";
import { useAnySheetOpen, useDialogFocus } from "@/components/ui/sheet";
import { useNav } from "@/hooks/use-nav";
import { useWidthClass } from "@/hooks/use-width-class";
import { labNs, overOf, setOverlayLive, type LabNs } from "@/lib/lab-ns";
import { homePath, newPath, pathOnly, readNewAt } from "@/lib/nav";
import { useHoldReload } from "@/lib/reload-guard";
import { cn } from "@/lib/utils";
import { NewPage, type NewFrame } from "@/routes/new";
import { NewAddPage } from "@/routes/new-add";

// LAB (desktop pass 2, step 1): New over the screen it was called from, on a large screen with a proposal on
// (`?ns=1|2|3`, lib/lab-ns.ts). Mounted once in the root layout. The screen keeps its own address and gains
// `over=<the New address>`; Back pops it, Escape and the close button do the same.
//
//   1  a centred dialog, the form in two columns (what | where), the foot under both
//   2  a panel along the right edge, the full height, the form in today's one column and foot
//   3  a wide panel hung under the top edge, three columns (what | where | worktree and the foot)

const NEW_FRAME = { 1: "two", 2: "panel", 3: "three" } as const satisfies Record<Exclude<LabNs, 0>, NewFrame>;

export function NewOverlayHost() {
  const wide = useWidthClass() === "expanded";
  const ns = labNs();
  const on = wide && ns !== 0;
  setOverlayLive(on);
  const location = useLocation();
  const over = on ? overOf(`${location.pathname}${location.search}`) : undefined;
  if (over === undefined || ns === 0) return null;
  const path = pathOnly(over);
  return <OverlayFrame ns={ns} add={path === "/new/add"} search={over.slice(path.length)} />;
}

function OverlayFrame({ ns, add, search }: { ns: Exclude<LabNs, 0>; add: boolean; search: string }) {
  useHoldReload("new-page", true);
  const nav = useNav();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocus(true, panelRef);
  const at = readNewAt(search);
  // Close: the screen under it, as it was. From Add, Escape is Add's own back, to New.
  const close = () => nav.up(homePath({ host: at.machine, session: at.session }));
  const escape = add ? () => nav.up(newPath({ machine: at.machine, pane: at.pane, beside: at.beside, session: at.session })) : close;
  const escapeRef = useRef(escape);
  escapeRef.current = escape;
  // A sheet opened from the form (Start without prompts?) answers its own Escape.
  const sheetOpen = useAnySheetOpen();
  const sheetOpenRef = useRef(sheetOpen);
  sheetOpenRef.current = sheetOpen;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || sheetOpenRef.current || e.defaultPrevented) return;
      escapeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const armed = useRef(false);

  const body = add ? <NewAddPage key={search} search={search} frame="overlay" onClose={close} /> : <NewPage key={search} search={search} frame={NEW_FRAME[ns]} onClose={close} />;

  const frameClass =
    ns === 1
      ? "fixed inset-x-0 top-0 z-50 flex h-(--app-h) flex-col items-center justify-center px-3"
      : ns === 2
        ? "fixed inset-x-0 top-0 z-50 flex h-(--app-h) flex-col items-end"
        : "fixed inset-x-0 top-0 z-50 flex h-(--app-h) flex-col items-center px-3 pt-14";
  const panelClass =
    ns === 1
      ? cn(MODAL_PANEL_LOOK, "relative z-10 flex flex-col overflow-hidden duration-150 animate-in fade-in zoom-in-95", add ? "w-[min(640px,calc(100vw-4rem))]" : "w-[min(1040px,calc(100vw-4rem))]", "h-[min(720px,calc(var(--app-h)-4rem))]")
      : ns === 2
        ? "relative z-10 flex h-full w-[min(560px,100vw)] flex-col overflow-hidden border-l border-rule bg-card shadow-2xl duration-200 animate-in slide-in-from-right"
        : cn(MODAL_PANEL_LOOK, "relative z-10 flex flex-col overflow-hidden duration-150 animate-in fade-in slide-in-from-top-2", add ? "w-[min(720px,calc(100vw-4rem))]" : "w-[min(1320px,calc(100vw-4rem))]", "h-[min(620px,calc(var(--app-h)-6rem))]");

  return (
    <div data-slot="new-overlay" data-ns={ns} role="dialog" aria-modal="true" aria-labelledby={titleId} className={frameClass}>
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className={cn(MODAL_SCRIM, "motion-reduce:animate-none")}
        onPointerDown={() => {
          armed.current = true;
        }}
        onClick={() => {
          if (!armed.current) return;
          armed.current = false;
          close();
        }}
      />
      <div ref={panelRef} tabIndex={-1} data-slot="new-overlay-panel" className={cn(panelClass, "outline-none")}>
        <OverlayTitleId.Provider value={titleId}>{body}</OverlayTitleId.Provider>
      </div>
    </div>
  );
}
