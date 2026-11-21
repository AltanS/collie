import { lazy, Suspense } from "react";
import { useLocation } from "react-router";

import { useNav } from "@/hooks/use-nav";
import { useWidthClass } from "@/hooks/use-width-class";
import { homePath, pathOnly, readNewAt } from "@/lib/nav";
import { overOf, setNewOverScreen } from "@/lib/new-over";
import { lazyChunk } from "@/lib/lazy-route";
import { useHoldReload } from "@/lib/reload-guard";

// NEW OVER THE SCREEN IT WAS CALLED FROM, ON A LARGE SCREEN (ADR 0173). Mounted once in the
// root layout. In the `expanded` width class (Large-screen layout not Off) the New page and "Add your own" are a
// centred dialog over the Dashboard or the pane view, in the look every sheet has as a dialog (`BottomSheet`,
// `size="form"`). The screen under it keeps its address with `over=<the New address>` added (lib/new-over.ts):
// Back, Escape and the close button step off it, and the focus goes back to the control that opened New. A
// start replaces the entry with the new pane. Compact, medium and Off draw nothing here: `/new` is the page.

// The New and Add screens are lazy chunks (ADR 0169, router.tsx). Drawn over another screen they load through the
// same chunks by `lazyChunk`, never a static import that would pull them back into the main chunk. While a chunk
// loads (the first seconds after a cold load, before the idle preload) the screen under it stays as it is.
const loadNew = lazyChunk(() => import("@/routes/new"));
const loadNewAdd = lazyChunk(() => import("@/routes/new-add"));
/** A chunk that resolves to nothing means a reload onto a new build has started: keep waiting for it. */
const reloading = () => new Promise<never>(() => undefined);
const NewPage = lazy(async () => {
  // Undefined when the reload onto a new build has started (lib/chunk-reload.ts).
  const module: typeof import("@/routes/new") | undefined = await loadNew();
  return module === undefined ? reloading() : { default: module.NewPage };
});
const NewAddPage = lazy(async () => {
  const module: typeof import("@/routes/new-add") | undefined = await loadNewAdd();
  return module === undefined ? reloading() : { default: module.NewAddPage };
});

export function NewOverHost() {
  const wide = useWidthClass() === "expanded";
  setNewOverScreen(wide);
  const location = useLocation();
  const over = wide ? overOf(`${location.pathname}${location.search}`) : undefined;
  if (over === undefined) return null;
  const path = pathOnly(over);
  return <NewOver add={path === "/new/add"} search={over.slice(path.length)} />;
}

function NewOver({ add, search }: { add: boolean; search: string }) {
  useHoldReload(add ? "new-add-page" : "new-page", true);
  const nav = useNav();
  const at = readNewAt(search);
  // Close: the screen under it, as it was. "Add your own" closes back to New, its own back.
  const close = () => nav.up(homePath({ host: at.machine, session: at.session }));
  return (
    <Suspense fallback={null}>
      {add ? <NewAddPage key={search} search={search} frame="dialog" /> : <NewPage key={search} search={search} frame="dialog" onClose={close} />}
    </Suspense>
  );
}
