import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router";

import { RouteHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { UpdateCard } from "@/components/update-card";
import { UpdateCheckControl } from "@/components/update-check-control";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { settingsPath } from "@/lib/nav";
import { useScope } from "@/lib/session";

// ── THE UPDATES PAGE ────────────────────────────────────────────────────────────────────────────
//
// Every update surface, on one route. Settings used to end with three of them for one subject —
// the check control, the card, and a footer chip — on the screen an operator opens to change a
// theme. Updating is a flow now, with a lead, N peers, progress and a rollback state, so it gets a
// page and Settings keeps one row that links here.
//
// ── TWO THINGS, IN THIS ORDER ────────────────────────────────────────────────
// The check control first: it is what makes the answer below it fresh, so it reads as the question
// and the card reads as the answer. The card second, and it carries EVERYTHING else — the versions,
// the preflight, the run progress, the peer lines, and the one action button. Peers are lines
// inside that card and never a table beside it, because the thing that blocks the confirm has to be
// readable without moving your eyes to a second surface.
//
// ── IT IS ON THE POLL LOOP, AND THAT IS THE POINT ────────────────────────────
// Same reason the pack census is: a run in progress and a peer going quiet are exactly what this
// page exists to show without the operator reloading. It has no loader of its own — the snapshot
// arrives on the root loader, and the card does its own read of the preflight, which is one route
// nobody else pays for.
//
// ── THE HEADER IS THE SHELL'S, FILLED ────────────────────────────────────────
// `RouteHeader` with an `override`, exactly as Settings and Pack do it, so this page carries the
// prerelease strip and the shell's padding rather than a copy of them. Back returns to Settings
// with the scope intact — this is a child of that page, not a sibling of home.
export function UpdatesRoute() {
  const navigate = useNavigate();
  const scope = useScope();
  useLocale();

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <RouteHeader
        width="column"
        override={
          <>
            <Button
              variant="ghost"
              size="icon"
              // 44px — the tap floor every control in this row shares. size="icon" alone is 36px.
              className="size-11"
              onClick={() => navigate(settingsPath(scope))}
              aria-label={t("updates.nav.back")}
            >
              <ArrowLeft className="size-5" />
            </Button>
            <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{t("updates.title")}</h1>
          </>
        }
      />

      {/* `relative` for the reason every scroller in this app carries it: an `sr-only` (position:
          absolute) deep in the page would otherwise escape the scroller and grow the document's own
          scrollbar. */}
      <main className="relative flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-4">
        <UpdateCheckControl />
        <UpdateCard />
      </main>
    </div>
  );
}
