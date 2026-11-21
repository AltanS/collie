import { useLocation } from "react-router";

import { useNav } from "@/hooks/use-nav";
import { useWidthClass } from "@/hooks/use-width-class";
import { homePath, pathOnly, readNewAt } from "@/lib/nav";
import { overOf, setNewOverScreen } from "@/lib/new-over";
import { useHoldReload } from "@/lib/reload-guard";
import { NewPage } from "@/routes/new";
import { NewAddPage } from "@/routes/new-add";

// NEW OVER THE SCREEN IT WAS CALLED FROM, ON A LARGE SCREEN (ADR 0158, addendum 2026-11-21). Mounted once in the
// root layout. In the `expanded` width class (Large-screen layout not Off) the New page and "Add your own" are a
// centred dialog over the Dashboard or the pane view, in the look every sheet has as a dialog (`BottomSheet`,
// `size="form"`). The screen under it keeps its address with `over=<the New address>` added (lib/new-over.ts):
// Back, Escape and the close button step off it, and the focus goes back to the control that opened New. A
// start replaces the entry with the new pane. Compact, medium and Off draw nothing here: `/new` is the page.

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
  return add ? <NewAddPage key={search} search={search} frame="dialog" /> : <NewPage key={search} search={search} frame="dialog" onClose={close} />;
}
