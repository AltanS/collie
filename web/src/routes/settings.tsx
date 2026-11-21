import { Navigate, useLocation } from "react-router";

import { Icon } from "@/components/icons/icon";

import { RouteHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { BuildStamp } from "@/components/build-stamp";
import { Card } from "@/components/ui/card";
import { SettingsNavRow } from "@/components/settings-nav-row";
import { InstallControl } from "@/components/install-control";
import { useUpdatesStatus } from "@/components/updates-settings-card";
import { SettingsSearch } from "@/components/settings-search";
import { STEADY_PAGES, useSettingsRows } from "@/hooks/use-settings-rows";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { t } from "@/lib/i18n";
import { homePath, updatesPath } from "@/lib/nav";
import { useScope } from "@/lib/session";
import { oldIndexTarget } from "@/routes/settings-redirect";
import { BandMain } from "@/components/ui/strip-host";

// ── THE SETTINGS INDEX ──────────────────────────────────────────────────────────────────────────
//
// The search, then Updates and about, then the registry's pages in their order (lib/settings/pages.ts, ADR 0170), each
// row with its line of what the page holds.
//
// This page used to BE the settings: seventeen cards in one column, over a thousand pixels of
// scroll on a phone, with no headings to skim by — the file argued for that, on the grounds that
// the first heading would imply four more. It implied four more. The cost was that finding one
// switch meant reading every card on the way to it, and the page grew every time anything shipped.
//
// The index does not remove a setting or move one between devices. It changes how many you are
// asked to read at once, and that is the whole of it.
//
// ── WHAT STAYS ON THIS PAGE, AND WHY ─────────────────────────────────────────
// `InstallControl` is not a setting: it is a one-shot offer the browser makes and then stops
// making, and it renders NOTHING unless that offer is actually on the table (lib/install.ts). On a
// phone that can install, it must not be filed under a heading nobody opens.
//
// `BuildStamp` stays because it is the answer to "what am I running", which is the question you ask
// before you go looking for anything else. It costs one line and it is also on the System page,
// where it sits with the rest of the diagnostics.

// The rows, their order and the reasons for it live in hooks/use-settings-rows.ts, which the large screen's section
// list (components/settings-shell.tsx) reads too.
export { LIST_HOLD_MS } from "@/hooks/use-settings-rows";

/**
 * The quiet stand-in for the list card, on a first visit with no remembered answer, until the two
 * read has landed or {@link LIST_HOLD_MS} has passed. It is the card's own box with the rows that
 * are always there, empty and of their exact height (the Updates row, `ROWS` and Tricks while it is on: 16px padding twice
 * around the 24px title line and the 20px caption line, so `box-content h-11 p-4`), inside the same
 * list group, so a theme's row edges and gaps come out as they will. No spinner and no words: a state
 * with nothing to say keeps its slot (DESIGN.md §2). The row that may be added (Accounts)
 * are not counted, so the card grows by it if it arrives late, which is the rare, accepted case.
 */
function ListHold() {
  return (
    <Card className="gap-0 py-0" data-slot="settings-list-hold" aria-hidden="true">
      <div data-slot="list-group">
        {/* A page line may wrap to a second line; the stand-in keeps one, and the list grows by the difference once. */}
        {["updates", ...STEADY_PAGES.map((page) => page.id)].map((id) => (
          <div key={id} className="box-content h-11 p-4" />
        ))}
      </div>
    </Card>
  );
}

export function SettingsRoute() {
  const nav = useNav();
  const scope = useScope();
  const updates = useUpdatesStatus();
  const { rows, hold: holdList } = useSettingsRows();
  const { search, hash, state } = useLocation();
  useLocale();

  // An old fragment on the index (`/settings#paired-devices`, `#changes`) opens the page that holds its row now.
  const old = oldIndexTarget(search, hash);
  if (old !== null) return <Navigate to={old} replace state={state} />;

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      {/* One header treatment app-wide, and it is a FACT rather than a claim: this route does not
          mount a header at all, it fills the one that is already there (RootLayout's
          <AppHeaderHost/>). The back button is `size-11` sitting at the row's `pl-4`, so its icon
          centre lands on the same 38px as the Collie mark it stands in for. */}
      <RouteHeader
        width="column"
        override={
          <>
            <Button
              variant="ghost"
              size="icon"
              // 44px — the tap floor every control in this row shares. size="icon" alone is 36px.
              className="size-11"
              onClick={() => nav.up(homePath(scope))}
              aria-label={t("settings.nav.back")}
            >
              <Icon name="back" className="size-5" />
            </Button>
            <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{t("settings.title")}</h1>
          </>
        }
      />

      <BandMain base={16} className="relative flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-4">
        {/* ONE card holding the rows, not one card per row. They are a single list of siblings, and
            separated cards would say they are unrelated subjects. The rows are a list group (M57 spec
            17): index.css draws the line between two rows, so the last has none, and a theme's
            `rows: cards` makes them cards inside this one card, like every other list. */}
        <SettingsSearch>
        <>
        <InstallControl />
        {holdList ? (
          <ListHold />
        ) : (
          <Card className="gap-0 py-0">
            <div data-slot="list-group">
              {/* FIRST, because it is the one row whose answer changes without you touching anything: a
                  release lands, a peer falls behind. The caption is the live status (the same words the
                  Updates page opens with); a release waiting leads it with a 6px dot in the primary
                  colour. The row is not in `ROWS`, whose captions are fixed strings. */}
              <SettingsNavRow
                icon="update-available"
                title={t("settings.page.updates.title")}
                caption={
                  <>
                    {updates.available && (
                      <span
                        aria-hidden="true"
                        data-slot="update-dot"
                        className="mr-1.5 inline-block size-1.5 rounded-full bg-primary align-middle"
                      />
                    )}
                    {updates.line}
                  </>
                }
                onOpen={() => nav.down(updatesPath(scope))}
              />
              {rows.map((row) => (
                <SettingsNavRow key={row.id} icon={row.icon} title={row.title} caption={row.caption} wrap onOpen={() => nav.down(row.to)} />
              ))}
            </div>
          </Card>
        )}
        </>
        </SettingsSearch>

        {/* Pinned to the bottom with `mt-auto`, exactly where it was before the split. */}
        <div className="mt-auto flex flex-col gap-2 pt-4">
          <BuildStamp />
        </div>
      </BandMain>
    </div>
  );
}
