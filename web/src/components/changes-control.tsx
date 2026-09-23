import { GitCompare } from "lucide-react";
import { useEffect, useRef } from "react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { CHANGES_DEPTHS, useDashPrefs } from "@/hooks/use-dash-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t, tn } from "@/lib/i18n";
import { CHANGES_SETTINGS_HASH } from "@/lib/nav";
import { cn } from "@/lib/utils";

// How a pane's Changes view finds repos (ADR 0065). Two per-device choices, sent as query params on
// every Changes request: whether to look for repos INSIDE the pane's folder, and how deep. ZenControl's
// shape: the header row, then a dependent row that is disabled (not hidden) while the switch is off,
// so the stored depth stays visible and untouched.
export function ChangesControl() {
  useLocale();
  const { prefs, setChangesNested, setChangesDepth } = useDashPrefs();
  const nested = prefs.changesNested;
  // The Changes list's "look deeper" link lands here (`changesSettingsPath`), scrolled to the card.
  // Read off the address at mount, so the card needs no router around it (its tests have none).
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (window.location.hash !== `#${CHANGES_SETTINGS_HASH}`) return;
    cardRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    cardRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <Card id={CHANGES_SETTINGS_HASH} ref={cardRef} tabIndex={-1} className="gap-0 py-0 outline-none">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <GitCompare className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.changes.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.changes.description")}</p>
          </div>
        </div>
      </div>

      {/* Both rows hang under the header's TEXT (`pl-12`), for the reason ZenControl's sub-row
          states: they are dependents of the titled row, not peers of it. */}
      <div className="flex items-center justify-between gap-4 border-t border-border py-3 pl-12 pr-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t("settings.changes.nested.label")}</div>
          <p className="text-xs text-muted-foreground">{t("settings.changes.nested.hint")}</p>
        </div>
        <Switch
          checked={nested}
          onCheckedChange={setChangesNested}
          aria-label={t("settings.changes.nested.label")}
        />
      </div>

      <div className="border-t border-border py-3 pl-12 pr-4">
        <div id="changes-depth-label" className={cn("text-sm font-medium", !nested && "text-muted-foreground")}>
          {t("settings.changes.depth.label")}
        </div>
        <p className="text-xs text-muted-foreground">{t("settings.changes.depth.hint")}</p>
        <div role="radiogroup" aria-labelledby="changes-depth-label" className="mt-2 flex gap-1">
          {CHANGES_DEPTHS.map((depth) => {
            const selected = depth === prefs.changesDepth;
            return (
              <button
                key={depth}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!nested}
                onClick={() => setChangesDepth(depth)}
                // The digit is what fits four abreast on a phone; the name says what it counts.
                aria-label={tn("settings.changes.depth.levels", depth)}
                className={cn(
                  // ThemeControl's segmented choice: 44px floor, the weight unconditional so a
                  // selection repaints and never re-lays-out.
                  "flex min-h-11 flex-1 items-center justify-center rounded-md px-2 text-sm font-medium tabular-nums transition-colors disabled:opacity-50",
                  selected ? "bg-primary text-primary-foreground" : "text-muted-foreground active:bg-muted",
                )}
              >
                {depth}
              </button>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
