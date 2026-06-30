import type { ReactNode } from "react";
import { Plug } from "lucide-react";

import { Card } from "@/components/ui/card";
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
  const b = bridgeLabel(bridge);
  const d = deviceLabel(device);
  const secure = typeof window !== "undefined" && window.isSecureContext;
  const host = typeof window !== "undefined" ? window.location.host : "—";

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-3 p-4 pb-3">
        <Plug className="size-5 shrink-0 text-muted-foreground" />
        <div>
          <div className="font-medium">Connection</div>
          <p className="text-sm text-muted-foreground">Diagnostics for this device.</p>
        </div>
      </div>
      <dl className="divide-y divide-border/60 border-t border-border/60">
        <Row label="Endpoint">{host}</Row>
        <Row label="Secure context">{secure ? "Yes" : "No (plain HTTP)"}</Row>
        <Row label="Bridge">
          <span className={b.tone}>{b.text}</span>
        </Row>
        <Row label="Device access">
          <span className={d.tone}>{d.text}</span>
        </Row>
        {build && <Row label="Server build">{build}</Row>}
      </dl>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-mono text-[13px]">{children}</dd>
    </div>
  );
}

function bridgeLabel(bridge: BridgeStatus | undefined): { text: string; tone: string } {
  if (bridge === "connected") return { text: "Connected", tone: "text-status-done" };
  if (bridge === "disconnected") return { text: "Herdr offline", tone: "text-status-working" };
  return { text: "Connecting…", tone: "text-muted-foreground" };
}

// Mirrors the deviceAuth matrix on the bridge (see bridge/server.ts). "Local" = an authorised request
// with no device header, i.e. the on-host loopback operator.
function deviceLabel(device: DeviceAuth | undefined): { text: string; tone: string } {
  if (!device || !device.enforced) return { text: "Not enforced", tone: "text-muted-foreground" };
  if (device.authorized) {
    return {
      text: device.device ? `Full access · ${device.device}` : "Full access (local)",
      tone: "text-status-done",
    };
  }
  return {
    text: device.device ? `Read-only · ${device.device}` : "Read-only",
    tone: "text-status-working",
  };
}
