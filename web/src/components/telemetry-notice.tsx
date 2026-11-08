import { useEffect, useState } from "react";
import { BarChart3 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { Notice, NOTICE_ACTION } from "@/components/ui/notice";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { fetchTelemetry } from "@/lib/api";
import { t } from "@/lib/i18n";
import { telemetrySettingsPath } from "@/lib/nav";
import { useScope } from "@/lib/session";
import { shouldShowTelemetryNotice, spendTelemetryNotice, useTelemetryNoticeKind } from "@/lib/telemetry-notice";
import type { TelemetryView } from "@/lib/types";
import { TELEMETRY_DOCS_URL } from "./telemetry-settings-card";

// THE ONE-TIME INSTALL-COUNT NOTICE (M86 spec 02): on the dashboard, a device that has not yet read it
// is told that Collie 1.27.0 sends anonymous telemetry once a day, and where to turn that off.
//
// A SCOPE NOTICE (DESIGN.md §11): `Collapse` around a box `Notice`, so it slides open and shut and the
// list below never jumps. It stands only while the machine says the count is on BY DEFAULT
// (lib/telemetry-notice.ts holds the rule), and it reads that with one best-effort GET: a failed read
// draws nothing, because a notice that guesses is worse than none. A device that spent it asks nothing.
//
// TWO NOTICES, ONE BOX (ADR 0134). A device that never read the first one gets the 1.27.0 notice and
// its Open Settings button. A device that read only that one gets the update notice once: the same box,
// one button, "What is sent", that opens the docs in a new tab. Either button and the X spend both.
// The Settings card is the permanent second surface, so the X is final.
export function TelemetryNotice() {
  useLocale();
  const nav = useNav();
  const scope = useScope();
  const kind = useTelemetryNoticeKind();
  const spent = kind === "none";
  const [view, setView] = useState<TelemetryView | null>(null);

  useEffect(() => {
    if (spent) return;
    const ac = new AbortController();
    void (async () => {
      try {
        setView(await fetchTelemetry(ac.signal));
      } catch {
        // No read, no notice. Settings still holds the card.
      }
    })();
    return () => ac.abort();
  }, [spent]);

  const open = shouldShowTelemetryNotice({ kind, view });
  const update = kind === "update";

  return (
    <Collapse open={open}>
      {open ? (
        <div className="px-4 pt-3">
          <Notice
            tone="info"
            variant="box"
            announce="status"
            icon={<BarChart3 />}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={NOTICE_ACTION}
                onClick={() => {
                  spendTelemetryNotice();
                  if (update) {
                    window.open(TELEMETRY_DOCS_URL, "_blank", "noopener,noreferrer");
                    return;
                  }
                  nav.down(telemetrySettingsPath(scope));
                }}
              >
                {update ? t("telemetry.notice.docs") : t("telemetry.notice.open")}
              </Button>
            }
            onDismiss={spendTelemetryNotice}
            dismissLabel={t("telemetry.notice.dismiss")}
          >
            {update ? t("telemetry.notice.updateBody") : t("telemetry.notice.body")}
          </Notice>
        </div>
      ) : null}
    </Collapse>
  );
}
