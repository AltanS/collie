import type { ReactNode } from "react";
import { hasWindow } from "@/lib/env";
import { Plug } from "lucide-react";

import { Card } from "@/components/ui/card";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { usePairing } from "@/lib/pairing";
import type { BridgeStatus, DeviceAuth } from "@/lib/types";

// A small read-only diagnostics panel for Settings: where this client is connected, whether it's a
// secure context (PWA/push need one), the live bridge status, and — when per-device auth is on —
// this device's access level. Reads browser globals (location / isSecureContext); the bridge +
// device come from the polled snapshot (HomeData). Nothing here is configurable; it's for "why
// isn't X working" triage.
export function ConnectionInfo({
  bridge,
  device,
  build,
}: {
  bridge: BridgeStatus | undefined;
  device: DeviceAuth | undefined;
  /** Build id the bridge reports it's serving (from /api/config); omitted while loading/offline. */
  build?: string;
}) {
  useLocale();
  const { token, refused } = usePairing();
  const paired = token !== null && !refused;
  const b = bridgeLabel(bridge, paired);
  // Pairing is always on (ADR 0086), so "is this device paired" is part of its access. No token, or a
  // refusal latched since the last proof, is the answer here: an unpaired phone gets no snapshot, and
  // the header gate's `device` field it would have carried is then absent, not "off".
  const d = deviceLabel(device, paired);
  const secure = hasWindow() && window.isSecureContext;
  const host = hasWindow() ? window.location.host : "—";

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-3 p-4 pb-3">
        <Plug className="size-5 shrink-0 text-muted-foreground" />
        <div>
          <div className="font-medium">{t("settings.connection.title")}</div>
          <p className="text-sm text-muted-foreground">{t("settings.connection.description")}</p>
        </div>
      </div>
      <dl className="divide-y divide-border border-t border-border">
        <Row label={t("settings.connection.row.endpoint")} mono>
          {host}
        </Row>
        <Row label={t("settings.connection.row.secure")}>
          {secure ? t("settings.connection.secure.yes") : t("settings.connection.secure.no")}
        </Row>
        <Row label={t("settings.connection.row.bridge")}>
          <span className={b.tone}>{b.text}</span>
        </Row>
        <Row label={t("settings.connection.row.deviceAccess")}>
          <span className={d.tone}>{d.text}</span>
        </Row>
        {/* Always present, even before the value lands: appearing late grew this card and moved
            everything under it. An em dash is a truthful "not known yet" and the same height. */}
        <Row label={t("settings.connection.row.serverBuild")} mono>
          {build ?? "—"}
        </Row>
      </dl>
    </Card>
  );
}

/** `mono` is not decoration: it marks the two rows whose VALUE is a machine identifier — a
 *  host:port and a build id — where the reader compares characters and a 0/O or 1/l confusion is a
 *  wrong answer. The other three rows say "Yes", "Connected", "Read-only": those are the app's own
 *  words about itself, so they wear the app's face like every other label in Settings (F-D2). This
 *  card used to set `font-mono` on every `dd`, which put four words of chrome in the terminal
 *  stack for no reason but the look of a diagnostics table. */
function Row({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 truncate text-right text-[13px] ${mono ? "font-mono" : ""}`}>
        {children}
      </dd>
    </div>
  );
}

/** A one-line status with the colour class that carries its meaning. */
interface StatusLine {
  text: string;
  tone: string;
}

// "Connecting…" is only for a phone that has had no answer of any kind. An unpaired phone, or one the
// bridge refused, is shown the app by that same bridge but gets no snapshot, so `bridge` stays
// undefined for it forever: the bridge is reachable, it is the pairing that is missing.
function bridgeLabel(bridge: BridgeStatus | undefined, paired: boolean): StatusLine {
  if (bridge === "connected") {
    return { text: t("settings.connection.bridge.connected"), tone: "text-status-done" };
  }
  if (bridge === "disconnected") {
    return { text: t("settings.connection.bridge.offline"), tone: "text-status-working" };
  }
  if (!paired) {
    return { text: t("settings.connection.bridge.notPaired"), tone: "text-status-working" };
  }
  return { text: t("settings.connection.bridge.connecting"), tone: "text-muted-foreground" };
}

// Mirrors the deviceAuth matrix on the bridge (see bridge/server.ts). "Local" = an authorised request
// with no device header, i.e. the on-host loopback operator. Pairing comes first: it is always
// enforced, and an unpaired device has no other access to describe. With the proxy's header gate off
// (or not yet known), a paired device's access is its pairing.
function deviceLabel(device: DeviceAuth | undefined, paired: boolean): StatusLine {
  if (!paired) {
    return { text: t("settings.connection.device.notPaired"), tone: "text-status-working" };
  }
  if (!device || !device.enforced) {
    return { text: t("settings.connection.device.paired"), tone: "text-status-done" };
  }
  if (device.authorized) {
    return {
      text: device.device
        ? t("settings.connection.device.fullAccessNamed", { device: device.device })
        : t("settings.connection.device.fullAccessLocal"),
      tone: "text-status-done",
    };
  }
  return {
    text: device.device
      ? t("settings.connection.device.readOnlyNamed", { device: device.device })
      : t("settings.connection.device.readOnly"),
    tone: "text-status-working",
  };
}
