// Settings → Device: how this phone TREATS you. Port of web/'s HapticsControl, HandsFreeControl,
// ZenControl, ChangesControl and TourControl, in web's order. Nothing here changes a pixel until you
// do something.
import { on, ref, type Handle } from "remix/component";
import { Compass, GitCompare, Maximize2, Mic, Vibrate } from "lucide";

import { t, tn } from "@web/lib/i18n";
import { CHANGES_SETTINGS_HASH, homePath } from "@web/lib/nav";
import { cn } from "@web/lib/utils";
import { CHANGES_DEPTHS } from "@web/hooks/use-dash-prefs";

import { config, address } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { dashPrefs, haptics, setDashPref, zen } from "../../lib/prefs";
import { useStore } from "../../lib/store";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Collapse } from "../../ui/collapse";
import { goUp } from "../frame/up";
import { autoZen, handsFree, resetTour } from "./device-prefs";
import { CardHead, ChoiceBand, SwitchRow, SwitchSlot } from "./parts";
import { Switch } from "../../ui/switch";

/** web/src/lib/haptics.ts `hapticsSupported`: the platform has `vibrate` (Android; iOS has none). */
export function hapticsSupported(): boolean {
  return "vibrate" in navigator;
}

const RECORDING_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"] as const;

/**
 * web/src/lib/stt.ts `sttRecordingSupported`: this browser can record at all. `isSecureContext` is
 * checked explicitly because on an insecure origin `mediaDevices` is absent altogether.
 */
export function sttRecordingSupported(): boolean {
  if (!globalThis.isSecureContext) return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  if (!("MediaRecorder" in globalThis)) return false;
  return RECORDING_MIME_TYPES.some((type) => MediaRecorder.isTypeSupported(type));
}

/** Hidden where there is no vibrate API: a toggle that provably cannot do anything teaches the app lies. */
export function HapticsControl(handle: Handle) {
  const read = useStore(handle, haptics);
  useLocale(handle);
  const supported = hapticsSupported();
  return () => {
    if (!supported) return null;
    return (
      <Card class="gap-0 py-0" data-testid="haptics-card">
        <CardHead icon={Vibrate} title={t("settings.haptics.title")} description={t("settings.haptics.description")}>
          <SwitchSlot>
            <Switch checked={read()} aria-label={t("settings.haptics.title")} onCheckedChange={(next) => haptics.set(next)} />
          </SwitchSlot>
        </CardHead>
      </Card>
    );
  };
}

/** Hidden where no provider is configured or the browser cannot record: the composer's own predicate. */
export function HandsFreeControl(handle: Handle) {
  const cfg = useStore(handle, config);
  const read = useStore(handle, handsFree);
  useLocale(handle);
  const recordable = sttRecordingSupported();
  return () => {
    const stt = cfg().data?.stt;
    if (stt === undefined || !recordable) return null;
    const reason = !stt.available && stt.reason !== undefined ? stt.reason : "";
    return (
      <Card class="gap-0 py-0" data-testid="hands-free-card">
        <CardHead icon={Mic} title={t("settings.handsFree.title")} description={t("settings.handsFree.description")}>
          <SwitchSlot>
            <Switch checked={read()} aria-label={t("settings.handsFree.ariaLabel")} onCheckedChange={(next) => handsFree.set(next)} />
          </SwitchSlot>
        </CardHead>
        <Collapse open={reason !== ""}>
          <p class="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{reason}</p>
        </Collapse>
      </Card>
    );
  };
}

/** AVAILABILITY ONLY: whether the pane's actions sheet offers "Zen mode" at all (default off). */
export function ZenControl(handle: Handle) {
  const readZen = useStore(handle, zen);
  const readAuto = useStore(handle, autoZen);
  useLocale(handle);
  return () => {
    const enabled = readZen();
    return (
      <Card class="gap-0 py-0" data-testid="zen-card">
        <CardHead icon={Maximize2} title={t("settings.zen.title")} description={t("settings.zen.description")}>
          <SwitchSlot>
            <Switch checked={enabled} aria-label={t("settings.zen.title")} onCheckedChange={(next) => zen.set(next)} />
          </SwitchSlot>
        </CardHead>
        {/* Disabled, not hidden, while the header switch is off: the stored choice stays visible. */}
        <SwitchRow
          nested
          dim={!enabled}
          label={t("settings.zen.auto.label")}
          hint={t("settings.zen.auto.hint")}
          checked={readAuto()}
          disabled={!enabled}
          onChange={(next) => autoZen.set(next)}
        />
      </Card>
    );
  };
}

/** How a pane's Changes view finds repos (ADR 0065): nested on or off, and how deep. */
export function ChangesControl(handle: Handle) {
  const read = useStore(handle, dashPrefs);
  useLocale(handle);
  let card: HTMLElement | null = null;
  // The Changes list's "look deeper" link lands here (`changesSettingsPath`), scrolled to the card.
  handle.queueTask(() => {
    if (window.location.hash !== `#${CHANGES_SETTINGS_HASH}`) return;
    card?.scrollIntoView({ block: "start", behavior: "smooth" });
    card?.focus({ preventScroll: true });
  });
  return () => {
    const prefs = read();
    const nested = prefs.changesNested;
    return (
      <Card
        id={CHANGES_SETTINGS_HASH}
        tabIndex={-1}
        data-testid="changes-card"
        class="gap-0 py-0 outline-none"
        mix={ref((node: HTMLDivElement) => {
          card = node;
        })}
      >
        <CardHead icon={GitCompare} title={t("settings.changes.title")} description={t("settings.changes.description")} />
        <SwitchRow
          nested
          label={t("settings.changes.nested.label")}
          hint={t("settings.changes.nested.hint")}
          checked={nested}
          onChange={(next) => setDashPref("changesNested", next)}
        />
        <div class="border-t border-border py-3 pr-4 pl-12">
          <div id="changes-depth-label" class={cn("text-sm font-medium", !nested && "text-muted-foreground")}>
            {t("settings.changes.depth.label")}
          </div>
          <p class="text-xs text-muted-foreground">{t("settings.changes.depth.hint")}</p>
          <ChoiceBand
            class="mt-2"
            label={t("settings.changes.depth.label")}
            disabled={!nested}
            value={prefs.changesDepth}
            options={CHANGES_DEPTHS.map((depth) => ({ value: depth, label: String(depth), aria: tn("settings.changes.depth.levels", depth) }))}
            onChange={(depth) => setDashPref("changesDepth", Number(depth))}
          />
        </div>
      </Card>
    );
  };
}

/** The ONLY way back to a tour that was interrupted: an action, so the row ends in a button. */
export function TourControl(handle: Handle) {
  const where = useStore(handle, address);
  useLocale(handle);
  return () => (
    <Card class="gap-0 py-0" data-testid="tour-card">
      <CardHead icon={Compass} title={t("settings.tour.title")} description={t("settings.tour.description")}>
        <Button
          type="button"
          variant="outline"
          class="min-h-11 shrink-0 px-4"
          mix={on("click", () => {
            resetTour();
            goUp(homePath(where().scope));
          })}
        >
          {t("settings.tour.button")}
        </Button>
      </CardHead>
    </Card>
  );
}
