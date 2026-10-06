// The app shell: wraps every route's content (router.tsx installs it through `render()`), keeps the
// snapshot and config on the polling beat for the page's lifetime, and draws the idle lock.
//
// THE COVER SITS OVER A MOUNTED TREE (ADR 0007). The route content stays mounted under the lock, in
// an `inert` wrapper with `display: contents`, so a draft, a scroll position or an open sheet survive
// a pause. Polling is what stops (lib/polling.ts reads the lock), and releasing it refetches and
// holds the cover through that one refetch.
import { on, type Handle, type RemixNode } from "remix/component";

import { t } from "@web/lib/i18n";

import { config, loadConfig, loadSnapshot, snapshot } from "./lib/data";
import { idle, unlock } from "./lib/idle";
import { want } from "./lib/polling";
import { useStore } from "./lib/store";
import { Button } from "./ui/button";

export const SNAPSHOT_SOURCE = { key: "snapshot", poll: loadSnapshot };
export const CONFIG_SOURCE = { key: "config", poll: loadConfig };

export interface ShellProps {
  url: URL;
  children?: RemixNode;
}

export function Shell(handle: Handle<ShellProps>) {
  want(SNAPSHOT_SOURCE, handle.signal);
  want(CONFIG_SOURCE, handle.signal);
  const readIdle = useStore(handle, idle);
  // Read here only so the shell re-renders when they land; routes read them themselves.
  useStore(handle, snapshot);
  useStore(handle, config);
  return () => {
    const { locked, catchingUp } = readIdle();
    const covered = locked || catchingUp;
    return (
      <>
        <div style={{ display: "contents" }} inert={covered} data-slot="app">
          <div class="flex h-(--app-h) flex-col overflow-hidden">{handle.props.children}</div>
        </div>
        {covered && <IdleCover catchingUp={catchingUp} />}
      </>
    );
  };
}

function IdleCover(handle: Handle<{ catchingUp: boolean }>) {
  return () => {
    const { catchingUp } = handle.props;
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("idle.dialogAria")}
        data-testid="idle-lock"
        class="fixed inset-0 z-50 flex items-center justify-center bg-background/40 px-6 backdrop-blur-[3px]"
      >
        <div class="flex flex-col items-center gap-6 rounded-lg border border-border/60 bg-card/70 px-8 py-10 text-center shadow-2xl ring-1 ring-white/10 backdrop-blur-2xl">
          <div class="flex flex-col items-center gap-3">
            {/* The splash's static mark (index.html's `.boot-splash__mark`): the animated CollieMark
                is a React component and is not ported yet. */}
            <span class="grid size-20 shrink-0 place-items-center">
              <span class="boot-splash__mark" aria-hidden="true" />
            </span>
            <span class="text-lg font-semibold tracking-tight">Collie</span>
          </div>
          {catchingUp ? (
            <div class="space-y-1">
              <p class="font-medium">{t("idle.catchingUp.title")}</p>
              <p class="max-w-xs text-sm text-muted-foreground">{t("idle.catchingUp.body")}</p>
            </div>
          ) : (
            <div class="space-y-1">
              <p class="font-medium">{t("idle.paused.title")}</p>
              <p class="max-w-xs text-sm text-muted-foreground">{t("idle.paused.body")}</p>
            </div>
          )}
          {!catchingUp && (
            <Button size="lg" mix={on("click", unlock)}>
              {t("idle.resume")}
            </Button>
          )}
        </div>
      </div>
    );
  };
}

/** The first paint while the first route resolves: the same mark and caption as index.html's splash. */
export function BootSplash() {
  return () => (
    <div class="boot-splash" role="status" aria-label="Loading Collie">
      <span class="boot-splash__mark" aria-hidden="true" />
      <span>{t("error.boot.connecting")}</span>
    </div>
  );
}

export function NotFound(handle: Handle<{ url: URL }>) {
  return () => <p class="p-4 text-sm text-muted-foreground">{handle.props.url.pathname}</p>;
}
