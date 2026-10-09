// Settings section of the states playground. Split out of app.tsx; see that file's header comment
// for the whole page's rules.

import { LauncherHowSheet } from "@/components/launcher-how-sheet";
import { NoPromptsSheet } from "@/components/no-prompts-sheet";
import { NotifyPrefsCard } from "@/components/notify-prefs-control";
import { SpaceOverview } from "@/components/space-overview";
import {
  devicesPaired,
  devicesUnpaired,
  homeCrew,
  homeSolo,
  spacesWithWorktrees,
  watchedPanes,
} from "../fixtures";
import { NewRouter, SettingsRouter } from "../harness";
import { Card, Group, Section, Stage, type SectionDef } from "../layout";
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
          reach="tap the gear from the dashboard. With no device paired, the bridge answers no read and no write, and the Paired devices card offers the pairing verb instead of a list."
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
          reach="scroll to Notify when in Settings. The fifth row is the cache warning, off by default,
            and the section under it names the panes switched on one at a time from their own sheets —
            which is what makes the global-OR-per-pane rule visible instead of implicit."
          note="The real card with a fixture: the playground answers no API, so the controller's two
            fetches are replaced by handed-in values rather than stubbed."
        >
          <Stage height={420}>
            <div className="p-4">
              <NotifyPrefsCard
                prefs={{ blocked: true, done: false, updates: true, cache: false, machines: true }}
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
          state="new-page"
          label="the New page"
          reach="tap + New on the dashboard, the folder button on the Spaces list, or the empty dashboard's first-agent card. A pane's ⋯ New agent in a worktree opens it with the worktree switch on."
          note="The agents and the commands are the chosen machine's own answer (GET /api/launchers), so this card shows what the bridge behind the playground reports. What cannot run there stays in its list, disabled, with its reason in brackets. Start is pinned to the foot."
          span={2}
        >
          <PhoneFrameCard height={640}>
            <NewRouter home={homeSolo} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="new-page-pick-host"
          label="New page, crew, pick a machine"
          reach="open the New page on a lead with peers. On a solo collie the machine select is not rendered at all."
          note="The select is on the machine the start lands on: the one the list was already showing (?machine=workshop here), or the lead. A machine that cannot take writes stays in the list, disabled, with a word for why in brackets."
          span={2}
        >
          <PhoneFrameCard height={640}>
            <NewRouter home={homeCrew} start="/new?machine=workshop" />
          </PhoneFrameCard>
        </Card>

        <Card
          state="new-page-add"
          label="Add your own, Agent, a recipe"
          reach="on the New page, tap Add your own under the Agent select. It shows when the machine's launchers.toml lets a phone add."
          note="Pick the harness, tap the option chips (one per group), read the line Collie will type, and tap Add. The list below is every row a phone added on that machine, with Rename and Remove, and the operator's own rows locked. The recipes and rows are the chosen machine's own answer, so this card shows what the bridge behind the playground reports."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <NewRouter home={homeSolo} start="/new/add?kind=agent" />
          </PhoneFrameCard>
        </Card>

        <Card
          state="new-page-add-command"
          label="Add your own, Command, a typed line"
          reach="on the New page, switch to Shell and tap Add your own under the Command select. Agent has the same way under Write a command."
          note="A typed line is off until the operator sets [phone] free_text = true; then the card shows one disabled row saying so. Check the line shows every hidden character as its code before Add turns on."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <NewRouter home={homeSolo} start="/new/add?kind=command" />
          </PhoneFrameCard>
        </Card>

        <Card
          state="new-page-add-how"
          label="How adding works, the explainer sheet"
          reach="on the Add your own page, tap How adding works."
          note="The recipe, Write a command and how the operator turns it on, this machine's launchers.toml path with one example row and a Copy button, where phone rows live, and the docs link."
        >
          <Stage height={640}>
            <LauncherHowSheet open onClose={() => {}} file="/home/op/.config/collie/launchers.toml" />
          </Stage>
        </Card>

        <Card
          state="new-page-no-prompts-confirm"
          label="Start without prompts?, the confirm sheet"
          reach="on the New page, tap Start on a launcher with the No prompts badge for the first time on this phone and machine. The dashboard's Launch strip and the switcher's Launch section ask the same question."
          note="Asked once per phone, machine and line. Cancel does nothing; Start remembers the answer and goes on."
        >
          <Stage height={520}>
            <NoPromptsSheet
              ask={{ command: "claude --dangerously-skip-permissions", folder: "~/projects/collie", machine: "workshop" }}
              onStart={() => {}}
              onCancel={() => {}}
            />
          </Stage>
        </Card>
      </Group>
    </Section>
  );
}
