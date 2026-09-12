// Settings section of the states playground. Split out of app.tsx; see that file's header comment
// for the whole page's rules.

import { CrewProvider } from "@/components/crew-provider";
import { NotifyPrefsCard } from "@/components/notify-prefs-control";
import { NewSpaceSheet } from "@/components/new-space-sheet";
import { SpaceOverview } from "@/components/space-overview";
import {
  devicesPaired,
  devicesUnpaired,
  homeCrew,
  homeSolo,
  rosterFive,
  spacesWithWorktrees,
  watchedPanes,
} from "../fixtures";
import { Card, Group, Section, SettingsRouter, Stage, type SectionDef } from "../harness";
import { PhoneFrameCard } from "./shared";

export const DEF: SectionDef = {
  id: "settings",
  title: "Settings",
  intent:
    "The whole settings route, mounted twice: once on a solo collie with nothing paired, once on a lead with three paired devices and a crew card to show for it. Then the Updates page it links to, which is where the check, the card, the peers and the one button now live.",
};

export function SettingsSection() {
  return (
    <Section def={DEF}>
      <Group title="Settings">
        <Card
          state="settings-solo-unpaired"
          label="settings, solo collie, nothing paired"
          reach="tap the gear from the dashboard. With no device paired, writes are ungated and the Paired devices card offers the pairing verb instead of a list."
          note="The whole real route. Two things on it still reach the network on purpose — /api/config for the diagnostics build, and the browser's own push subscription — and both fail soft, so the page renders whole with no bridge."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <SettingsRouter home={homeSolo} devices={devicesUnpaired} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="settings-lead-paired"
          label="settings, lead of a crew, three devices paired"
          reach="pair a phone with `collie pair`, then open Settings on the lead. The Crew card appears only on a multi-machine roster; the device list names which row is the phone you are holding."
          note="One Updates row, where three update cards used to stand. Its status line follows the footer chip's old precedence and its chevron says it opens a page."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <SettingsRouter home={homeCrew} devices={devicesPaired} />
          </PhoneFrameCard>
        </Card>
      </Group>

      <Group title="Notify when">
        <Card
          state="settings-notify-cache-row"
          label="notify card, the fourth switch and the panes watched one by one"
          reach="scroll to Notify when in Settings. The fourth row is the cache warning, off by default,
            and the section under it names the panes switched on one at a time from their own sheets —
            which is what makes the global-OR-per-pane rule visible instead of implicit."
          note="The real card with a fixture: the playground answers no API, so the controller's two
            fetches are replaced by handed-in values rather than stubbed."
        >
          <Stage height={420}>
            <div className="p-4">
              <NotifyPrefsCard
                prefs={{ blocked: true, done: false, updates: true, cache: false }}
                busy={false}
                onToggle={() => {}}
                entries={watchedPanes}
                entriesBusy={false}
                onForget={() => {}}
              />
            </div>
          </Stage>
        </Card>
      </Group>

      <Group title="Updates">
        <Card
          state="updates-page"
          label="updates, the page the Settings row opens"
          reach="tap the Updates row in Settings. The check control on top, then one card carrying the version, the preflight, the run progress, a read-only line per peer, and the single action button."
          note="No bridge here, so the card's own read of /api/update/check never lands: the versions come from the snapshot and the peer lines stay empty. Against a live lead the same card grows one line per member, worst first."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <SettingsRouter home={homeCrew} devices={devicesPaired} start="/settings/updates" />
          </PhoneFrameCard>
        </Card>
      </Group>

      <Group title="Spaces">
        <Card
          state="spaces-repo-worktrees"
          label="spaces, a repo and its worktrees"
          reach="open a worktree of a repo you already have open as a space. Herdr reports the repo on both, so the list nests the worktree under the checkout showing that repo — no extra call, and nothing to switch on."
          note="`blog` sits outside any repo and stays flat, which is the same row it always was. A worktree whose repo is NOT open would also stay flat: there would be nothing to indent under."
          span={2}
        >
          <PhoneFrameCard height={430}>
            <SpaceOverview
              workspaces={spacesWithWorktrees}
              // No agents: this card is about SHAPE. With a herd attached every row also carries its
              // triage tint, and a wall of "needs you" red says nothing about nesting.
              agents={[]}
              onOpen={() => {}}
              onNewSpace={() => {}}
              open
              onOpenChange={() => {}}
            />
          </PhoneFrameCard>
        </Card>

        <Card
          state="new-space-worktree-tab"
          label="new space, the worktree tab"
          reach="tap + on the spaces list where at least one open space sits in a repo. With no repo open (or a multiplexer that cannot make one) the tab strip is not rendered at all and this is the plain new-space sheet."
          note="The repo picker is here because the sheet is opened from the LIST, where there is no current space to take a repo from. `Or open one that already exists` reads the worktrees of the chosen repo once — it is the only route to a checkout that is not a space."
          span={2}
        >
          <PhoneFrameCard height={560}>
            <NewSpaceSheet
              open
              onClose={() => {}}
              onCreate={() => {}}
              repos={[
                { workspaceId: "w1", repoRoot: "/src/collie", label: "collie" },
                { workspaceId: "w9", repoRoot: "/src/nixcfg", label: "nixcfg" },
              ]}
              onCreateWorktree={() => {}}
              onOpenWorktree={() => {}}
            />
          </PhoneFrameCard>
        </Card>

        <Card
          state="new-space-pick-host"
          label="new space, crew, pick a host"
          reach="tap + on the spaces list of a lead with peers. On a solo collie this row is not rendered at all and the sheet is the one above."
          note="The chip that is marked is where the create lands: the machine the list was already showing, or the lead. `attic`, `cellar` and `garage` keep their chips and their names — a machine that cannot take writes is dimmed and says why, never dropped, because a missing row reads as a machine you do not have."
          span={2}
        >
          <PhoneFrameCard height={560}>
            <CrewProvider servers={rosterFive} ts={homeCrew.ts} pollMs={3_000}>
              <NewSpaceSheet open onClose={() => {}} onCreate={() => {}} scope={{ host: "workshop" }} />
            </CrewProvider>
          </PhoneFrameCard>
        </Card>
      </Group>
    </Section>
  );
}
