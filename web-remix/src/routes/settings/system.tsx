// Settings → System: what this thing is talking to, and whether it is well. Port of web/'s
// UpdatesSettingsCard, CrewSettingsCard and ConnectionInfo (the paired-devices card is its own file).
import { on, type Handle } from "remix/component";
import { Activity, ChevronRight, CircleArrowUp, Network, Plug } from "lucide";

import { isMultiHost } from "@web/lib/hosts";
import { t } from "@web/lib/i18n";
import { crewPath, machinesPath, updatesPath } from "@web/lib/nav";
import { peersBehind } from "@web/lib/update-crew";
import type { BridgeStatus, DeviceAuth } from "@web/lib/types";

import { serverBuild } from "../../lib/api";
import { address, snapshot } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { useStore } from "../../lib/store";
import { Card } from "../../ui/card";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import { goDown } from "../frame/up";
import { CardHead } from "./parts";
import { loadUpdateCheck, updateCheck } from "./update-check";
import { updatesStatusLine } from "./updates-status";

/**
 * The ONE update row Settings keeps (M16/01): a status line and a chevron into `/settings/updates`.
 * "N peers behind" is not on the snapshot, so the row takes ONE best-effort read of the cached
 * `GET /api/update/check` on mount; a failed read draws nothing about it.
 */
export function UpdatesRow(handle: Handle) {
  const readSnap = useStore(handle, snapshot);
  const readCheck = useStore(handle, updateCheck);
  const where = useStore(handle, address);
  useLocale(handle);
  void loadUpdateCheck(handle.signal).catch(() => false);
  return () => {
    const update = readSnap().data?.update;
    const behind = peersBehind(readCheck().data?.crew ?? [], update?.current ?? "");
    return (
      <Card class="gap-0 py-0" data-testid="updates-row">
        <button
          type="button"
          class="flex w-full items-center gap-3 p-4 text-left active:bg-muted/60"
          mix={on("click", () => goDown(updatesPath(where().scope)))}
        >
          <Icon icon={CircleArrowUp} class="size-5 shrink-0 text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <div class="font-medium">{t("updates.entry.title")}</div>
            <p class="text-sm text-muted-foreground" data-testid="updates-row-status">
              {updatesStatusLine(update, behind)}
            </p>
          </div>
          <Icon icon={ChevronRight} class="size-5 shrink-0 text-muted-foreground" />
        </button>
      </Card>
    );
  };
}

/**
 * The crew's door from Settings, and the machines list's second one. Gated on `multi` like every
 * other piece of host chrome: a solo install grows no row at all. It arrives through `Collapse`,
 * because the roster lands after first paint.
 */
export function CrewCard(handle: Handle) {
  const readSnap = useStore(handle, snapshot);
  const where = useStore(handle, address);
  useLocale(handle);
  return () => {
    const multi = isMultiHost(readSnap().data?.servers);
    return (
      <Collapse open={multi}>
        <Card class="gap-0 py-0" data-testid="crew-card">
          <button
            type="button"
            class="flex w-full items-center gap-3 p-4 text-left active:bg-muted/60"
            mix={on("click", () => goDown(crewPath(where().scope)))}
          >
            <Icon icon={Network} class="size-5 shrink-0 text-muted-foreground" />
            <div class="min-w-0">
              <div class="font-medium">{t("crew.entry.title")}</div>
              <p class="text-sm text-muted-foreground">{t("crew.entry.description")}</p>
            </div>
          </button>
          <button
            type="button"
            class="flex w-full items-center gap-3 border-t border-border p-4 text-left active:bg-muted/60"
            mix={on("click", () => goDown(machinesPath(where().scope)))}
          >
            <Icon icon={Activity} class="size-5 shrink-0 text-muted-foreground" />
            <div class="min-w-0">
              <div class="font-medium">{t("machines.entry.title")}</div>
              <p class="text-sm text-muted-foreground">{t("machines.entry.description")}</p>
            </div>
          </button>
        </Card>
      </Collapse>
    );
  };
}

interface StatusLine {
  text: string;
  tone: string;
}

function bridgeLabel(bridge: BridgeStatus | undefined): StatusLine {
  if (bridge === "connected") return { text: t("settings.connection.bridge.connected"), tone: "text-status-done" };
  if (bridge === "disconnected") return { text: t("settings.connection.bridge.offline"), tone: "text-status-working" };
  return { text: t("settings.connection.bridge.connecting"), tone: "text-muted-foreground" };
}

/** The deviceAuth matrix on the bridge. "Local" is an authorised request with no device header. */
function deviceLabel(device: DeviceAuth | undefined): StatusLine {
  if (!device || !device.enforced) return { text: t("settings.connection.device.notEnforced"), tone: "text-muted-foreground" };
  if (device.authorized) {
    return {
      text: device.device
        ? t("settings.connection.device.fullAccessNamed", { device: device.device })
        : t("settings.connection.device.fullAccessLocal"),
      tone: "text-status-done",
    };
  }
  return {
    text: device.device ? t("settings.connection.device.readOnlyNamed", { device: device.device }) : t("settings.connection.device.readOnly"),
    tone: "text-status-working",
  };
}

interface RowProps {
  label: string;
  mono?: boolean;
  children?: string;
  tone?: string;
}

/** `mono` marks the two rows whose VALUE is a machine identifier, where a 0/O confusion is a wrong answer. */
function Row(handle: Handle<RowProps>) {
  return () => {
    const { label, mono = false, tone = "", children } = handle.props;
    return (
      <div class="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
        <dt class="shrink-0 text-muted-foreground">{label}</dt>
        <dd class={`min-w-0 truncate text-right text-[13px] ${mono ? "font-mono" : ""} ${tone}`}>{children}</dd>
      </div>
    );
  };
}

/** Read-only diagnostics for "why isn't X working": nothing here is configurable. */
export function ConnectionInfo(handle: Handle) {
  const readSnap = useStore(handle, snapshot);
  const readBuild = useStore(handle, serverBuild);
  useLocale(handle);
  return () => {
    const snap = readSnap().data;
    const bridge = bridgeLabel(snap?.bridge);
    const device = deviceLabel(snap?.device);
    return (
      <Card class="gap-0 py-0" data-testid="connection-info">
        <CardHead icon={Plug} title={t("settings.connection.title")} description={t("settings.connection.description")} />
        <dl class="divide-y divide-border border-t border-border">
          <Row label={t("settings.connection.row.endpoint")} mono>
            {window.location.host}
          </Row>
          <Row label={t("settings.connection.row.secure")}>
            {window.isSecureContext ? t("settings.connection.secure.yes") : t("settings.connection.secure.no")}
          </Row>
          <Row label={t("settings.connection.row.bridge")} tone={bridge.tone}>
            {bridge.text}
          </Row>
          <Row label={t("settings.connection.row.deviceAccess")} tone={device.tone}>
            {device.text}
          </Row>
          {/* Always present, even before the value lands: an em dash is a truthful "not known yet" and the same height. */}
          <Row label={t("settings.connection.row.serverBuild")} mono>
            {readBuild() ?? "—"}
          </Row>
        </dl>
      </Card>
    );
  };
}
