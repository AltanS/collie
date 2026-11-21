import { BuildStamp } from "@/components/build-stamp";
import { InstallControl } from "@/components/install-control";
import { ReleaseLineCard } from "@/components/release-line-card";
import { ReportControl } from "@/components/report-control";
import { SettingSlot } from "@/components/setting-slot";
import { SettingsPage } from "@/components/settings-page";
import { TourControl } from "@/components/tour-control";
import { UpdateCard } from "@/components/update-card";
import { UpdateCheckControl } from "@/components/update-check-control";
import { useUpdatesStatus } from "@/components/updates-settings-card";
import { useLocale } from "@/hooks/use-locale";
import { Group } from "@/routes/settings-sections";

// ── THE UPDATES PAGE ────────────────────────────────────────────────────────────────────────────
//
// Every update surface, on one route. Settings used to end with three of them for one subject —
// the check control, the card, and a footer chip — on the screen an operator opens to change a
// theme. Updating is a flow now, with a lead, N peers, progress and a rollback state, so it gets a
// page and Settings keeps one row that links here.
//
// ── IN THIS ORDER ────────────────────────────────────────────────────────────
// The check control first: it is what makes the answer below it fresh, so it reads as the question
// and the card reads as the answer. The card second, and it carries EVERYTHING else — the versions,
// the preflight, the run progress, the peer lines, and the one action button. Peers are lines
// inside that card and never a table beside it, because the thing that blocks the confirm has to be
// readable without moving your eyes to a second surface. The release line third (M60 spec 01): a
// standing choice, read less often than the offer it decides. Then "This app" (install, its version, the
// first screen) and Help (the report), which came from System when Settings became eleven pages (ADR 0170).
//
// ── IT IS ON THE POLL LOOP, AND THAT IS THE POINT ────────────────────────────
// Same reason the crew census is: a run in progress and a peer going quiet are exactly what this
// page exists to show without the operator reloading. It has no loader of its own — the snapshot
// arrives on the root loader, and the card does its own read of the preflight, which is one route
// nobody else pays for.
//
// ── THE HEADER IS THE SHELL'S, FILLED ────────────────────────────────────────
// Through `SettingsPage`, the one shell of every Settings page (it was a copy of that shell's header until
// 2026-11-21), so this page carries the prerelease strip and the shell's padding, and on a large screen stands in
// the right column of Settings like every section. Back returns to Settings with the scope intact — this is a child
// of that page, not a sibling of home.
export function UpdatesRoute() {
  const updates = useUpdatesStatus();
  useLocale();
  return (
    <SettingsPage title="settings.page.updates.title" blurb={updates.line} backLabel="updates.nav.back">
      <Group page="updates" id="updates" bare>
        <SettingSlot ids={["updates.check"]}>
          <UpdateCheckControl />
        </SettingSlot>
        <SettingSlot ids={["updates.status", "updates.offer", "updates.install", "updates.crossMajor", "updates.remindLater", "updates.rollBack", "updates.retry", "updates.crew", "updates.notes"]}>
          <UpdateCard />
        </SettingSlot>
      </Group>
      <Group page="updates" id="line" bare>
        <SettingSlot ids={["updates.releaseLine", "updates.releaseLine.goBack", "updates.releaseLine.wait"]}>
          <ReleaseLineCard />
        </SettingSlot>
      </Group>
      <Group page="updates" id="app">
        {/* Renders nothing unless the browser offers to install. */}
        <SettingSlot ids={["updates.installApp"]}>
          <InstallControl />
        </SettingSlot>
        <SettingSlot ids={["updates.version"]}>
          <div className="px-1">
            <BuildStamp />
          </div>
        </SettingSlot>
        {/* The only way back to a tour that was interrupted: the tour is marked seen the moment it opens. */}
        <SettingSlot ids={["updates.firstScreen"]}>
          <TourControl />
        </SettingSlot>
      </Group>
      <Group page="updates" id="help">
        <SettingSlot ids={["updates.reportOffer", "updates.report"]}>
          <ReportControl />
        </SettingSlot>
      </Group>
    </SettingsPage>
  );
}
