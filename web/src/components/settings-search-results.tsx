import { useEffect, type ReactNode } from "react";

import { useCrew } from "@/components/crew-provider";
import { Icon } from "@/components/icons/icon";
import { usePushAvailability } from "@/components/push-control";
import { FOCUS_RING_INSET, HOVER_FILL } from "@/components/ui/button";
import { useUpdatesStatus } from "@/components/updates-settings-card";
import { useLocale } from "@/hooks/use-locale";
import { useAccounts } from "@/lib/accounts";
import { hapticsSupported } from "@/lib/haptics";
import { useHardwareKeyboardSeen } from "@/lib/hardware-keyboard";
import { t } from "@/lib/i18n";
import { useInstallOffer } from "@/lib/install";
import { useOptionalRootData } from "@/lib/route-data";
import { CONDITION_LINE, searchSettings, settingPath, type Condition, type SettingHit } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useZenEnabled } from "@/lib/zen";

// THE RESULTS OF THE SETTINGS SEARCH (ADR 0170), a chunk of its own: they read the registry
// (lib/settings/registry.ts), which no page needs to draw itself, so the registry loads on the first word typed and
// not with the app. components/settings-search.tsx owns the field and draws this in place of the list.

/** Which state conditions hold on this screen: true or false where the app knows, absent or undefined where it does not. */
interface ConditionsHere {
  readonly get: (condition: Condition) => boolean | undefined;
}

function useConditions(): ConditionsHere {
  const root = useOptionalRootData();
  const crew = useCrew();
  const push = usePushAvailability();
  const keyboard = useHardwareKeyboardSeen();
  const install = useInstallOffer();
  const accounts = useAccounts();
  const zen = useZenEnabled();
  const updates = useUpdatesStatus();
  const known = new Map<Condition, boolean | undefined>([
    ["can-vibrate", hapticsSupported()],
    ["keyboard-seen", keyboard],
    ["install-offered", install],
    ["accounts-offered", accounts.status === "loading" || accounts.status === "failed" ? undefined : accounts.status === "ready"],
    ["crew", crew.multi],
    ["push-server", push === undefined ? undefined : push !== "server-off"],
    ["tricks-on", root === undefined ? undefined : root.tricksOff !== true],
    ["zen-on", zen],
    ["update-waiting", updates.available],
  ]);
  return { get: (condition) => known.get(condition) };
}

function Marked({ text, ranges }: { text: string; ranges: SettingHit["ranges"] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={start} className="bg-transparent font-semibold text-foreground">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/** The results under the field: one row per hit, label first, then where it is. */
export default function SettingsSearchResults({
  query,
  onOpen,
  onFirstPath,
  compact,
}: {
  query: string;
  onOpen: (path: string) => void;
  /** The path Enter opens: the first result's, or null when that one has no link. */
  onFirstPath: (path: string | null) => void;
  compact: boolean;
}) {
  useLocale();
  const conditions = useConditions();
  const hits = searchSettings(query);
  const top = hits[0];
  const topWhen = top?.setting.when;
  const first = top === undefined || (topWhen !== undefined && conditions.get(topWhen) === false) ? null : settingPath(top.setting);
  useEffect(() => onFirstPath(first), [first, onFirstPath]);
  if (hits.length === 0) {
    return (
      <p role="status" data-slot="settings-search-none" className="px-3 py-2 text-sm text-muted-foreground">
        {t("settings.search.none")}
      </p>
    );
  }
  return (
    <ul aria-label={t("settings.search.results")} data-slot="settings-search-results" className={cn("flex flex-col", compact ? "gap-0.5" : "divide-y divide-border")}>
      {hits.map((hit) => {
        const when = hit.setting.when;
        const blocked = when !== undefined && conditions.get(when) === false;
        const path = blocked ? null : settingPath(hit.setting);
        const where = hit.group === "" ? hit.page : `${hit.page} · ${hit.group}`;
        const body = (
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">
              <Marked text={hit.label} ranges={hit.ranges} />
            </span>
            <span className="block text-xs text-muted-foreground">{where}</span>
            {blocked && when !== undefined && <span className="block text-xs text-muted-foreground">{t(CONDITION_LINE[when])}</span>}
          </span>
        );
        const row = cn("flex min-h-11 w-full items-center gap-3 text-left", compact ? "rounded-lg px-2 py-1.5" : "px-4 py-2.5");
        return (
          <li key={hit.setting.id} data-setting-hit={hit.setting.id}>
            {path === null ? (
              <div className={row}>{body}</div>
            ) : (
              <button type="button" className={cn(row, HOVER_FILL, FOCUS_RING_INSET, "active:bg-muted/60")} onClick={() => onOpen(path)}>
                {body}
                <Icon name="row-go" aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
