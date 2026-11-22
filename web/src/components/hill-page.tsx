import type { ReactNode } from "react";

import { ExperimentalBadge } from "@/components/experimental-badge";
import { HillArmedNote, useHillSwitchArm, useHillSwitchValue, type HillSwitchValue } from "@/components/hill-switch-arm";
import { Icon } from "@/components/icons/icon";
import { SettingSlot } from "@/components/setting-slot";
import { FeatureTokenChip } from "@/components/token-use-label";
import { AboutGroup, BuiltInLabel, DetailHead, FactGroup, HeadSwitch, SECTION, type FactRow } from "@/components/trick-detail";
import { valueSentence } from "@/components/trick-value";
import { ListGroup } from "@/components/ui/list-group";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

// THE HILL'S DETAILS PAGE (2026-11-22), `settings/tricks/hill`: what a trick's details page is, for the one trick that ships with
// Collie. It is drawn from the same parts as a trick's page (components/trick-detail.tsx: the head, the About group, the fact
// groups), so the two read as one family. There is no "Written by the trick's author" note, no Updates group, no code
// folds and no Remove: the Hill has an author that Collie checks, nothing to update and nothing to take away.
//
// WHAT IT ANSWERS. A person who switched the Hill on and got no message did not know that no agent posts until it is told to.
// So the page says what a Decision is, who can ask (an agent by `collie hill post`, a trick, Collie), when you get a notification
// (only a Decision marked Now, and not under Quiet or Away), and what to do when nothing arrives. The words are the
// catalog's (`settings.hill.*`); a command inside a sentence is a slot (`{command}`) drawn on a chip, as the trick pages do.
//
// The head's switch is the row's switch (components/hill-row.tsx): the same value, the same armed second tap and the same
// warning line, drawn below the switch only while armed (so nothing moves under the thumb; the content below moves down). The page does not depend on the Tricks switch, and it never redirects.

/** Where "Read more in the docs" opens. */
export const HILL_DOCS_URL = "https://colliepwa.dev/docs/hill";

/** The command an agent posts with, and the one that shows whether Collie's skill is installed (read-only). */
export const HILL_POST_COMMAND = "collie hill post";
export const SKILL_STATUS_COMMAND = "collie skill status";

/** The page, every value handed in, so a test and the playground draw the real markup. */
export function HillDetail({ on, disabled, waiting, onToggle }: HillSwitchValue): ReactNode {
  useLocale();
  const arm = useHillSwitchArm({ on, waiting, onToggle });
  const name = t("settings.hill.label");
  const who: FactRow[] = [
    { key: "agent", node: <span data-line="who-agent">{valueSentence("settings.hill.who.agent", { command: HILL_POST_COMMAND })}</span> },
    { key: "trick", node: <span data-line="who-trick">{t("settings.hill.who.trick")}</span> },
    { key: "collie", node: <span data-line="who-collie">{t("settings.hill.who.collie")}</span> },
  ];
  const rings: FactRow[] = [
    { key: "now", node: <span data-line="rings-now">{t("settings.hill.rings.now")}</span> },
    { key: "state", node: <span data-line="rings-state">{t("settings.hill.rings.state")}</span> },
    {
      key: "setting",
      node: <span data-line="rings-setting">{valueSentence("settings.hill.rings.setting", { row: t("settings.notify.decisionNow.label") }, { page: t("settings.page.notifications.title") })}</span>,
    },
  ];
  const quiet: FactRow[] = [
    { key: "choice", node: <span data-line="quiet-choice">{t("settings.hill.quiet.choice")}</span> },
    { key: "tell", node: <span data-line="quiet-tell">{valueSentence("settings.hill.quiet.tell", { agents: "AGENTS.md", claude: "CLAUDE.md" })}</span> },
    { key: "fresh", node: <span data-line="quiet-fresh">{t("settings.hill.quiet.fresh")}</span> },
    { key: "skill", node: <span data-line="quiet-skill">{valueSentence("settings.hill.quiet.skill", { command: SKILL_STATUS_COMMAND })}</span> },
  ];
  const from: FactRow[] = [
    { key: "from", node: <span data-line="from">{t("settings.hill.from")}</span> },
    { key: "experiment", node: <span data-line="experiment">{t("settings.experiment.note")}</span> },
  ];
  return (
    <div data-slot="trick-detail" data-detail-hill="">
      <DetailHead
        glyph={<Icon name="hill" className="size-6" />}
        name={name}
        labels={
          <>
            <BuiltInLabel />
            <ExperimentalBadge />
            <FeatureTokenChip feature="hill" />
          </>
        }
      >
        <SettingSlot ids={["tricks.hill"]}>
          <HeadSwitch name={name} checked={on} disabled={disabled} onFlip={arm.flip} />
          {arm.asks && <HillArmedNote waiting={waiting} className="mt-3" />}
        </SettingSlot>
      </DetailHead>
      <AboutGroup description={undefined} paragraphs={[t("settings.hill.about.1"), t("settings.hill.about.2"), t("settings.hill.about.3")]} note={false} />
      <FactGroup slot="who" label={t("settings.hill.who.title")} rows={who} />
      <FactGroup slot="rings" label={t("settings.hill.rings.title")} rows={rings} />
      <FactGroup slot="quiet" label={t("settings.hill.quiet.title")} rows={quiet} />
      <FactGroup slot="from" label={t("settings.tricks.about.from")} rows={from} />
      <SettingSlot ids={["tricks.hill.docs"]} className={SECTION}>
        <ListGroup>
          <a
            href={HILL_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-slot="hill-docs"
            className="flex min-h-11 min-w-0 items-center gap-2 px-3.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <Icon name="open-external" aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">{t("settings.hill.docs")}</span>
          </a>
        </ListGroup>
      </SettingSlot>
    </div>
  );
}

/** The page with the Hill's own value: the bridge's switch and the open count. */
export function HillDetailControl() {
  return <HillDetail {...useHillSwitchValue()} />;
}
