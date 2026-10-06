import type { Handle } from "remix/component";

import { paneName } from "@web/lib/pane-name";
import { paneScopeKey } from "@web/lib/scope";

import { address, loadPane, paneStore, snapshot } from "../../lib/data";
import { focus, want } from "../../lib/polling";
import { useStore } from "../../lib/store";
import { href } from "../../routes";

// Placeholder pane screen: the pane's name and its raw mirror text in a <pre>. The real view (the
// ANSI screen, the composer, the dialogs) is the next task.
export function PaneRoute(handle: Handle<{ paneId: string }>) {
  const { scope } = address.get();
  const paneId = handle.props.paneId;
  const key = paneScopeKey(scope, paneId);
  const store = paneStore(key);
  want({ key: `pane:${key}`, poll: (signal) => loadPane(key, paneId, scope, signal) }, handle.signal);
  focus.set({ paneId, following: true });
  handle.signal.addEventListener("abort", () => {
    if (focus.get().paneId === paneId) focus.set({ paneId: null, following: true });
  });
  const readPane = useStore(handle, store);
  const readSnapshot = useStore(handle, snapshot);
  return () => {
    const pane = [...(readSnapshot().data?.agents ?? []), ...(readSnapshot().data?.shellPanes ?? [])].find(
      (p) => p.paneId === paneId,
    );
    const read = readPane();
    return (
      <main class="flex min-h-0 flex-1 flex-col" data-testid="pane-view">
        <header class="flex items-center gap-3 border-b border-rule px-4 py-2">
          <a href={href("/")} class="text-sm text-muted-foreground" data-testid="pane-back">
            ←
          </a>
          <h1 class="truncate text-sm font-semibold" data-testid="pane-title">
            {pane ? paneName(pane) : paneId}
          </h1>
        </header>
        <pre class="min-h-0 flex-1 overflow-auto bg-background p-2 font-mono text-[11px] leading-[1.35] whitespace-pre-wrap" data-testid="pane-text">
          {read.data?.text ?? read.error ?? ""}
        </pre>
      </main>
    );
  };
}
