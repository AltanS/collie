// The boot splash (web/src/routes/root.tsx `BootSplash`): the animated 64 px Collie mark and
// "Connecting to the herd..." while the first snapshot is out, and, past 15 s with no answer, an
// honest "Not connected" with a Retry: the mark stills and dims, because a blooming mark would say
// we are still trying. `index.html` paints the same layout statically before any bundle, so the
// hand-off changes only the mark's motion.
//
//   BootSplash    the picture. Used as the runtime's `fallback` before the router resolves, and, with
//                 `cover`, as the first-connect cover over the Shell.
//   FirstConnect  a leaf in the Shell. Until the snapshot has answered once, it covers the screen, so
//                 no dashboard verdict ("Disconnected", "No spaces yet.") is ever drawn before the
//                 bridge has said anything. An HTTP answer, even an error, ends it (a 401 or a 503 is
//                 an answer, and the strip says what it means); a network failure does not, because
//                 nothing has answered yet. Once it has ended it never comes back.
//
// The 15 s lost state is the shared connection clock's (`shell/connection-state.ts`), the same one
// the mark and the strip use. Retry is a document reload (`reloadDocument`, never `location.reload()`,
// REMIX3.md rule 9).
import { on, type Handle } from "remix/component";

import { t } from "@web/lib/i18n";
import { cn } from "@web/lib/utils";

import { snapshot, type Loaded } from "../lib/data";
import { useLocale } from "../lib/i18n-store";
import { scheduleUpdate, useStore } from "../lib/store";
import { reloadDocument } from "../update/pwa";
import { CollieMark } from "./collie-mark";
import { connection } from "./connection-state";

/** Has the bridge answered at all? A body, or an HTTP status, ends the first connect. */
export function hasAnswered(loaded: Loaded<unknown>): boolean {
  return loaded.data !== undefined || loaded.status !== undefined;
}

export function BootSplash(handle: Handle<{ cover?: boolean }>) {
  useLocale(handle);
  let lost = connection.state.lost;
  handle.queueTask(() => {
    connection.subscribe(() => {
      if (connection.state.lost === lost) return;
      lost = connection.state.lost;
      scheduleUpdate(handle);
    }, handle.signal);
    // The reading may have crossed while this was mounting.
    if (connection.state.lost !== lost) {
      lost = connection.state.lost;
      scheduleUpdate(handle);
    }
  });
  return () => (
    <div
      role="status"
      aria-label={t("error.boot.connecting")}
      data-slot="boot-splash"
      data-state={lost ? "lost" : "connecting"}
      class={cn(
        "fixed inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center text-sm text-muted-foreground",
        handle.props.cover && "z-40",
      )}
    >
      {/* The bloom: the same mark as the rest, turning and at full chroma. It is a colour as well as
          motion, which is the half a reduced-motion reader still gets. `paper` is this screen's
          ground, the knockout colour that puts a near bead in front of the head. */}
      <CollieMark size={64} loading={!lost} lost={lost} paper="var(--background)" />
      {lost ? (
        <>
          <p class="font-medium text-foreground">{t("error.boot.title")}</p>
          <p class="max-w-xs">{t("error.boot.body")}</p>
          <button type="button" class="text-sm underline underline-offset-4" data-testid="boot-retry" mix={on("click", () => reloadDocument())}>
            {t("error.boot.retry")}
          </button>
        </>
      ) : (
        <span>{t("error.boot.connecting")}</span>
      )}
    </div>
  );
}

export function FirstConnect(handle: Handle) {
  const readSnapshot = useStore(handle, snapshot);
  let done = false;
  return () => {
    if (!done) done = hasAnswered(readSnapshot());
    return done ? null : <BootSplash cover />;
  };
}
