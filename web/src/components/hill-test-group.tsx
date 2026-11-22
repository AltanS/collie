import { Button } from "@/components/ui/button";
import { ListGroup } from "@/components/ui/list-group";
import { SectionLabel } from "@/components/ui/section-label";
import { SettingSlot } from "@/components/setting-slot";
import { SECTION } from "@/components/trick-detail";
import { useLocale } from "@/hooks/use-locale";
import type { HillTestControl, HillTestResult } from "@/hooks/use-hill-test";
import { t, type MessageKey } from "@/lib/i18n";

// "TRY IT" ON THE HILL'S PAGE (2026-11-22): the group between "If nothing arrives" and "Where it comes from". One line says
// what the button does, the button sends a test Decision, and under it one result sentence stays in a slot whose height is
// reserved, so the page does not jump when it fills. The sentences are whole, one catalog key each; the reason a
// notification would not be sent is the bridge's code (bridge/hill/push.ts `HillRingBlock`), and a code this app does not
// know (a newer bridge) reads as "may not be sent". While the Hill is off the slot says so and the button is disabled.

/** The sentence's key for a reason code from the bridge; a code this app does not know (a newer bridge) reads as "may not be sent". */
function silentKey(code: string): MessageKey {
  switch (code) {
    case "push_off":
      return "settings.hill.test.silent.push_off";
    case "no_devices":
      return "settings.hill.test.silent.no_devices";
    case "pref_off":
      return "settings.hill.test.silent.pref_off";
    case "snoozed":
      return "settings.hill.test.silent.snoozed";
    case "crew_member":
      return "settings.hill.test.silent.crew_member";
    case "quiet":
      return "settings.hill.test.silent.quiet";
    case "away":
      return "settings.hill.test.silent.away";
    case "rate":
      return "settings.hill.test.silent.rate";
    default:
      return "settings.hill.test.silent.other";
  }
}

/** The sentence under the button for one outcome. */
export function hillTestSentence(on: boolean, result: HillTestResult | null): string {
  if (!on) return t("settings.hill.test.off");
  if (result === null) return "";
  if (result.kind === "failed") return t("settings.hill.test.failed");
  const seconds = String(result.seconds);
  if (result.rings === null) return t("settings.hill.test.sent", { seconds });
  return t(silentKey(result.rings), { seconds });
}

export interface HillTestGroupProps {
  /** The Hill's switch is on. */
  readonly on: boolean;
  /** This device may not write. */
  readonly disabled: boolean;
  readonly test: HillTestControl;
}

export function HillTestGroup({ on, disabled, test }: HillTestGroupProps) {
  useLocale();
  const sentence = hillTestSentence(on, test.result);
  return (
    <SettingSlot ids={["tricks.hill.test"]} className={SECTION}>
      <section data-section="test">
        <SectionLabel className="mb-2 block">{t("settings.hill.test.title")}</SectionLabel>
        <ListGroup>
          <div className="flex flex-col gap-3 px-3.5 py-3">
            <p data-line="test-line" className="text-sm break-words">
              {t("settings.hill.test.line")}
            </p>
            <Button type="button" variant="outline" data-slot="hill-test-send" className="h-11 w-full" disabled={!on || disabled || test.busy} aria-busy={test.busy || undefined} onClick={() => void test.send()}>
              {t("settings.hill.test.button")}
            </Button>
            {/* The slot keeps three lines of height (the longest sentences take three at 360 px) before and after the sentence, so the page below does not move. */}
            <p data-line="test-result" aria-live="polite" className="min-h-12 text-xs break-words text-muted-foreground">
              {sentence}
            </p>
          </div>
        </ListGroup>
      </section>
    </SettingSlot>
  );
}
